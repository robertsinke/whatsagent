import { getChat } from '../store/chats.js';
import { listMessagesPage } from '../store/messages.js';
import { toMessageView } from '../api/message-view.js';
import { clampCount } from './list-chats.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type GetMessagesInput = {
	chatJid: string;
	limit: number;
	beforeTs?: number;
	beforeId?: string;
	afterTs?: number;
	afterId?: string;
};

/**
 * Deliberately tighter than the store's own `[1, 200]` clamp. The SPA page
 * size is 60 (`PAGE_SIZE` in `state.svelte.ts`); the hard cap matches that so
 * the UI's `loadOlder` / open-chat window can round-trip through this action
 * without silently shrinking. The *default* stays 25 — enough for a tool to
 * answer "what did they say?" without a context bomb; anything more is an
 * explicit paged decision (and conversation text leaving the machine).
 */
const DEFAULT_LIMIT = 25;
/** Must stay ≥ the SPA's `PAGE_SIZE` (60) or frontend paging shrinks. */
const MAX_LIMIT = 60;

/**
 * PL-U7 — read one chat's messages in chronological order, paged backward
 * or incrementally after a high-water mark.
 *
 * READ-ONLY IN FACT. Reuses `listMessagesPage` + `toMessageView`, the exact
 * pair behind `GET /api/chats/:jid/messages`, so the agent sees the shape the
 * UI sees — including the resolved quote and reaction views, and `media` as
 * *description* only. It never advances the read cursor and it never downloads
 * media bytes: `media.cached` reports whether bytes already exist locally, and
 * fetching them is `load-media`, a separate declared action with its own
 * network side effect.
 *
 * PRIVACY — the sharpest instance of it in the read surface. This returns real
 * message text, so calling it sends a slice of a private conversation to
 * whichever model the harness runs. That is already true of drafting, which
 * ships the last fifty messages of a chat to the same provider; what is new is
 * that here the *breadth* is chosen at request time rather than fixed by the
 * pipeline. Hence a lower cap than the UI's and no "all messages" mode.
 *
 * `focusMsgId` is deliberately NOT exposed. It exists for the UI's
 * jump-to-quote and would only let an agent centre a page on a message it
 * already has the id of — no capability the backward cursor lacks, one more
 * paging mode to reason about.
 */
export const getMessagesAction: ActionDefinition<GetMessagesInput> = {
	name: 'get-messages',
	description:
		'Read messages for chatJid (WhatsApp JID like alice@s.whatsapp.net); default 25 (max 60), page older with beforeTs/beforeId or incrementally with afterTs/afterId.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			limit: { type: 'number', description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}` },
			beforeTs: {
				type: 'number',
				description: 'Page backward: return messages older than this timestamp.'
			},
			beforeId: {
				type: 'string',
				description: 'Tie-breaker for beforeTs when several messages share a timestamp.'
			},
			afterTs: {
				type: 'number',
				description: 'Return messages newer than this timestamp.'
			},
			afterId: {
				type: 'string',
				description: 'Tie-breaker for afterTs when several messages share a timestamp.'
			}
		},
		required: ['chatJid'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as
			| {
					chatJid?: unknown;
					limit?: unknown;
					beforeTs?: unknown;
					beforeId?: unknown;
					afterTs?: unknown;
					afterId?: unknown;
				}
			| undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid }');
		}
		const limit = clampCount(body.limit, DEFAULT_LIMIT, MAX_LIMIT);
		if (limit === null) return parseError(400, `Expected limit to be 1-${MAX_LIMIT}`);
		if (body.beforeTs !== undefined && typeof body.beforeTs !== 'number') {
			return parseError(400, 'Expected beforeTs to be a number');
		}
		if (body.beforeId !== undefined && typeof body.beforeId !== 'string') {
			return parseError(400, 'Expected beforeId to be a string');
		}
		if (body.afterTs !== undefined && typeof body.afterTs !== 'number') {
			return parseError(400, 'Expected afterTs to be a number');
		}
		if (body.afterId !== undefined && typeof body.afterId !== 'string') {
			return parseError(400, 'Expected afterId to be a string');
		}
		if (body.afterTs !== undefined && !Number.isFinite(body.afterTs)) {
			return parseError(400, 'Expected afterTs to be finite');
		}
		if (body.afterId && body.afterTs === undefined) {
			return parseError(400, 'afterId requires afterTs');
		}
		if (body.beforeTs !== undefined && body.afterTs !== undefined) {
			return parseError(400, 'beforeTs and afterTs are mutually exclusive');
		}
		return {
			ok: true,
			input: {
				chatJid: body.chatJid,
				limit,
				...(typeof body.beforeTs === 'number' && Number.isFinite(body.beforeTs)
					? { beforeTs: body.beforeTs }
					: {}),
				...(typeof body.beforeId === 'string' && body.beforeId ? { beforeId: body.beforeId } : {}),
				...(typeof body.afterTs === 'number' && Number.isFinite(body.afterTs)
					? { afterTs: body.afterTs }
					: {}),
				...(typeof body.afterId === 'string' && body.afterId ? { afterId: body.afterId } : {})
			}
		};
	},
	run(input, ctx) {
		const { db } = ctx.deps;
		if (!getChat(db, input.chatJid)) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		const rows = listMessagesPage(db, input.chatJid, {
			limit: input.limit,
			...(input.beforeTs !== undefined ? { beforeTs: input.beforeTs } : {}),
			...(input.beforeId !== undefined ? { beforeId: input.beforeId } : {}),
			...(input.afterTs !== undefined ? { afterTs: input.afterTs } : {}),
			...(input.afterId !== undefined ? { afterId: input.afterId } : {})
		});
		// Backward/default reads arrive newest-first from the store; incremental
		// after-cursor reads are already chronological.
		const incremental = input.afterTs !== undefined;
		const items = rows.map((message) => toMessageView(db, message));
		const orderedItems = incremental ? items : items.reverse();
		const oldest = orderedItems[0];
		const newest = orderedItems.at(-1);
		return actionJson(200, {
			chat_jid: input.chatJid,
			items: orderedItems,
			limit: input.limit,
			// Cursors are named after the direction they continue so callers do not
			// have to infer which end of the array to read.
			next_before_ts: incremental ? null : oldest?.ts ?? null,
			next_before_id: incremental ? null : oldest?.id ?? null,
			next_after_ts: incremental ? newest?.ts ?? null : null,
			next_after_id: incremental ? newest?.id ?? null : null,
			// A full page is the only signal that older messages might exist; the
			// store does not report a total and counting one would be a second query
			// on every call.
			has_more: items.length === input.limit
		});
	}
};
