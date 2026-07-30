import { getChat } from '../store/chats.js';
import { chatViewFor } from '../api/chat-view.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type OpenChatInput = { chatJid: string };

/**
 * PANEL-S4 — both callers. Owner principle: user and agent are both
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
 * is already its own explicit action.
 *
 * Groups are allowed. R8 excludes groups from *drafting*, not from the shell;
 * the owner can open a group chat by hand and so may the agent.
 *
 * ENTANGLEMENT NOTE (reported to orchestrator): the chat-list UI click does
 * NOT currently route through this action. It calls `app.openChat(jid)`
 * directly client-side, which marks read by default — that mark-read IS the
 * owner's explicit "I'm reading this now" action, and it is entangled with
 * message loading and the read cursor in `AppState.openChat`. Forcing the UI
 * click through this action would change the owner's click to no longer mark
 * read, which is a behavior change for the owner, not a refactor. So the UI
 * path is left as-is; this action is the single *server* definition, available
 * to both callers, and the agent is the first consumer. A future task that
 * wants the UI click to go through the registry should split "open" (load) from
 * "mark read" (the owner action) first — see the execution report.
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