import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '../../store/chats.js';
import { createRuntimeMemory, HindsightMemory, looksLikeVoiceDocument, type HindsightClientLike } from './hindsight.js';
import { NullMemory } from './null-memory.js';
import { composeVoice, voiceFileStem } from './voice-files.js';

const chat: Chat = {
	jid: 'alice@s.whatsapp.net',
	channel: 'whatsapp',
	name: 'Alice',
	kind: '1:1',
	last_msg_at: 1,
	unread: 0,
	muted: false,
	archived: false,
	agent_state: null,
	last_read_msg_id: null
};

/** Every test writes into its own temp dir — the mirror writes real files. */
function tempDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'whatsagent-voice-'));
}

function seedVoiceFiles(dataDir: string, files: Record<string, string>): void {
	mkdirSync(join(dataDir, 'voice'), { recursive: true });
	for (const [stem, content] of Object.entries(files)) {
		writeFileSync(join(dataDir, 'voice', `${stem}.md`), content, 'utf8');
	}
}

type ModelRow = { id: string; content?: string | null; tags?: string[]; trigger?: unknown };

/**
 * In-memory stand-in for the mental-model surface. Records every create so the tests
 * can assert the tag shape rather than trusting the client's defaults.
 */
function fakeClient(overrides: Partial<HindsightClientLike> = {}, models: ModelRow[] = []) {
	const created: Array<{ id: string; tags?: string[]; trigger?: unknown }> = [];
	const client: HindsightClientLike & { created: typeof created; models: ModelRow[] } = {
		retain: async () => ({}),
		createMentalModel: async (_bank, _name, _query, options) => {
			created.push({ id: options?.id ?? _name, tags: options?.tags, trigger: options?.trigger });
			models.push({ id: options?.id ?? _name, tags: options?.tags, trigger: options?.trigger });
			return {};
		},
		listMentalModels: async () => ({ items: models.map((model) => ({ id: model.id })) }),
		getMentalModel: async (_bank, id) => {
			const model = models.find((row) => row.id === id);
			if (!model) throw new Error(`404 no mental model ${id}`);
			return model;
		},
		refreshMentalModel: async () => ({}),
		createDirective: async () => ({}),
		listDirectives: async () => ({ items: [] }),
		...overrides,
		created,
		models
	};
	return client;
}

const okFetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

afterEach(() => vi.clearAllMocks());

describe('HindsightMemory retain path', () => {
	it('queues failed retains and continues with the local voice fallback', async () => {
		const log = { warn: vi.fn() };
		const client = fakeClient({
			retain: vi.fn(async () => { throw new Error('connection refused'); })
		});
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, timeoutMs: 50, log, fetchImpl: okFetch });

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
		// Nothing consolidated yet and nothing on disk: the static local floor still applies.
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
			dataDir: tempDataDir(),
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			fetchImpl: okFetch,
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
});

