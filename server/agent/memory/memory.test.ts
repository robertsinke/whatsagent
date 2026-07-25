import { describe, expect, it, vi } from 'vitest';
import type { Chat } from '../../store/chats.js';
import { createRuntimeMemory, HindsightMemory, type HindsightClientLike } from './hindsight.js';
import { NullMemory } from './null-memory.js';

const chat: Chat = {
	jid: 'alice@s.whatsapp.net',
	channel: 'whatsapp',
	name: 'Alice',
	kind: '1:1',
	last_msg_at: 1,
	unread: 0,
	muted: false,
	archived: false,
	agent_state: null
};

function fakeClient(overrides: Partial<HindsightClientLike> = {}): HindsightClientLike {
	return {
		retain: async () => ({}),
		recall: async () => ({ results: [] }),
		reflect: async () => ({}),
		...overrides
	};
}

describe('HindsightMemory', () => {
	it('queues failed retains and continues with the local voice fallback', async () => {
		const log = { warn: vi.fn() };
		const client = fakeClient({
			retain: vi.fn(async () => { throw new Error('connection refused'); }),
			recall: vi.fn(async () => { throw new Error('connection refused'); })
		});
		const memory = new HindsightMemory({ client, timeoutMs: 50, log });

		await expect(memory.retainVoiceObservation({
			chatJid: chat.jid,
			language: 'en',
			text: 'Yes, sounds good.'
		})).resolves.toBeUndefined();
		expect(memory.queuedRetains).toBe(1);
		await memory.retainEditDelta({
			chatJid: chat.jid, draft: 'Hello there!', final: 'Hi', skipped: false
		});
		expect(client.retain).toHaveBeenCalledTimes(1);
		expect(memory.queuedRetains).toBe(2);
		await expect(memory.recallStyleFor(chat)).resolves.toContain('Typical message length');
		expect(log.warn).toHaveBeenCalled();
	});

	it('flushes queued observations when Hindsight recovers', async () => {
		let available = false;
		const retain = vi.fn(async (_bankId: string, _content: string) => {
			if (!available) throw new Error('offline');
			return {};
		});
		const memory = new HindsightMemory({
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			log: { warn: vi.fn() }
		});

		await memory.retainEditDelta({ chatJid: chat.jid, draft: 'Hello!', final: 'Hi', skipped: false });
		expect(memory.queuedRetains).toBe(1);
		available = true;
		await memory.retainEditDelta({ chatJid: chat.jid, draft: 'Thanks!', final: 'Thanks', skipped: false });

		expect(memory.queuedRetains).toBe(0);
		expect(retain).toHaveBeenCalledTimes(3);
		expect(retain.mock.calls[1]![1]).toContain('shortened the reply');
	});

	it('returns recalled style and supports off/null/hindsight settings modes', async () => {
		const memory = new HindsightMemory({
			client: fakeClient({
				recall: async () => ({ results: [{ id: '1', text: 'Prefers short greetings.' }] })
			})
		});
		await expect(memory.recallStyleFor(chat)).resolves.toBe('Prefers short greetings.');
		expect(createRuntimeMemory({ memory: 'off' })).toBeInstanceOf(NullMemory);
		expect(createRuntimeMemory({ memory: 'null' })).toBeInstanceOf(NullMemory);
		expect(createRuntimeMemory({ memory: 'hindsight' })).toBeInstanceOf(HindsightMemory);
	});
});
