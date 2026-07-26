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
	/** Exact owner-authored message permitted only for a development test. */
	devDraftFromMeMessageId?: string;
	conversationLimit?: number;
	now?: () => number;
	hooks?: AgentDraftHooks;
};

function messageContent(message: Message): string {
	return message.text?.trim() || `[${message.type} message]`;
}

export function conversationFor(
	db: AppDatabase,
	chatJid: string,
	limit: number,
	devInboundMessageId?: string
): Turn[] {
	return listMessagesPage(db, chatJid, { limit })
		.reverse()
		.map((message) => ({
			role:
				message.from_me && message.id !== devInboundMessageId
					? ('assistant' as const)
					: ('user' as const),
			content: messageContent(message)
		}));
}

async function buildDraftInput(
	db: AppDatabase,
	memory: Memory,
	chat: Chat,
	conversationLimit: number,
	devInboundMessageId?: string
): Promise<DraftInput> {
	let style: string | null = null;
	try {
		style = await memory.recallStyleFor(chat);
	} catch {
		// Optional memory must never make the core drafting loop unavailable.
	}

	const styleInstruction = style
		? `\nOwner voice and style context:\n${style}`
		: '';
	return {
		system:
			'Draft a natural reply as the owner. Match the language used in this conversation. ' +
			'Use the owner voice, stay concise, and return no_reply_needed when no response is warranted.' +
			(devInboundMessageId
				? ' Development test: treat the final owner-authored message as inbound and draft a direct reply to it.'
				: '') +
			styleInstruction,
		conversation: conversationFor(db, chat.jid, conversationLimit, devInboundMessageId)
	};
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
	const candidate = classifyNeedsReply(options.db, chat, {
		devDraftFromMeMessageId: options.devDraftFromMeMessageId
	});
	if (!candidate) return { kind: 'not_needed' };
	const devInboundMessageId =
		candidate.lastInbound.from_me &&
		candidate.lastInbound.id === options.devDraftFromMeMessageId
			? candidate.lastInbound.id
			: undefined;
	const isCurrentBasis = (message: Message | undefined): boolean =>
		Boolean(
			message &&
				message.id === candidate.lastInbound.id &&
				(!message.from_me || message.id === devInboundMessageId)
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
			devInboundMessageId
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
			setChatAgentState(options.db, options.chatJid, 'quiet');
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