describe('voice mental models', () => {
	/**
	 * D1's trap: a tagged model defaults to `all_strict`, so a memory must carry *every*
	 * model tag. This locks the invariant that makes that safe — each voice model's tags
	 * are a subset of the tags the retains actually write, so no memory is silently dropped.
	 */
	it('creates models whose tags are a subset of what the retains write', async () => {
		const client = fakeClient();
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, fetchImpl: okFetch });

		await memory.retainEditDelta({ chatJid: chat.jid, draft: 'Hi there!', final: 'Hi', skipped: false });
		await memory.reflect();

		const retainedTags = (client.retain as ReturnType<typeof vi.fn>).mock?.calls?.[0]?.[2]?.tags
			?? [`chat:${chat.jid}`, 'edit', 'voice'];
		const global = client.created.find((model) => model.id === 'voice-global')!;
		const perChat = client.created.find((model) => model.id !== 'voice-global')!;

		expect(global.tags).toEqual(['voice']);
		expect(perChat.id).toBe(`voice-${voiceFileStem(chat.jid)}`);
		expect(perChat.tags).toEqual([`chat:${chat.jid}`]);
		for (const model of [global, perChat]) {
			expect(model.trigger).toEqual({ tagsMatch: 'all_strict', refreshAfterConsolidation: false });
			for (const tag of model.tags ?? []) expect(retainedTags).toContain(tag);
		}
	});

	/**
	 * Voice bootstrap emits one observation per 1:1 chat per language across the entire
	 * message table. A per-chat model created from that path would mean one background
	 * LLM synthesis per chat on first boot — so only an edit or a skip creates one.
	 */
	it('creates no per-chat model from voice bootstrap, however many chats it samples', async () => {
		const client = fakeClient();
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, fetchImpl: okFetch });

		for (let i = 0; i < 50; i++) {
			await memory.retainVoiceObservation({
				chatJid: `3161000${i}@s.whatsapp.net`, language: 'nl', text: 'ja prima'
			});
		}
		await memory.reflect();

		expect(client.created.map((model) => model.id)).toEqual(['voice-global']);

		// One edit is the demand signal that does create the contact's document.
		await memory.retainEditDelta({ chatJid: chat.jid, draft: 'Hi there!', final: 'Hi', skipped: false });
		expect(client.created.map((model) => model.id)).toContain(`voice-${voiceFileStem(chat.jid)}`);
	});

	it('sets refresh_cron over raw REST and never leaves refresh_after_consolidation on', async () => {
		const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			patches.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;
		const memory = new HindsightMemory({
			dataDir: tempDataDir(),
			client: fakeClient(),
			baseUrl: 'http://127.0.0.1:9999',
			bankId: 'test-bank',
			refreshCron: '0 4 * * *',
			fetchImpl
		});

		// The global model is ensured lazily on the first successful retain, not at reflect,
		// so a retain is what triggers the refresh_cron PATCH.
		await memory.retainVoiceObservation({ chatJid: chat.jid, language: 'en', text: 'hi' });

		const patch = patches.find((entry) => entry.url.endsWith('/mental-models/voice-global'))!;
		expect(patch.url).toBe('http://127.0.0.1:9999/v1/default/banks/test-bank/mental-models/voice-global');
		expect(patch.body.trigger).toEqual({
			refresh_cron: '0 4 * * *',
			refresh_after_consolidation: false,
			tags_match: 'all_strict'
		});
	});

	it('never mirrors the in-flight refresh placeholder over a good document', async () => {
		const dataDir = tempDataDir();
		seedVoiceFiles(dataDir, { global: '- Writes short, lowercase replies.' });
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, [{ id: 'voice-global', content: 'Generating content...' }]),
			fetchImpl: okFetch
		});

		await memory.reflect();

		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('lowercase replies');
		expect(await memory.recallStyleFor(chat)).not.toContain('Generating content');
	});

	it('mirrors model markdown to disk and still serves it after a restart', async () => {
		const dataDir = tempDataDir();
		const models: ModelRow[] = [
			{ id: 'voice-global', content: '- Writes short, lowercase replies.' },
			{ id: `voice-${voiceFileStem(chat.jid)}`, content: '- Skips greetings with Alice.' }
		];
		const memory = new HindsightMemory({ dataDir, client: fakeClient({}, models), fetchImpl: okFetch });

		await memory.reflect();

		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('lowercase replies');
		expect(readFileSync(join(dataDir, 'voice', `${voiceFileStem(chat.jid)}.md`), 'utf8'))
			.toContain('Skips greetings');

		// A restart with the service gone: a fresh instance whose every call throws.
		const dead = new HindsightMemory({
			dataDir,
			client: fakeClient({
				retain: async () => { throw new Error('ECONNREFUSED'); },
				listMentalModels: async () => { throw new Error('ECONNREFUSED'); },
				getMentalModel: async () => { throw new Error('ECONNREFUSED'); }
			}),
			fetchImpl: okFetch,
			log: { warn: vi.fn() }
		});
		const style = await dead.recallStyleFor(chat);
		expect(style).toContain('lowercase replies');
		expect(style).toContain('Skips greetings');
		// W4-R6: an outage costs freshness, not availability.
		await expect(dead.reflect()).resolves.toBeUndefined();
	});
});

