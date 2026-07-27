import { getChat, setChatAgentState, type Chat } from '../store/chats.js';
import type { AppDatabase } from '../store/db.js';
import {
	deleteDraft,
	getDraft,
	upsertDraft,
	type Draft,
	type DraftInput as DraftRowInput
} from '../store/drafts.js';
import { getLastMessage, listMessagesPage, type Message } from '../store/messages.js';
import {
	ProviderError,
	type DraftInput,
	type DraftProvider,
	type ProviderErrorCode,
	type Turn
} from '../providers/provider.js';
import { classifyNeedsReply } from './classifier.js';
import type { Memory } from './memory/memory.js';

export type AgentDraftHooks = {
	onDraftUpdated?(draft: Draft): void;
	onDraftRemoved?(chatJid: string): void;
	onChatUpdated?(chat: Chat): void;
};

export type DraftAttempt =
	| { kind: 'ready'; draft: Draft }
	| { kind: 'no_reply_needed' }
	| { kind: 'failed'; code: ProviderErrorCode }
	| { kind: 'rate_limited'; retryAfterMs: number }
	| { kind: 'not_needed' }
	| { kind: 'superseded' };

export type DraftChatOptions = {
	db: AppDatabase;
	provider: DraftProvider;
	providerName: string;
	memory: Memory;
	chatJid: string;
	/**
	 * W4-U15 — the owner pressed "Generate draft". Bypasses every needs-reply
	 * condition (outbound-last, muted, archived, skipped, quiet) because the owner
	 * asking *is* the authority. Never bypasses R8: groups are still refused here,
	 * structurally, and not only at the route.
	 */
	ownerRequested?: boolean;
	conversationLimit?: number;
	now?: () => number;
	hooks?: AgentDraftHooks;
};

function messageContent(message: Message): string {
	return message.text?.trim() || `[${message.type} message]`;
}

export function conversationFor(db: AppDatabase, chatJid: string, limit: number): Turn[] {
	return listMessagesPage(db, chatJid, { limit })
		.reverse()
		.map((message) => ({
			role: message.from_me ? ('assistant' as const) : ('user' as const),
			content: messageContent(message)
		}));
}

const MAX_STYLE_CHARS = 8_000;

async function buildDraftInput(
	db: AppDatabase,
	memory: Memory,
	chat: Chat,
	conversationLimit: number,
	ownerRequested = false
): Promise<DraftInput> {
	let style: string | null = null;
	try {
		style = await memory.recallStyleFor(chat);
	} catch {
		// Optional memory must never make the core drafting loop unavailable.
	}

	// D4: a hard ceiling here as well as inside the memory, so no Memory implementation
	// can push two markdown voice documents past the conversation they are meant to serve.
	const styleInstruction = style
		? `\nOwner voice and style context:\n${style.slice(0, MAX_STYLE_CHARS)}`
		: '';
	return {
		system:
			'Draft a natural reply as the owner. Match the language used in this conversation. ' +
			'Use the owner voice, stay concise, and return no_reply_needed when no response is warranted.' +
			// The owner-requested path is entered precisely when automatic classification
			// declined, most often because the owner spoke last. Without this the base
			// instruction above invites no_reply_needed on exactly the runs the owner
			// asked for, so say plainly that a message is wanted.
			(ownerRequested
				? ' The owner has explicitly asked for a draft in this conversation, so a reply is wanted:' +
					' write the next message the owner would send, even if the owner sent the most recent' +
					' message (in that case write a natural follow-up). Do not return no_reply_needed.'
				: '') +
			styleInstruction,
		conversation: conversationFor(db, chat.jid, conversationLimit)
	};
}

/**
 * Basis selection for an owner-requested run. There may be no trailing inbound at
 * all, so the last message in the chat — in either direction — is the basis. The
 * chat still has to contain something to reply to.
 */
function ownerRequestedCandidate(
	db: AppDatabase,
	chat: Chat
): { chat: Chat; lastInbound: Message } | undefined {
	const lastMessage = getLastMessage(db, chat.jid);
	if (!lastMessage) return undefined;
	return { chat, lastInbound: lastMessage };
}

function emitChat(options: DraftChatOptions): void {
	const chat = getChat(options.db, options.chatJid);
	if (chat) options.hooks?.onChatUpdated?.(chat);
}

/**
 * `error_code` is optional and defaults to null on every write, so any non-failed
 * transition (including a retry) clears a stale code rather than carrying it.
 */
function persistDraft(options: DraftChatOptions, input: Omit<DraftRowInput, 'chat_jid'>): Draft {
	upsertDraft(options.db, { chat_jid: options.chatJid, ...input });
	const draft = getDraft(options.db, options.chatJid)!;
	options.hooks?.onDraftUpdated?.(draft);
	return draft;
}

