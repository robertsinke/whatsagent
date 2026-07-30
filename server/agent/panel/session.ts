import { randomUUID } from 'node:crypto';
import type { AgentPart } from '../../../shared/agent-events.js';
import type { EventBus } from '../../api/events.js';
import { MAX_HISTORY_TURNS, type PanelHarness, type PanelTurnSummary } from './harness.js';
import { PanelTurnError } from './stream-process.js';

/**
 * PL-U7 — one panel conversation, one turn at a time.
 *
 * STATE LIVES ON THIS OBJECT, never at module scope. Tests construct several
 * `createApp()` instances in one process; a module-level "in flight" flag would
 * leak between them and produce 409s in whichever test ran second. The manager
 * is injected through `RoutesDeps` the same way `generateDraft` and `wakeOutbox`
 * are.
 *
 * ONE TURN IN FLIGHT, AND A SECOND IS REFUSED RATHER THAN QUEUED. A queue would
 * mean the owner types twice, sees nothing, and later gets two turns of tool
 * calls against a world that moved in between — including, potentially, two
 * proposals. Refusing is the honest answer and the panel can say so.
 *
 * HOW PARTS REACH THE CLIENT. Straight onto the existing `EventBus` as
 * `agent-part-updated`, the same wire shape `server/api/dev-agent-events.ts`
 * emits — the panel is already proven against that emitter, so the runtime does
 * not introduce a second channel or a second contract.
 */

export type PanelTurnStart = {
	sessionId: string;
	messageId: string;
	harness: string;
};

export type PanelSessionStatus = {
	running: boolean;
	sessionId: string | null;
	messageId: string | null;
	harness: string | null;
};

export type PanelSessionManagerOptions = {
	events: EventBus;
	harness: PanelHarness;
	/** Injected in tests. */
	newId?: () => string;
};

export class PanelTurnInFlightError extends Error {
	constructor(public readonly running: PanelTurnStart) {
		super('A turn is already running');
		this.name = 'PanelTurnInFlightError';
	}
}

export class PanelSessionManager {
	private readonly events: EventBus;
	private readonly harness: PanelHarness;
	private readonly newId: () => string;
	/** Stable across turns so the panel keeps one transcript per app lifetime. */
	private readonly sessionId: string;
	/**
	 * RETENTION IS BOUNDED BY THE RENDER BOUND, deliberately the same constant.
	 * `renderHistory` never looks past the last {@link MAX_HISTORY_TURNS} entries,
	 * so anything older is unreachable — keeping it changed nothing except the
	 * process's memory, which grew by one full prompt plus one full reply per turn
	 * for the lifetime of the app (the clip to `MAX_CHARS_PER_FIELD` happens at
	 * render, not here, so the retained strings are the untruncated ones).
	 *
	 * Sharing the constant rather than picking a second number is the point: a
	 * later change to how much history the model sees moves retention with it, and
	 * this stays a no-op on what any harness is sent.
	 */
	private history: PanelTurnSummary[] = [];
	private current: { start: PanelTurnStart; controller: AbortController } | null = null;

	constructor(options: PanelSessionManagerOptions) {
		this.events = options.events;
		this.harness = options.harness;
		this.newId = options.newId ?? (() => randomUUID());
		this.sessionId = `panel-${this.newId()}`;
	}

	status(): PanelSessionStatus {
		return {
			running: this.current !== null,
			sessionId: this.current?.start.sessionId ?? null,
			messageId: this.current?.start.messageId ?? null,
			harness: this.current?.start.harness ?? null
		};
	}

	/**
	 * Start a turn. Returns as soon as the process is spawning — the parts arrive
	 * over the WebSocket, so the HTTP response is an acknowledgement (202) and
	 * never the transcript. Throws {@link PanelTurnInFlightError} when one is
	 * already running.
	 */
	start(text: string): PanelTurnStart {
		if (this.current) throw new PanelTurnInFlightError(this.current.start);

		const start: PanelTurnStart = {
			sessionId: this.sessionId,
			messageId: `msg-${this.newId()}`,
			harness: this.harness.id
		};
		const controller = new AbortController();
		this.current = { start, controller };
		this.events.emit({ type: 'agent-turn', phase: 'started', ...start });
		void this.drive(text, start, controller);
		return start;
	}

	/** Cancel the running turn, if any. Returns whether there was one. */
	cancel(): boolean {
		if (!this.current) return false;
		this.current.controller.abort();
		return true;
	}

	/** Owner-visible reset: drop the rendered history so the next turn starts cold. */
	clearHistory(): void {
		this.history = [];
	}

	async stop(): Promise<void> {
		this.cancel();
	}

	private async drive(
		text: string,
		start: PanelTurnStart,
		controller: AbortController
	): Promise<void> {
		const turn = {
			sessionId: start.sessionId,
			messageId: start.messageId,
			text,
			history: this.history
		};
		/** Text parts only — what goes into the next turn's rendered history. */
		/** Latest snapshot per text partId — text parts are snapshots, not deltas. */
		const replies = new Map<string, string>();
		let emitted = false;
		let failure: string | undefined;

		try {
			for await (const part of this.harness.run(turn, controller.signal)) {
				emitted = true;
				if (part.kind === 'text') replies.set(part.partId, part.text);
				this.emit(part);
			}
			// A turn that produced nothing renderable is a failure the owner must see
			// — silence in the panel is indistinguishable from a hung process.
			if (!emitted) failure = 'The harness produced no output for this turn.';
		} catch (error) {
			failure = describeTurnError(error);
		} finally {
			if (failure !== undefined) this.emitFailure(start, failure);
			this.history = [
				...this.history,
				{ prompt: text, reply: [...replies.values()].filter(Boolean).join('\n').trim() }
			].slice(-MAX_HISTORY_TURNS);
			// Only clear if this is still the current turn — a cancel followed by a
			// fast new start must not have its state wiped by the old turn unwinding.
			if (this.current?.start.messageId === start.messageId) this.current = null;
			this.events.emit({
				type: 'agent-turn',
				phase: 'finished',
				...start,
				...(failure === undefined ? {} : { reason: failure })
			});
		}
	}

	private emit(part: AgentPart): void {
		this.events.emit({ type: 'agent-part-updated', part });
	}

	/**
	 * Failures are surfaced as a tool part in the error state rather than as a
	 * text part, so the panel's existing error affordance (red icon, error pill)
	 * carries them. A failure rendered as prose would look like the agent talking.
	 */
	private emitFailure(start: PanelTurnStart, message: string): void {
		this.emit({
			kind: 'tool',
			sessionId: start.sessionId,
			messageId: start.messageId,
			partId: `${start.messageId}-failure`,
			name: start.harness,
			input: {},
			state: 'error',
			error: message
		});
		this.emit({
			kind: 'step-finish',
			sessionId: start.sessionId,
			messageId: start.messageId,
			partId: `${start.messageId}-failure-end`
		});
	}
}

export function describeTurnError(error: unknown): string {
	if (error instanceof PanelTurnError) {
		switch (error.code) {
			case 'cancelled':
				return 'Turn cancelled.';
			case 'timeout':
				return 'The harness timed out.';
			case 'spawn_failed':
				return `${error.message}. Is the harness installed and on PATH?`;
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : 'Unknown harness failure';
}
