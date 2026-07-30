import { getChat } from '../store/chats.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type EditDraftInput = { chatJid: string; text: string };

/**
 * Tool-permitted deliberately: PL-U3 did not close this door, because making a
 * draft shorter is a capability the owner asked for. What PL-U3 added is that
 * an edit here is recorded as `text_source: 'agent'`, and an unreviewed change
 * invalidates a prior review — see the `base_hash` contract in
 * `approve-draft.ts`. The mutation is allowed; passing it off as reviewed is
 * not.
 */
export const editDraftAction: ActionDefinition<EditDraftInput> = {
	name: 'edit-draft',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			text: { type: 'string' }
		},
		required: ['chatJid', 'text'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { chatJid?: unknown; text?: unknown } | undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid, text }');
		}
		if (typeof body.text !== 'string') {
			return parseError(400, 'Expected { text }');
		}
		return { ok: true, input: { chatJid: body.chatJid, text: body.text } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		const chat = getChat(db, input.chatJid);
		if (!chat) {
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		const existing = getDraft(db, input.chatJid);
		if (!existing) {
			return actionError(404, 'Draft not found');
		}
		if (!['ready', 'stale', 'drafted'].includes(existing.status)) {
			return actionError(409, 'Draft is not editable', { status: existing.status });
		}
		upsertDraft(db, {
			...existing,
			text: input.text,
			text_source: ctx.caller === 'tool' ? 'agent' : 'owner'
		});
		const draft = getDraft(db, input.chatJid)!;
		events.emit({ type: 'draft-updated', draft });
		return actionJson(200, draft);
	}
};
