import { getChat } from '../store/chats.js';
import { getDraft } from '../store/drafts.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type GetDraftInput = { chatJid: string };

/**
 * PL-U7 — read the current draft for a chat, if there is one.
 *
 * READ-ONLY IN FACT: a single `getDraft` and return. In particular it does NOT
 * generate one when none exists. `generate-draft` is the declared action for
 * that, it queues real provider work, and folding it in here would make a read
 * tool spend money and emit `draft-updated` — the sort of hidden side effect
 * this whole read surface exists to avoid.
 *
 * "No draft" is `200 { draft: null }`, not a 404. The REST route this mirrors
 * does return 404, and that is right there — a browser fetch wants to
 * distinguish missing from empty. For a tool caller a 404 arrives as an *error
 * part in the panel*, so an agent checking whether a draft exists would paint a
 * red failure line for a completely normal answer. The status codes differ on
 * purpose; the shape does not.
 *
 * `text_source` is included and matters: it is how PL-U3's pinned-hash story
 * stays honest about who last wrote the text. An agent that reads a draft it
 * itself rewrote sees `agent` there.
 */
export const getDraftAction: ActionDefinition<GetDraftInput> = {
	name: 'get-draft',
	description: 'Return the current draft for chatJid if one exists; does not generate one.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: { chatJid: { type: 'string' } },
		required: ['chatJid'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { chatJid?: unknown } | undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid }');
		}
		return { ok: true, input: { chatJid: body.chatJid } };
	},
	run(input, ctx) {
		const { db } = ctx.deps;
		if (!getChat(db, input.chatJid)) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		return actionJson(200, { chat_jid: input.chatJid, draft: getDraft(db, input.chatJid) ?? null });
	}
};
