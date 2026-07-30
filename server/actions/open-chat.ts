import { getChat } from '../store/chats.js';
import { chatViewFor } from '../api/chat-view.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type OpenChatInput = { chatJid: string };

/**
 * PANEL-S4/S7 — both callers. Owner principle: user and agent are both
 * first-class, so any action a user can take an agent can take — defined ONCE
 * here, exposed through both the UI and the agent tool surface. This is the
 * single definition of "focus a chat"; it changes UI focus and nothing else.
 *
 * R9 is untouched and stays obviously true from this file alone: `run` emits
 * one event and returns. It does not enqueue an outbox row, it does not call
 * the send transport, it does not touch drafts, and there is deliberately no
 * branch in it that could. The event it emits is a UI-focus event, not a send
 * signal; the outbox pacer does not subscribe to it.
 *
 * The dispatcher's caller policy is the enforcement — `callers: ['frontend',
 * 'tool']` — so `run` does not re-check callers.
 *
 * `markRead` is deliberately false on the client side of this event. Opening a
 * chat by looking at it must not silently clear the unread badge; `mark-read`
 * is already its own explicit action. PANEL-S7 split `AppState.openChat` into
 * load-only (`openChat`) plus an explicit `markRead`, so the owner's chat-list
 * click now dispatches this action (via REST) and then `mark-read` — two
 * registry actions, both available to either caller. The agent dispatches this
 * action alone, never `mark-read`.
 *
 * Groups are allowed. R8 excludes groups from *drafting*, not from the shell;
 * the owner can open a group chat by hand and so may the agent.
 */
export const openChatAction: ActionDefinition<OpenChatInput> = {
	name: 'open-chat',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' }
		},
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
		const { db, events } = ctx.deps;
		const chat = getChat(db, input.chatJid);
		if (!chat) {
			// A typo silently no-op'ing is worse than a 404: the agent would never
			// learn it got the jid wrong. Echo the jid exactly like `get-messages`.
			return actionError(404, 'Chat not found', { jid: input.chatJid });
		}
		// Resolved name through the same path every other event uses, so the
		// agent's confirmation matches what the owner's screen shows.
		const view = chatViewFor(db, chat);
		events.emit({ type: 'focus-chat', jid: chat.jid, name: view.name });
		return actionJson(200, {
			jid: chat.jid,
			name: view.name
		});
	}
};