function markSuperseded(options: DraftChatOptions): DraftAttempt {
	const draft = getDraft(options.db, options.chatJid);
	if (draft?.status === 'drafting') {
		upsertDraft(options.db, { ...draft, status: 'stale' });
		options.hooks?.onDraftUpdated?.(getDraft(options.db, options.chatJid)!);
	}
	setChatAgentState(options.db, options.chatJid, null);
	emitChat(options);
	return { kind: 'superseded' };
}

/** One provider attempt. The provider owns its single bounded internal retry. */
export async function draftChat(options: DraftChatOptions): Promise<DraftAttempt> {
	const chat = getChat(options.db, options.chatJid);
	if (!chat) return { kind: 'not_needed' };
	// R8 is enforced here, not only by classifyNeedsReply — the owner-requested
	// path deliberately skips the classifier, so the group exclusion has to be
	// restated on the branch that bypasses it.
	if (options.ownerRequested && chat.kind !== '1:1') return { kind: 'not_needed' };
	const candidate = options.ownerRequested
		? ownerRequestedCandidate(options.db, chat)
		: classifyNeedsReply(options.db, chat);
	if (!candidate) return { kind: 'not_needed' };
	// An owner-requested basis is often outbound, so the direction clause that
	// guards the automatic path would supersede the run before the provider is
	// ever called. Identity of the basis message is the whole check here — which
	// is what R-draft-basis needs: newer inbound still invalidates the draft.
	const isCurrentBasis = (message: Message | undefined): boolean =>
		Boolean(
			message &&
				message.id === candidate.lastInbound.id &&
				(options.ownerRequested || !message.from_me)
		);

	const now = options.now ?? Date.now;
	const prior = getDraft(options.db, options.chatJid);
	persistDraft(options, {
		text: prior?.status === 'ready' ? prior.text : '',
		status: 'drafting',
		generated_at: now(),
		provider: options.providerName,
		basis_msg_id: candidate.lastInbound.id
	});
	setChatAgentState(options.db, options.chatJid, 'drafting');
	emitChat(options);

	try {
		const input = await buildDraftInput(
			options.db,
			options.memory,
			chat,
			options.conversationLimit ?? 50,
			options.ownerRequested
		);
		const beforeCall = getLastMessage(options.db, options.chatJid);
		if (!isCurrentBasis(beforeCall)) {
			return markSuperseded(options);
		}
		const result = await options.provider.draft(input);
		const currentLast = getLastMessage(options.db, options.chatJid);
		if (!isCurrentBasis(currentLast)) {
			return markSuperseded(options);
		}

		if (result.kind === 'no_reply_needed') {
			deleteDraft(options.db, options.chatJid);
			options.hooks?.onDraftRemoved?.(options.chatJid);
			// 'quiet' is the agent's own verdict, distinct from an owner 'skip' — the
			// UI must not present them alike. Both demote out of needs-reply, and
			// onMessage clears either for a later inbound.
			//
			// An owner-requested run is exempt: demoting the chat *because* the owner
			// asked for help would silently penalise the request, and the owner can
			// always press Generate again. The state is cleared instead.
			setChatAgentState(options.db, options.chatJid, options.ownerRequested ? null : 'quiet');
			emitChat(options);
			return { kind: 'no_reply_needed' };
		}

		const draft = persistDraft(options, {
			text: result.text,
			status: 'ready',
			generated_at: now(),
			provider: options.providerName,
			basis_msg_id: candidate.lastInbound.id
		});
		setChatAgentState(options.db, options.chatJid, 'needs_reply');
		emitChat(options);
		return { kind: 'ready', draft };
	} catch (error) {
		const currentLast = getLastMessage(options.db, options.chatJid);
		if (!isCurrentBasis(currentLast)) {
			return markSuperseded(options);
		}
		const providerError =
			error instanceof ProviderError
				? error
				: new ProviderError('unavailable', 'Draft provider failed unexpectedly', false, undefined, {
						cause: error
					});

		if (providerError.code === 'rate_limit') {
			deleteDraft(options.db, options.chatJid);
			options.hooks?.onDraftRemoved?.(options.chatJid);
			setChatAgentState(options.db, options.chatJid, 'needs_reply');
			emitChat(options);
			return { kind: 'rate_limited', retryAfterMs: providerError.retryAfterMs ?? 1_000 };
		}

		// D3: the typed code lives in its own column. `text` keeps the last good
		// draft body if there was one, so a retry failure doesn't destroy it.
		persistDraft(options, {
			text: prior?.status === 'ready' ? prior.text : '',
			status: 'failed',
			generated_at: now(),
			provider: options.providerName,
			basis_msg_id: candidate.lastInbound.id,
			error_code: providerError.code
		});
		setChatAgentState(options.db, options.chatJid, 'failed');
		emitChat(options);
		return { kind: 'failed', code: providerError.code };
	}
}
