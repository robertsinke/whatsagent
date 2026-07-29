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

	it('emits agent parts then an open-chat command through the EventBus', async () => {
		const bus = new EventBus();
		const types: string[] = [];
		bus.subscribe((e) => types.push(e.type));

		const cancel = startAgentDemoSequence(bus, { stepMs: 5 });
		await new Promise((r) => setTimeout(r, 80));
		cancel();

		expect(types.filter((t) => t === 'agent-part-updated').length).toBeGreaterThanOrEqual(4);
		expect(types).toContain('client-command');
		const last = types.at(-1);
		expect(last).toBe('client-command');
	});
});
