import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import {
	isDevAgentEventsEnabled,
	startAgentDemoSequence
} from './dev-agent-events.js';

describe('dev agent event emitter', () => {
	afterEach(() => {
		delete process.env.WHATSAGENT_DEV_EVENTS;
	});

	it('is gated on WHATSAGENT_DEV_EVENTS=1', () => {
		expect(isDevAgentEventsEnabled()).toBe(false);
		process.env.WHATSAGENT_DEV_EVENTS = '1';
		expect(isDevAgentEventsEnabled()).toBe(true);
		process.env.WHATSAGENT_DEV_EVENTS = '0';
		expect(isDevAgentEventsEnabled()).toBe(false);
	});

	it('emits agent parts then a focus-chat event through the EventBus', async () => {
		const bus = new EventBus();
		const types: string[] = [];
		bus.subscribe((e) => types.push(e.type));

		const cancel = startAgentDemoSequence(bus, { stepMs: 5 });
		await new Promise((r) => setTimeout(r, 80));
		cancel();

		expect(types.filter((t) => t === 'agent-part-updated').length).toBeGreaterThanOrEqual(4);
		// PANEL-S7 — the harness now emits focus-chat (the production event the
		// open-chat registry action emits), not the retired client-command
		// open-chat duplicate.
		expect(types).toContain('focus-chat');
		const last = types.at(-1);
		expect(last).toBe('focus-chat');
	});
});
