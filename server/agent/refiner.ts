import type { DraftTextSource } from '../../shared/approval-hash.js';
import { getChat } from '../store/chats.js';
import type { AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft, type Draft } from '../store/drafts.js';
import { getLastInboundMessage } from '../store/messages.js';
import {
	buildRefinementInput,
	ProviderError,
	type DraftProvider,
	type ProviderErrorCode,
	type RefinementIntent
} from '../providers/provider.js';
import { conversationFor } from './drafter.js';

const REFINABLE_STATUSES = new Set(['ready', 'stale', 'drafted']);

export type RefineDraftRequest = {
	chatJid: string;
	intent: RefinementIntent;
	preview?: string;
	/**
	 * PL-U3: who asked for this refinement. The provider writes the words either
	 * way, but the owner's question at approval time is *who caused my draft to
	 * change*, and "the agent asked for a shorter version" is a different answer
	 * from "I clicked shorter". Defaults to `system`.
	 */
	requestedBy?: DraftTextSource;
};

export type RefinementAttempt =
	| { kind: 'ready'; draft: Draft }
	| { kind: 'not_found' }
	| { kind: 'not_refinable'; status: string }
	| { kind: 'invalid_preview' }
	| { kind: 'superseded' }
	| { kind: 'failed'; code: ProviderErrorCode };

export type RefineDraftOptions = {
	db: AppDatabase;
	provider: DraftProvider;
	providerName: string;
	conversationLimit?: number;
	now?: () => number;
	onDraftUpdated?: (draft: Draft) => void;
};

function sameDraft(left: Draft | undefined, right: Draft): boolean {
	return Boolean(
		left &&
			left.chat_jid === right.chat_jid &&
			left.text === right.text &&
			left.status === right.status &&
			left.generated_at === right.generated_at &&
			left.provider === right.provider &&
			left.basis_msg_id === right.basis_msg_id &&
			left.error_code === right.error_code &&
			left.original_text === right.original_text
	);
}

/** Refines one preview without changing approval, outbox, chat, or memory state. */
export async function refineDraft(
	options: RefineDraftOptions,
	request: RefineDraftRequest
): Promise<RefinementAttempt> {
	const chat = getChat(options.db, request.chatJid);
	const snapshot = getDraft(options.db, request.chatJid);
	if (!chat || !snapshot) return { kind: 'not_found' };
	if (!REFINABLE_STATUSES.has(snapshot.status)) {
		return { kind: 'not_refinable', status: snapshot.status };
	}

	const preview = request.preview ?? snapshot.text;
	if (!preview.trim()) return { kind: 'invalid_preview' };

	const latestInbound = getLastInboundMessage(options.db, request.chatJid);
	const latestInboundId = latestInbound?.id ?? null;
	const input = buildRefinementInput(
		conversationFor(options.db, request.chatJid, options.conversationLimit ?? 50),
		request.intent,
		preview
	);

	try {
		const result = await options.provider.draft(input);
		if (result.kind !== 'draft' || typeof result.text !== 'string' || !result.text.trim()) {
			throw new ProviderError(
				'invalid_response',
				'Refinement provider returned an invalid draft'
			);
		}

		const persist = options.db.transaction((): Draft | undefined => {
			const current = getDraft(options.db, request.chatJid);
			const currentInboundId = getLastInboundMessage(options.db, request.chatJid)?.id ?? null;
			if (!sameDraft(current, snapshot) || currentInboundId !== latestInboundId) return undefined;

			const basisMsgId =
				request.intent === 'regenerate' ? latestInboundId : snapshot.basis_msg_id;
			upsertDraft(options.db, {
				...snapshot,
				text: result.text,
				status: request.intent === 'regenerate' ? 'ready' : snapshot.status,
				generated_at: (options.now ?? Date.now)(),
				provider: options.providerName,
				basis_msg_id: basisMsgId,
				error_code: null,
				original_text: result.text,
				text_source: request.requestedBy ?? 'system'
			});
			return getDraft(options.db, request.chatJid);
		});
		const draft = persist();
		if (!draft) return { kind: 'superseded' };

		options.onDraftUpdated?.(draft);
		return { kind: 'ready', draft };
	} catch (error) {
		const providerError =
			error instanceof ProviderError
				? error
				: new ProviderError('unavailable', 'Draft provider failed unexpectedly', false, undefined, {
						cause: error
					});
		return { kind: 'failed', code: providerError.code };
	}
}
