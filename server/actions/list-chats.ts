import { listChats } from '../store/chats.js';
import { chatNeedsReply, toChatView } from '../api/chat-view.js';
import type { ActionDefinition } from './types.js';
import { actionJson, parseError } from './types.js';

export type ListChatsInput = {
	filter: 'all' | 'needs-reply' | 'groups';
	limit: number;
	offset: number;
};

/**
 * Default and hard ceiling on rows per call. The database holds the owner's
 * whole chat list, and an uncapped read is two problems at once: a context bomb,
 * and a way to push every contact name the owner has into whichever cloud model
 * the harness is running. Paging exists so breadth is a decision the agent has
 * to keep making, not one it makes once.
 */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/**
 * PL-U7 — one of the three read actions. The registry had none: every
 * tool-permitted action was a mutation or had a side effect, so an agent could
 * act but not look.
 *
 * READ-ONLY IN FACT, not just in name. `run` calls the same `toChatView` /
 * `chatNeedsReply` the SPA's `GET /api/chats` calls and returns. It writes no
 * read cursor, downloads no media, and does not touch `agent_state` — a "read"
 * tool that quietly marked things read would corrupt the needs-reply verdict
 * the whole draft pipeline is built on. `mark-read` is a separate, declared
 * mutation for that.
 *
 * PRIVACY, stated plainly because it is real: this sends contact names and the
 * last-message preview of every returned chat to whichever model the harness
 * runs, which for `claude` and the cloud opencode models is a remote service.
 * Drafting already sends conversation text off-machine (`buildPrompt` ships the
 * last fifty messages), so the exposure class is not new — but drafting sends
 * one chat's tail on a debounce, while this is owner-triggerable at arbitrary
 * breadth. That is why it is capped and paged rather than "all of them".
 *
 * GROUPS ARE INCLUDED. R8 excludes the agent from group *classification and
 * drafting*, and `propose-send` refuses a non-1:1 chat outright. Reading is
 * neither: the shell shows groups, the owner can ask about one, and a read that
 * silently hid them would make the agent's view disagree with the owner's
 * screen. The `groups` filter is here so the agent can ask for them on purpose.
 */
export const listChatsAction: ActionDefinition<ListChatsInput> = {
	name: 'list-chats',
	description:
		'List chats with optional filter all|needs-reply|groups; default 30 rows (max 100), page with offset.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			filter: { type: 'string', enum: ['all', 'needs-reply', 'groups'] },
			limit: { type: 'number', description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}` },
			offset: { type: 'number', description: 'Rows to skip, for paging.' }
		},
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { filter?: unknown; limit?: unknown; offset?: unknown } | undefined;
		let filter: ListChatsInput['filter'] = 'all';
		if (body?.filter !== undefined) {
			if (
				body.filter !== 'all' &&
				body.filter !== 'needs-reply' &&
				body.filter !== 'groups'
			) {
				return parseError(400, 'Expected filter to be all | needs-reply | groups');
			}
			filter = body.filter;
		}
		const limit = clampCount(body?.limit, DEFAULT_LIMIT, MAX_LIMIT);
		if (limit === null) return parseError(400, `Expected limit to be 1-${MAX_LIMIT}`);
		const offset = clampOffset(body?.offset);
		if (offset === null) return parseError(400, 'Expected offset to be a non-negative integer');
		return { ok: true, input: { filter, limit, offset } };
	},
	run(input, ctx) {
		const { db } = ctx.deps;
		let items = listChats(db).map((chat) => toChatView(db, chat, (c) => chatNeedsReply(db, c)));
		if (input.filter === 'needs-reply') items = items.filter((c) => c.needs_reply);
		else if (input.filter === 'groups') items = items.filter((c) => c.kind === 'group');

		const total = items.length;
		const page = items.slice(input.offset, input.offset + input.limit);
		return actionJson(200, {
			items: page,
			total,
			offset: input.offset,
			limit: input.limit,
			// Explicit rather than "did I get `limit` rows?" — the agent should not
			// have to infer paging state from a row count.
			has_more: input.offset + page.length < total
		});
	}
};

/** Shared by the read actions: a positive integer within `[1, max]`, or null. */
export function clampCount(value: unknown, fallback: number, max: number): number | null {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
	return Math.min(value, max);
}

export function clampOffset(value: unknown): number | null {
	if (value === undefined || value === null) return 0;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
	return value;
}
