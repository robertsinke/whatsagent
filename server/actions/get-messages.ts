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
 * PL-U7 — read one chat's messages in chronological order, paged backward.
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
			}
		},
		required: ['chatJid'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as
			| { chatJid?: unknown; limit?: unknown; beforeTs?: unknown; beforeId?: unknown }
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
		return {
			ok: true,
			input: {
				chatJid: body.chatJid,
				limit,
				...(typeof body.beforeTs === 'number' && Number.isFinite(body.beforeTs)
					? { beforeTs: body.beforeTs }
					: {}),
				...(typeof body.beforeId === 'string' && body.beforeId ? { beforeId: body.beforeId } : {})
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
			...(input.beforeId !== undefined ? { beforeId: input.beforeId } : {})
		});
		// `listMessagesPage` returns newest-FIRST (`ORDER BY ts DESC`). Reverse
		// into chronological order here so both surfaces agree: a tool reads the
		// array as prose (backwards = misread), and the SPA's GET shim (PANEL-S12)
		// returns the same body the tool sees — the client still normalizes via
		// `mergeMessages`, which re-sorts. Ordering only, not content.
		const items = rows.map((message) => toMessageView(db, message)).reverse();
		const oldest = items[0];
		return actionJson(200, {
			chat_jid: input.chatJid,
			items,
			limit: input.limit,
			// The cursor to pass back for the previous page. Named after what it is
			// for so the agent does not have to work out which end of the array to
			// read it off.
			next_before_ts: oldest?.ts ?? null,
			next_before_id: oldest?.id ?? null,
			// A full page is the only signal that older messages might exist; the
			// store does not report a total and counting one would be a second query
			// on every call.
			has_more: items.length === input.limit
		});
	}
};