describe('voice composition', () => {
	it('puts the contact document last so it wins on conflict', async () => {
		const dataDir = tempDataDir();
		seedVoiceFiles(dataDir, {
			global: '- Signs off with "grtjs".',
			[voiceFileStem(chat.jid)]: '- Never signs off with Alice.'
		});
		const memory = new HindsightMemory({ dataDir, client: fakeClient(), fetchImpl: okFetch });

		const style = (await memory.recallStyleFor(chat))!;
		expect(style.indexOf('grtjs')).toBeLessThan(style.indexOf('Never signs off'));
	});

	it('budgets both documents so they cannot outgrow the conversation', () => {
		const composed = composeVoice('g'.repeat(5_000), 'c'.repeat(5_000), 600)!;
		expect(composed.length).toBeLessThan(900);
		expect(composed).toContain('truncated');
	});

	it('reads a blank document as nothing learned yet', async () => {
		const dataDir = tempDataDir();
		seedVoiceFiles(dataDir, { global: '   \n' });
		const memory = new HindsightMemory({ dataDir, client: fakeClient(), fetchImpl: okFetch });
		await expect(memory.recallStyleFor(chat)).resolves.toBeNull();
	});
});

describe('createRuntimeMemory', () => {
	it('defaults to hindsight and keeps off and null working', async () => {
		const dataDir = tempDataDir();
		expect(createRuntimeMemory({}, { dataDir })).toBeInstanceOf(HindsightMemory);
		expect(createRuntimeMemory({ memory: 'hindsight' }, { dataDir })).toBeInstanceOf(HindsightMemory);
		expect(createRuntimeMemory({ memory: 'null' }, { dataDir })).toBeInstanceOf(NullMemory);

		const off = createRuntimeMemory({ memory: 'off' }, { dataDir });
		expect(off).toBeInstanceOf(NullMemory);
		// 'off' is a true no-op: it retains nothing and recalls nothing, even after observations.
		await off.retainVoiceObservation({ chatJid: chat.jid, language: 'en', text: 'Sure, see you then.' });
		await off.retainEditDelta({ chatJid: chat.jid, draft: 'Hello!', final: 'Hi', skipped: false });
		await expect(off.recallStyleFor(chat)).resolves.toBeNull();
	});
});

