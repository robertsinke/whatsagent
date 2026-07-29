/**
 * Dev-only scripted emitter for the PL-A1 agent event channels.
 *
 * Gating: the HTTP route that calls {@link startAgentDemoSequence} is registered
 * only when `process.env.WHATSAGENT_DEV_EVENTS === '1'`. Absent that flag the
 * handler is never mounted and `POST /api/dev/agent-demo` returns 404 — so a
 * production or normal preview build cannot be driven by accident.
 *
 * There is no agent runtime yet; this pushes a fixed sequence of
 * `agent-part-updated` and `client-command` events through the real EventBus so
 * a human (or screenshot harness) can watch the client react.
 */
import type { AgentPart, ClientCommand } from '../../shared/agent-events.js';
import type { EventBus, ServerEvent } from './events.js';

/** Preview fixture chat — seeded by `scripts/ui-preview.ts`. */
export const DEV_DEMO_CHAT_JID = 'preview-direct@s.whatsapp.net';

const SESSION = 'dev-session-1';
const MESSAGE = 'dev-message-1';

function partEvent(part: AgentPart, delta?: string): ServerEvent {
	return delta === undefined
		? { type: 'agent-part-updated', part }
		: { type: 'agent-part-updated', part, delta };
}

function commandEvent(command: ClientCommand): ServerEvent {
	return { type: 'client-command', command };
}

export type AgentDemoOptions = {
	/** Chat the open-chat command targets. Defaults to the preview Quote Gallery. */
	openChatJid?: string;
	/** Delay between scripted steps (ms). */
	stepMs?: number;
};

/**
 * Emit a short agent turn: step-start → tool lifecycle → streamed text →
 * step-finish, then an open-chat command. Returns a cancel function.
 */
export function startAgentDemoSequence(
	bus: EventBus,
	options: AgentDemoOptions = {}
): () => void {
	const openChatJid = options.openChatJid ?? DEV_DEMO_CHAT_JID;
	const stepMs = options.stepMs ?? 400;
	const timers: ReturnType<typeof setTimeout>[] = [];
	let cancelled = false;

	const schedule = (ms: number, event: ServerEvent) => {
		timers.push(
			setTimeout(() => {
				if (!cancelled) bus.emit(event);
			}, ms)
		);
	};

	const textId = 'part-text-1';
	const toolId = 'part-tool-1';

	let t = 0;
	const next = () => {
		t += stepMs;
		return t;
	};

	schedule(next(), partEvent({ kind: 'step-start', sessionId: SESSION, messageId: MESSAGE, partId: 'part-step-1' }));

	schedule(
		next(),
		partEvent({
			kind: 'tool',
			sessionId: SESSION,
			messageId: MESSAGE,
			partId: toolId,
			name: 'open_chat',
			input: { jid: openChatJid },
			state: 'pending'
		})
	);

	schedule(
		next(),
		partEvent({
			kind: 'tool',
			sessionId: SESSION,
			messageId: MESSAGE,
			partId: toolId,
			name: 'open_chat',
			input: { jid: openChatJid },
			state: 'running'
		})
	);

	schedule(
		next(),
		partEvent({
			kind: 'tool',
			sessionId: SESSION,
			messageId: MESSAGE,
			partId: toolId,
			name: 'open_chat',
			input: { jid: openChatJid },
			state: 'complete',
			output: { opened: openChatJid }
		})
	);

	schedule(
		next(),
		partEvent(
			{
				kind: 'text',
				sessionId: SESSION,
				messageId: MESSAGE,
				partId: textId,
				text: 'Opened '
			},
			'Opened '
		)
	);

	schedule(
		next(),
		partEvent(
			{
				kind: 'text',
				sessionId: SESSION,
				messageId: MESSAGE,
				partId: textId,
				text: 'Opened Quote Gallery and drafted a reply.'
			},
			'Quote Gallery and drafted a reply.'
		)
	);

	schedule(
		next(),
		partEvent({ kind: 'step-finish', sessionId: SESSION, messageId: MESSAGE, partId: 'part-step-1-end' })
	);

	// Drive the real shell: open the preview chat via the client-command channel.
	schedule(next(), commandEvent({ type: 'open-chat', jid: openChatJid }));

	return () => {
		cancelled = true;
		for (const timer of timers) clearTimeout(timer);
	};
}

/** True when the process opted into the dev emitter. */
export function isDevAgentEventsEnabled(): boolean {
	return process.env.WHATSAGENT_DEV_EVENTS === '1';
}
