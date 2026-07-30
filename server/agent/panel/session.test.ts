import { describe, expect, it, vi } from 'vitest';
import type { AgentPart } from '../../../shared/agent-events.js';
import { EventBus, type ServerEvent } from '../../api/events.js';
import type { PanelHarness, PanelTurn } from './harness.js';
import { PanelSessionManager, PanelTurnInFlightError } from './session.js';
import { PanelTurnError } from './stream-process.js';

function collector(bus: EventBus): ServerEvent[] {
	const seen: ServerEvent[] = [];
	bus.subscribe((event) => seen.push(event));
	return seen;
}

/** A harness whose output and timing the test controls exactly. */
function fakeHarness(
	impl: (turn: PanelTurn, signal: AbortSignal) => AsyncIterable<AgentPart>
): PanelHarness {
	return { id: 'opencode', run: impl };
}

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

function makeManager(harness: PanelHarness) {
	const events = new EventBus();
	const seen = collector(events);
	let n = 0;
	const manager = new PanelSessionManager({ events, harness, newId: () => `id${++n}` });
	return { manager, seen };
}

describe('PanelSessionManager', () => {
	it('emits parts onto the existing EventBus as agent-part-updated', async () => {
		const { manager, seen } = makeManager(
			fakeHarness(async function* (turn) {
				yield { kind: 'step-start', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p1' };
				yield {
					kind: 'text',
					sessionId: turn.sessionId,
					messageId: turn.messageId,
					partId: 'p2',
					text: 'done'
				};
			})
		);
		manager.start('do it');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));

		// The same wire shape the dev emitter used, so the panel needs no changes.
		const parts = seen.filter((e) => e.type === 'agent-part-updated');
		expect(parts).toHaveLength(2);
		expect(seen[0]).toMatchObject({ type: 'agent-turn', phase: 'started', harness: 'opencode' });
		expect(seen.at(-1)).toMatchObject({ type: 'agent-turn', phase: 'finished' });
	});

	it('refuses a second turn rather than queueing it', async () => {
		const gate = deferred();
		const { manager } = makeManager(
			fakeHarness(async function* (turn) {
				yield {
					kind: 'text',
					sessionId: turn.sessionId,
					messageId: turn.messageId,
					partId: 'p',
					text: 'x'
				};
				await gate.promise;
			})
		);
		const first = manager.start('one');
		// A queue would mean the owner types twice, sees nothing, and later gets two
		// turns against a world that moved — including possibly two proposals.
		expect(() => manager.start('two')).toThrow(PanelTurnInFlightError);
		try {
			manager.start('two');
		} catch (error) {
			expect((error as PanelTurnInFlightError).running.messageId).toBe(first.messageId);
		}
		gate.resolve();
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		// Once it finishes, a new turn is accepted.
		expect(() => manager.start('three')).not.toThrow();
	});

	it('keeps one stable sessionId across turns so the panel keeps one transcript', async () => {
		const { manager } = makeManager(
			fakeHarness(async function* (turn) {
				yield { kind: 'step-finish', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p' };
			})
		);
		const a = manager.start('one');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		const b = manager.start('two');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		expect(b.sessionId).toBe(a.sessionId);
		expect(b.messageId).not.toBe(a.messageId);
	});

	it('passes prior turns to the harness as history', async () => {
		const seenTurns: PanelTurn[] = [];
		const { manager } = makeManager(
			fakeHarness(async function* (turn) {
				seenTurns.push(turn);
				yield {
					kind: 'text',
					sessionId: turn.sessionId,
					messageId: turn.messageId,
					partId: 'p',
					text: `answer to ${turn.text}`
				};
			})
		);
		manager.start('first');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		manager.start('second');
		await vi.waitFor(() => expect(seenTurns).toHaveLength(2));

		// A fresh process per turn has no memory, so continuity is entirely this.
		expect(seenTurns[0]!.history).toEqual([]);
		expect(seenTurns[1]!.history).toEqual([{ prompt: 'first', reply: 'answer to first' }]);
	});

	it('records the latest snapshot per text part rather than concatenating them', async () => {
		const seenTurns: PanelTurn[] = [];
		const { manager } = makeManager(
			fakeHarness(async function* (turn) {
				seenTurns.push(turn);
				// Text parts are snapshots — the same partId growing.
				yield { kind: 'text', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p', text: 'Hel' };
				yield { kind: 'text', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p', text: 'Hello' };
			})
		);
		manager.start('hi');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		manager.start('again');
		await vi.waitFor(() => expect(seenTurns).toHaveLength(2));
		expect(seenTurns[1]!.history[0]!.reply).toBe('Hello');
	});

	it('clearHistory drops the rendered context', async () => {
		const seenTurns: PanelTurn[] = [];
		const { manager } = makeManager(
			fakeHarness(async function* (turn) {
				seenTurns.push(turn);
				yield { kind: 'text', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p', text: 'ok' };
			})
		);
		manager.start('one');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		manager.clearHistory();
		manager.start('two');
		await vi.waitFor(() => expect(seenTurns).toHaveLength(2));
		expect(seenTurns[1]!.history).toEqual([]);
	});

	it('cancels a running turn through the AbortSignal and releases the slot', async () => {
		let sawAbort = false;
		const { manager, seen } = makeManager(
			fakeHarness(async function* (turn, signal) {
				yield { kind: 'step-start', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p' };
				// `signal.aborted` is checked BEFORE subscribing, exactly as
				// `streamJsonLines` does. Cancellation can land in the window between
				// `start()` and the harness getting far enough to add a listener, and a
				// listener-only harness would then wait for an abort that already
				// happened — i.e. hang until its own timeout. Getting this wrong in the
				// first draft of this test is what surfaced the requirement.
				if (!signal.aborted) {
					await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
				}
				sawAbort = true;
				throw new PanelTurnError('cancelled', 'Turn cancelled');
			})
		);
		manager.start('long one');
		await vi.waitFor(() => expect(manager.status().running).toBe(true));
		expect(manager.cancel()).toBe(true);
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		expect(sawAbort).toBe(true);
		expect(seen.at(-1)).toMatchObject({ phase: 'finished', reason: 'Turn cancelled.' });
	});

	it('cancel with nothing running is false, not an error', () => {
		const { manager } = makeManager(fakeHarness(async function* () {}));
		expect(manager.cancel()).toBe(false);
	});

	it('surfaces a harness failure as an error tool part, not as prose', async () => {
		const { manager, seen } = makeManager(
			fakeHarness(async function* () {
				throw new PanelTurnError('spawn_failed', 'Failed to spawn opencode');
			})
		);
		manager.start('go');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		const parts = seen
			.filter((e): e is Extract<ServerEvent, { type: 'agent-part-updated' }> => e.type === 'agent-part-updated')
			.map((e) => e.part);
		// A failure rendered as text would look like the agent talking; the panel's
		// error affordance is the tool line's error state.
		expect(parts[0]).toMatchObject({ kind: 'tool', state: 'error' });
		expect((parts[0] as { error?: string }).error).toContain('installed and on PATH');
		expect(parts.at(-1)).toMatchObject({ kind: 'step-finish' });
	});

	it('reports a silent turn as a failure rather than leaving the panel blank', async () => {
		const { manager, seen } = makeManager(fakeHarness(async function* () {}));
		manager.start('go');
		await vi.waitFor(() => expect(manager.status().running).toBe(false));
		// Silence is indistinguishable from a hung process, so it must not be
		// presented as a completed turn.
		expect(seen.at(-1)).toMatchObject({
			phase: 'finished',
			reason: 'The harness produced no output for this turn.'
		});
	});

	it('holds single-flight state per instance, not per module', async () => {
		// Tests build several apps in one process; a module-level flag would make
		// whichever ran second get a 409 it did not earn.
		const gate = deferred();
		const build = () =>
			makeManager(
				fakeHarness(async function* (turn) {
					yield { kind: 'step-start', sessionId: turn.sessionId, messageId: turn.messageId, partId: 'p' };
					await gate.promise;
				})
			);
		const a = build();
		const b = build();
		a.manager.start('one');
		expect(() => b.manager.start('one')).not.toThrow();
		gate.resolve();
		await vi.waitFor(() => {
			expect(a.manager.status().running).toBe(false);
			expect(b.manager.status().running).toBe(false);
		});
	});
});