describe('voice bootstrap plumbing (W4-U5)', () => {
	/**
	 * Fix 1: `reflect()` must not create the global model before any observation has been
	 * retained. Creating it against an empty bank makes Hindsight synthesize a "no
	 * information about the owner's writing habits" document, which would then be mirrored
	 * to `voice/global.md` and handed to the drafter as the owner's voice.
	 */
	it('does not create the global model until the first successful retain', async () => {
		const client = fakeClient();
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, fetchImpl: okFetch });

		// A reflect on a fresh bank creates no model — there is nothing to synthesize from.
		await memory.reflect();
		expect(client.created).toEqual([]);
		expect(client.models).toEqual([]);

		// The first successful retain lazily ensures the global model.
		await memory.retainVoiceObservation({ chatJid: chat.jid, language: 'en', text: 'hi' });
		expect(client.created.map((model) => model.id)).toEqual(['voice-global']);
	});

	it('mirrors existing model content on a restart without creating the global model', async () => {
		const dataDir = tempDataDir();
		// Simulate a restart: the global model already exists server-side with real content.
		const models: ModelRow[] = [{ id: 'voice-global', content: '- Writes short, lowercase replies.' }];
		const client = fakeClient({}, models);
		const memory = new HindsightMemory({ dataDir, client, fetchImpl: okFetch });

		await memory.reflect();

		// No new model created (it already exists), but its content is mirrored to disk.
		expect(client.created).toEqual([]);
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('lowercase replies');
	});

	/**
	 * Fix 2: the mirror filter must be a positive test, not a two-string blocklist. An LLM
	 * with nothing to say writes "I do not have information about the owner writing
	 * habits." — which passed the old blocklist, got mirrored, and was handed to the
	 * drafter as the owner's voice.
	 */
	it('rejects a "no information" document in the mirror and keeps the last good file', async () => {
		const dataDir = tempDataDir();
		seedVoiceFiles(dataDir, { global: '- Writes short, lowercase replies.' });
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient(
				{},
				[{ id: 'voice-global', content: "I don't have information about the owner's writing habits." }]
			),
			fetchImpl: okFetch
		});

		await memory.reflect();

		// The "no information" document is rejected; the last good file is preserved.
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('lowercase replies');
		expect(await memory.recallStyleFor(chat)).not.toContain("don't have information");
	});

	it('looksLikeVoiceDocument accepts a real habit list and rejects the failure modes', () => {
		expect(looksLikeVoiceDocument('')).toBe(false);
		expect(looksLikeVoiceDocument('Generating content...')).toBe(false);
		expect(looksLikeVoiceDocument("I don't have information about the owner's writing habits.")).toBe(false);
		expect(looksLikeVoiceDocument('I do not have information about the owner writing habits.')).toBe(false);
		expect(looksLikeVoiceDocument('No discernible voice was found.')).toBe(false);
		// A "no information" restated as a single list item is still rejected.
		expect(looksLikeVoiceDocument('- No information about the owner\'s writing habits.')).toBe(false);
		// A real voice document with concrete habits is accepted.
		expect(looksLikeVoiceDocument('- Writes short, lowercase replies.\n- Signs off with "grtjs".')).toBe(true);
		// A single declarative sentence with no list is rejected (a real voice doc is a list).
		expect(looksLikeVoiceDocument('The owner writes informally.')).toBe(false);
	});

	/**
	 * Fix 3: retain uses a longer timeout than the 2 s steady-state mirror budget, so the
	 * first retain after a cold start (whose floor cost is the LLM warming, not the
	 * network) does not abort and park the whole bootstrap. Uses fake timers — the test
	 * injects the clock, it does not sleep.
	 */
	it('gives retain a longer timeout than the mirror path', async () => {
		vi.useFakeTimers();
		try {
			let release!: () => void;
			const heldOpen = new Promise<void>((resolve) => { release = resolve; });
			let aborted = false;
			const retain = vi.fn(async (_bank: string, _content: string, options?: { signal?: AbortSignal }) => {
				await heldOpen;
				if (options?.signal?.aborted) { aborted = true; throw new Error('aborted'); }
				return {};
			});
			const memory = new HindsightMemory({
				dataDir: tempDataDir(),
				client: fakeClient({ retain }),
				timeoutMs: 2_000,
				retainTimeoutMs: 30_000,
				fetchImpl: okFetch,
				log: { warn: vi.fn() }
			});

			const pending = memory.retainVoiceObservation({ chatJid: chat.jid, language: 'en', text: 'hi' });
			// Advance past the 2 s mirror budget — retain must still be in flight (30 s budget).
			await vi.advanceTimersByTimeAsync(2_500);
			expect(aborted).toBe(false);
			release();
			await pending;

			expect(retain).toHaveBeenCalledTimes(1);
			expect(memory.queuedRetains).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('retains with the default 30 s budget when retainTimeoutMs is unset', async () => {
		vi.useFakeTimers();
		try {
			let release!: () => void;
			const heldOpen = new Promise<void>((resolve) => { release = resolve; });
			let aborted = false;
			const retain = vi.fn(async (_bank: string, _content: string, options?: { signal?: AbortSignal }) => {
				await heldOpen;
				if (options?.signal?.aborted) { aborted = true; throw new Error('aborted'); }
				return {};
			});
			const memory = new HindsightMemory({
				dataDir: tempDataDir(),
				client: fakeClient({ retain }),
				fetchImpl: okFetch,
				log: { warn: vi.fn() }
			});

			const pending = memory.retainVoiceObservation({ chatJid: chat.jid, language: 'en', text: 'hi' });
			// 5 s — past the 2 s default timeoutMs, under the 30 s retain floor.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(aborted).toBe(false);
			release();
			await pending;

			expect(aborted).toBe(false);
			expect(memory.queuedRetains).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * Fix 4: the queue drains on a short timer, independent of the 6-hourly reflect. A
	 * cold-start retain that times out sets the offline window; without a drain, the
	 * queue sits until the next retain or reflect. `drain()` retries the flush once the
	 * offline window has elapsed. The test injects a controllable clock via
	 * `retryDelayMs: 0` so the offline window elapses immediately (no real sleep).
	 */
	it('drains the queue on drain() once the offline window has elapsed', async () => {
		let available = false;
		const retain = vi.fn(async (_bankId: string, _content: string) => {
			if (!available) throw new Error('offline');
			return {};
		});
		const memory = new HindsightMemory({
			dataDir: tempDataDir(),
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			fetchImpl: okFetch,
			log: { warn: vi.fn() }
		});

		// First retain fails and queues; offline window is 0 ms so it elapses at once.
		await memory.retainEditDelta({ chatJid: chat.jid, draft: 'Hi!', final: 'Hi', skipped: false });
		expect(memory.queuedRetains).toBe(1);

		// No successful retain and no reflect — only drain() retries the queue.
		available = true;
		await memory.drain!();

		expect(memory.queuedRetains).toBe(0);
		expect(retain).toHaveBeenCalledTimes(2);
	});

	it('drain() is a no-op while still offline', async () => {
		const retain = vi.fn(async () => { throw new Error('offline'); });
		const memory = new HindsightMemory({
			dataDir: tempDataDir(),
			client: fakeClient({ retain }),
			retryDelayMs: 60_000,
			fetchImpl: okFetch,
			log: { warn: vi.fn() }
		});

		await memory.retainEditDelta({ chatJid: chat.jid, draft: 'Hi!', final: 'Hi', skipped: false });
		expect(memory.queuedRetains).toBe(1);

		// Still offline (60 s window) — drain does nothing and does not throw.
		await expect(memory.drain!()).resolves.toBeUndefined();
		expect(memory.queuedRetains).toBe(1);
	});

	it('drain() is a no-op when the queue is empty', async () => {
		const retain = vi.fn(async () => ({}));
		const memory = new HindsightMemory({
			dataDir: tempDataDir(),
			client: fakeClient({ retain }),
			fetchImpl: okFetch,
			log: { warn: vi.fn() }
		});

		await expect(memory.drain!()).resolves.toBeUndefined();
		expect(retain).not.toHaveBeenCalled();
	});

	/**
	 * The full bootstrap stall, reproduced as a single flow: boot reflect on an empty bank
	 * creates nothing; the first retain times out and queues; the short drain retries and
	 * flushes the queue — instead of parking it for six hours.
	 */
	it('recovers from a cold-start retain timeout via drain (the original stall)', async () => {
		let call = 0;
		const retain = vi.fn(async () => {
			call += 1;
			// First call (the bootstrap retain) "times out"; subsequent calls succeed.
			if (call === 1) throw new Error('timeout');
			return {};
		});
		const memory = new HindsightMemory({
			dataDir: tempDataDir(),
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			fetchImpl: okFetch,
			log: { warn: vi.fn() }
		});

		// Boot reflect on an empty bank: no model created, nothing mirrored.
		await memory.reflect();
		expect(memory.queuedRetains).toBe(0);

		// First retain fails and queues (the 2 s timeout in the diagnosis).
		await memory.retainVoiceObservation({ chatJid: chat.jid, language: 'en', text: 'hi' });
		expect(memory.queuedRetains).toBe(1);

		// The drain timer fires — the queue flushes instead of parking for six hours.
		await memory.drain!();
		expect(memory.queuedRetains).toBe(0);
		expect(retain).toHaveBeenCalledTimes(2);
	});
});
