import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '../../store/chats.js';
import { createRuntimeMemory, HindsightMemory, looksLikeVoiceDocument, type HindsightClientLike } from './hindsight.js';
import { NullMemory } from './null-memory.js';
import { composeVoice, VoiceFiles, voiceFileStem } from './voice-files.js';

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

type ModelRow = { id: string; content?: string | null; tags?: string[]; trigger?: unknown; last_refreshed_at?: string | null };

/**
 * In-memory stand-in for the mental-model surface. Records every create so the tests
 * can assert the tag shape rather than trusting the client's defaults. The mirror reads
 * the paginated mental-models list over raw REST (the typed client drops the limit/offset
 * query params and the service caps an unparameterised list at 100), so the fake also
 * exposes a `fetchImpl` that serves its `models` as that list — tests with mirror
 * assertions pass `client.fetchImpl` rather than a generic `okFetch`.
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
		listMentalModels: async () => ({
			items: models.map((model) => ({
				id: model.id,
				content: model.content ?? null,
				last_refreshed_at: model.last_refreshed_at ?? null
			}))
		}),
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

/**
 * Builds a `fetch` that serves `models` as the paginated mental-models list (the route the
 * mirror reads). Pages are sliced by `limit`/`offset`; non-matching URLs fall through to
 * a 200 `{}` so the refresh_cron PATCH and other REST calls keep working. This is the
 * seam the mirror tests use instead of `okFetch` — the mirror never reads through the
 * typed client, so `okFetch` (which returns no items) would mirror nothing.
 */
function mirrorFetch(models: ModelRow[], baseUrl = 'http://127.0.0.1:8888'): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const listPath = `/v1/default/banks/whatsagent-owner-voice/mental-models`;
		if (url.origin === baseUrl && url.pathname === listPath) {
			const limit = Number(url.searchParams.get('limit') ?? '100');
			const offset = Number(url.searchParams.get('offset') ?? '0');
			const page = models.slice(offset, offset + limit);
			return new Response(JSON.stringify({ items: page }), { status: 200 });
		}
		return new Response('{}', { status: 200 });
	}) as unknown as typeof fetch;
}

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
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, fetchImpl: mirrorFetch([]) });

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
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, fetchImpl: mirrorFetch([]) });

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
		const models: ModelRow[] = [{ id: 'voice-global', content: 'Generating content...' }];
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models)
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
		const memory = new HindsightMemory({ dataDir, client: fakeClient({}, models), fetchImpl: mirrorFetch(models) });

		await memory.reflect();

		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('lowercase replies');
		expect(readFileSync(join(dataDir, 'voice', `${voiceFileStem(chat.jid)}.md`), 'utf8'))
			.toContain('Skips greetings');

		// A restart with the service gone: a fresh instance whose every call throws. The
		// mirror reads over raw REST, so the fetch itself must throw (not just the client).
		const deadFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
		const dead = new HindsightMemory({
			dataDir,
			client: fakeClient({
				retain: async () => { throw new Error('ECONNREFUSED'); },
				listMentalModels: async () => { throw new Error('ECONNREFUSED'); },
				getMentalModel: async () => { throw new Error('ECONNREFUSED'); }
			}),
			fetchImpl: deadFetch,
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
		const memory = new HindsightMemory({ dataDir: tempDataDir(), client, fetchImpl: mirrorFetch([]) });

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
		const memory = new HindsightMemory({ dataDir, client, fetchImpl: mirrorFetch(models) });

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
		const models: ModelRow[] = [
			{ id: 'voice-global', content: "I don't have information about the owner's writing habits." }
		];
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models)
		});

		await memory.reflect();

		// The "no information" document is rejected; the last good file is preserved.
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('lowercase replies');
		expect(await memory.recallStyleFor(chat)).not.toContain("don't have information");
	});

	it('looksLikeVoiceDocument accepts real habit shapes and rejects the failure modes', () => {
		expect(looksLikeVoiceDocument('')).toBe(false);
		expect(looksLikeVoiceDocument('Generating content...')).toBe(false);
		expect(looksLikeVoiceDocument("I don't have information about the owner's writing habits.")).toBe(false);
		expect(looksLikeVoiceDocument('I do not have information about the owner writing habits.')).toBe(false);
		expect(looksLikeVoiceDocument('No discernible voice was found.')).toBe(false);
		// A "no information" restated as a single list item is still rejected.
		expect(looksLikeVoiceDocument('- No information about the owner\'s writing habits.')).toBe(false);
		// Classic list-of-habits shape.
		expect(looksLikeVoiceDocument('- Writes short, lowercase replies.\n- Signs off with "grtjs".')).toBe(true);
		// A single declarative sentence with no list and no labeled evidence is rejected.
		expect(looksLikeVoiceDocument('The owner writes informally.')).toBe(false);

		// Live shape that the list-only filter rejected: bold labels + blockquote evidence.
		const blockquoteDoc = [
			'# Owner Voice — Global Writing Habits',
			'',
			'## Tone',
			'',
			"The owner's default tone is **casual, warm, and upbeat**.",
			'',
			'**Casual & relaxed:**',
			'> "No worries all good haha!"',
			'> "Nah all good man, no trouble for me!"',
			'',
			'**Warm & appreciative:**',
			'> "Perfect thank you!"',
			'> "Dankjewel wat lief!"'
		].join('\n');
		expect(looksLikeVoiceDocument(blockquoteDoc)).toBe(true);

		// Prior live shape: list items with bold labels and italic quotes.
		const listWithItalicQuotes = [
			"# Owner's Durable Writing Habits",
			'',
			'## Tone',
			'',
			'- **Casual & friendly**: *"My friend! I\'m doing very well over here!"*',
			'- **Reassuring & laid-back**: *"Nah all good man, no trouble for me!"*'
		].join('\n');
		expect(looksLikeVoiceDocument(listWithItalicQuotes)).toBe(true);

		// Prior live shape: Evidence sections under headings.
		const evidenceSections = [
			"# Owner's Writing Habits",
			'',
			'## Tone',
			"The owner's tone is **warm, informal, and friendly**.",
			'',
			'**Evidence:**',
			'- *"Jo Bor danke maat!"* — casual gratitude',
			'- *"Dank Boor! ❤️"* — short, warm thanks'
		].join('\n');
		expect(looksLikeVoiceDocument(evidenceSections)).toBe(true);

		// Mid-token truncation (the live defect ended `**Supportive/`) — not yet valid.
		expect(looksLikeVoiceDocument(`${blockquoteDoc}\n\n**Supportive/`)).toBe(false);
		expect(looksLikeVoiceDocument(`${evidenceSections}\n\n- `)).toBe(false);
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
			fetchImpl: mirrorFetch([]),
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
			fetchImpl: mirrorFetch([]),
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
			fetchImpl: mirrorFetch([]),
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
			fetchImpl: mirrorFetch([]),
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

describe('change-driven voice mirror (W4-U6)', () => {
	/**
	 * The defect: a freshly consolidated voice document sat in Hindsight for hours
	 * before `reflect()` (6-hourly) copied it to disk, and drafting reads the disk. The
	 * fix is the change-driven mirror on the 60s `drain` tick: it lists models, compares
	 * `last_refreshed_at` against what was last mirrored, and writes only the ones that
	 * advanced. This test reproduces the stall and the recovery in one flow.
	 */
	it('mirrors a refreshed document on drain() within minutes, not the 6-hourly reflect', async () => {
		const dataDir = tempDataDir();
		// Start: a model exists server-side with stale content already on disk.
		const models: ModelRow[] = [
			{ id: 'voice-global', content: '- Old voice.', last_refreshed_at: '2026-07-26T10:00:00Z' }
		];
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models),
			log: { warn: vi.fn() }
		});
		// Boot reflect mirrors the current (old) content to disk.
		await memory.reflect();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('Old voice');

		// The nightly cron refreshes the model server-side: new content, new timestamp.
		models[0] = {
			id: 'voice-global',
			content: '- New voice: signs off with "doei".',
			last_refreshed_at: '2026-07-26T19:04:00Z'
		};

		// No reflect() — only the 60s drain tick. The new document reaches disk.
		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('doei');
		expect(await memory.recallStyleFor(chat)).toContain('doei');
	});

	it('does not re-fetch an unchanged model on drain()', async () => {
		const dataDir = tempDataDir();
		const models: ModelRow[] = [
			{ id: 'voice-global', content: '- Writes short replies.', last_refreshed_at: '2026-07-26T10:00:00Z' }
		];
		let listCalls = 0;
		const countingFetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			if (url.pathname === '/v1/default/banks/whatsagent-owner-voice/mental-models') {
				listCalls += 1;
				const limit = Number(url.searchParams.get('limit') ?? '100');
				const offset = Number(url.searchParams.get('offset') ?? '0');
				return new Response(JSON.stringify({ items: models.slice(offset, offset + limit) }), { status: 200 });
			}
			return new Response('{}', { status: 200 });
		}) as unknown as typeof fetch;
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: countingFetch,
			log: { warn: vi.fn() }
		});

		// Boot reflect mirrors the document and records its refresh timestamp.
		await memory.reflect();
		expect(listCalls).toBeGreaterThanOrEqual(1);
		const callsAfterReflect = listCalls;

		// drain() lists again (to compare timestamps) but writes nothing — the file
		// content is identical and the write is gated by the unchanged last_refreshed_at.
		await memory.drain!();
		expect(listCalls).toBe(callsAfterReflect + 1);
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('short replies');
	});

	it('mirrors a freshly created model with null last_refreshed_at on drain()', async () => {
		const dataDir = tempDataDir();
		// A model that exists but has never refreshed: last_refreshed_at is null. The
		// change-driven mirror treats null as "never mirrored" so the first content
		// reaches disk promptly rather than waiting for the 6-hourly reflect.
		const models: ModelRow[] = [
			{ id: 'voice-global', content: '- First voice document.', last_refreshed_at: null }
		];
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models),
			log: { warn: vi.fn() }
		});

		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('First voice document');
	});

	it('does not treat a rejected document as seen — a later valid refresh reaches disk', async () => {
		const dataDir = tempDataDir();
		seedVoiceFiles(dataDir, { global: '- Last good voice.' });
		// The nightly cron refreshed the model, but the content is the "no information"
		// failure mode. The mirror rejects it (keeps the last good file) and must NOT
		// record the refresh timestamp — otherwise a good document that the filter
		// wrongly rejected (or a truncated one) would freeze forever.
		const models: ModelRow[] = [
			{
				id: 'voice-global',
				content: "I don't have information about the owner's writing habits.",
				last_refreshed_at: '2026-07-26T03:00:00Z'
			}
		];
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models),
			log: { warn: vi.fn() }
		});

		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('Last good voice');

		// Same refresh timestamp, but content is now a valid voice document (the filter
		// was wrong, or a truncated write finished). Because the rejection was not
		// cached, drain reconsidered and wrote it.
		models[0] = {
			id: 'voice-global',
			content: [
				'**Casual & relaxed:**',
				'> "No worries all good haha!"'
			].join('\n'),
			last_refreshed_at: '2026-07-26T03:00:00Z'
		};
		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('No worries');
	});

	it('reconsiders a rejected truncated document on every drain until a complete one lands', async () => {
		const dataDir = tempDataDir();
		seedVoiceFiles(dataDir, { global: '- Last good voice.' });
		const models: ModelRow[] = [
			{
				id: 'voice-global',
				content: [
					'**Casual & relaxed:**',
					'> "No worries all good haha!"',
					'',
					'**Supportive/'
				].join('\n'),
				last_refreshed_at: '2026-07-26T21:13:24Z'
			}
		];
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models),
			log: { warn: vi.fn() }
		});

		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('Last good voice');

		// Next refresh produces a complete document — must reach disk even though the
		// truncated one shared the prior "advanced" timestamp path.
		models[0] = {
			id: 'voice-global',
			content: [
				'**Casual & relaxed:**',
				'> "No worries all good haha!"',
				'',
				'**Supportive:**',
				'> "Sure no problem"'
			].join('\n'),
			last_refreshed_at: '2026-07-26T22:00:00Z'
		};
		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('Sure no problem');
	});

	/**
	 * P3.2 — the owner-edit mirror guard, seen from the memory side.
	 *
	 * Every one of these starts from the same setup: the mirror has written a document,
	 * the owner corrected it through `writeOwnerEdit`, and Hindsight has NOT yet produced
	 * a document reflecting the correction. That is the whole risk window, and it is
	 * measured in the 60 s between drain ticks.
	 */
	describe('owner-edit mirror guard (P3.2)', () => {
		const MACHINE = '- Writes short, lowercase replies.';
		const OWNER = '- Writes short replies, and never uses exclamation marks.';

		function guarded(dataDir: string): void {
			seedVoiceFiles(dataDir, { global: MACHINE });
			new VoiceFiles(dataDir).writeOwnerEdit('global', OWNER);
		}

		it('drain() refuses to mirror a guarded document', async () => {
			const dataDir = tempDataDir();
			guarded(dataDir);
			// A fresh timestamp — the 60 s tick that used to revert the edit.
			const models: ModelRow[] = [
				{ id: 'voice-global', content: MACHINE, last_refreshed_at: '2026-07-29T00:01:00Z' }
			];
			const memory = new HindsightMemory({
				dataDir,
				client: fakeClient({}, models),
				fetchImpl: mirrorFetch(models),
				log: { warn: vi.fn() }
			});

			await memory.drain!();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
		});

		it('reflect() refuses too — the 6-hourly full mirror is unconditional by design', async () => {
			const dataDir = tempDataDir();
			guarded(dataDir);
			const models: ModelRow[] = [
				{ id: 'voice-global', content: MACHINE, last_refreshed_at: '2026-07-29T00:01:00Z' }
			];
			const memory = new HindsightMemory({
				dataDir,
				client: fakeClient({}, models),
				fetchImpl: mirrorFetch(models),
				log: { warn: vi.fn() }
			});

			await memory.reflect();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
		});

		it('HOLDS while the model still returns pre-edit content, EVEN AFTER last_refreshed_at advances', async () => {
			// This is the reason the guard is keyed on content and never on a timestamp.
			// `refreshMentalModel` is a TRIGGER: it returns immediately, Hindsight
			// regenerates in the background, and `refreshVoiceModels()` mirrors on the very
			// next line — still carrying the pre-edit document. A timestamp-keyed guard
			// would be released by the button labelled "make my correction take effect",
			// and the pre-edit document would land straight back on top of the edit.
			const dataDir = tempDataDir();
			guarded(dataDir);
			const models: ModelRow[] = [
				{ id: 'voice-global', content: MACHINE, last_refreshed_at: '2026-07-29T00:00:00Z' }
			];
			const memory = new HindsightMemory({
				dataDir,
				client: fakeClient({}, models),
				fetchImpl: mirrorFetch(models),
				log: { warn: vi.fn() }
			});

			await memory.refreshVoiceModels();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);

			// The timestamp advances (a refresh completed) but the content is unchanged —
			// consolidation had nothing new to say. Still the pre-edit document. Still held.
			models[0] = {
				id: 'voice-global',
				content: MACHINE,
				last_refreshed_at: '2026-07-29T03:00:00Z'
			};
			await memory.drain!();
			await memory.reflect();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
		});

		it('releases as soon as the model returns genuinely new content', async () => {
			const dataDir = tempDataDir();
			guarded(dataDir);
			const models: ModelRow[] = [
				{ id: 'voice-global', content: MACHINE, last_refreshed_at: '2026-07-29T00:00:00Z' }
			];
			const memory = new HindsightMemory({
				dataDir,
				client: fakeClient({}, models),
				fetchImpl: mirrorFetch(models),
				log: { warn: vi.fn() }
			});

			await memory.drain!();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);

			// Consolidation absorbed the correction. The guard steps aside — no TTL was
			// needed and no button had to be pressed.
			const absorbed = '- Writes short replies.\n- Never uses exclamation marks.';
			models[0] = {
				id: 'voice-global',
				content: absorbed,
				last_refreshed_at: '2026-07-29T03:00:00Z'
			};
			await memory.drain!();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(absorbed);
			expect(new VoiceFiles(dataDir).ownerEdit('global')).toBe(null);
		});

		it('does not advance #lastMirroredAt on a refused write', async () => {
			// Observable consequence: refuse at T1, then let the model produce genuinely new
			// content while `last_refreshed_at` STAYS at T1 (a background regeneration that
			// finished under the same refresh). If the refused write had cached T1, the next
			// drain would skip on the timestamp compare and the new content would never land.
			const dataDir = tempDataDir();
			guarded(dataDir);
			const models: ModelRow[] = [
				{ id: 'voice-global', content: MACHINE, last_refreshed_at: '2026-07-29T00:00:00Z' }
			];
			const memory = new HindsightMemory({
				dataDir,
				client: fakeClient({}, models),
				fetchImpl: mirrorFetch(models),
				log: { warn: vi.fn() }
			});

			await memory.drain!();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);

			const absorbed = '- Writes short replies.\n- Never uses exclamation marks.';
			models[0] = {
				id: 'voice-global',
				content: absorbed,
				last_refreshed_at: '2026-07-29T00:00:00Z'
			};
			await memory.drain!();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(absorbed);
		});

		it('protects an edit saved while Hindsight was down, once it comes back', async () => {
			// "Hindsight is down" does NOT swap the instance for NullMemory — it sets
			// #offlineUntil and mirroring resumes minutes later. So the guard is armed on
			// every save regardless of whether the directive call succeeded; otherwise a
			// save-during-outage is clobbered on reconnect.
			const dataDir = tempDataDir();
			seedVoiceFiles(dataDir, { global: MACHINE });
			const models: ModelRow[] = [
				{ id: 'voice-global', content: MACHINE, last_refreshed_at: '2026-07-29T00:00:00Z' }
			];
			const memory = new HindsightMemory({
				dataDir,
				client: fakeClient({ createDirective: async () => { throw new Error('ECONNREFUSED'); } }, models),
				fetchImpl: mirrorFetch(models),
				log: { warn: vi.fn() }
			});

			// The save path arms the guard first; the directive is best-effort and fails here.
			new VoiceFiles(dataDir).writeOwnerEdit('global', OWNER);
			await expect(memory.recordVoiceCorrection('correction', 'note')).rejects.toThrow();

			// Docker comes back and the mirror resumes.
			await memory.drain!();
			expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
		});
	});

	/**
	 * The list endpoint caps an unparameterised response at 100 items and the typed
	 * client drops the limit/offset query params, so the mirror walks pages over raw
	 * REST. Done is a page strictly shorter than the page size — the response carries
	 * no total/cursor. This test seeds a model set larger than one page and asserts the
	 * whole set is mirrored, proving the walk does not stop at the first full page.
	 */
	it('paginates the mental-model list and mirrors a set larger than one page', async () => {
		const dataDir = tempDataDir();
		const models: ModelRow[] = [];
		for (let i = 0; i < 25; i++) {
			models.push({
				id: `voice-contact-${i}`,
				content: `- Habit for contact ${i}.`,
				last_refreshed_at: `2026-07-26T1${i}:00:00Z`
			});
		}
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models),
			// Small page size forces pagination — 25 models over 10-item pages.
			mirrorListPageSize: 10,
			log: { warn: vi.fn() }
		});

		await memory.reflect();

		// Every model reached disk. A non-paginating mirror would stop at the first 10.
		for (let i = 0; i < 25; i++) {
			expect(readFileSync(join(dataDir, 'voice', `contact-${i}.md`), 'utf8'))
				.toContain(`Habit for contact ${i}`);
		}
	});

	it('drain() mirrors changed documents across pages, not just the first page', async () => {
		const dataDir = tempDataDir();
		const models: ModelRow[] = [];
		for (let i = 0; i < 25; i++) {
			models.push({
				id: `voice-contact-${i}`,
				content: `- Old habit ${i}.`,
				last_refreshed_at: `2026-07-26T10:00:0${i}Z`
			});
		}
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({}, models),
			fetchImpl: mirrorFetch(models),
			mirrorListPageSize: 10,
			log: { warn: vi.fn() }
		});
		// Boot reflect mirrors all 25 (across 3 pages).
		await memory.reflect();

		// A model on the last page refreshes. drain() must walk past the first full page
		// to see it — a single-page mirror would miss it.
		models[24] = {
			id: 'voice-contact-24',
			content: '- NEW habit on the last page.',
			last_refreshed_at: '2026-07-26T20:00:00Z'
		};
		await memory.drain!();
		expect(readFileSync(join(dataDir, 'voice', 'contact-24.md'), 'utf8')).toContain('NEW habit on the last page');
	});
});

describe('poison observation escape (W4-U7)', () => {
	/**
	 * The defect: a permanently failing retain sat at the head of the queue forever
	 * (shift only after success), and every tick's shared try/catch aborted before the
	 * mirror — so voice/global.md froze after the first boot write. The fakes that
	 * already existed either succeed or fail transiently then recover; this is the
	 * case that matters: a send that fails FOREVER.
	 */
	it('still mirrors when the flush is failing forever', async () => {
		const dataDir = tempDataDir();
		const models: ModelRow[] = [
			{ id: 'voice-global', content: '- Old voice.', last_refreshed_at: '2026-07-26T10:00:00Z' }
		];
		const log = { warn: vi.fn() };
		const retain = vi.fn(async () => {
			throw new Error('Fact extraction failed: JSONDecodeError');
		});
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			maxRetainAttempts: 5,
			fetchImpl: mirrorFetch(models),
			log
		});

		await memory.reflect();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('Old voice');

		// Poison the queue — this observation will never succeed.
		await memory.retainVoiceObservation({
			chatJid: chat.jid,
			language: 'en',
			text: 'ja prima'
		});
		expect(memory.queuedRetains).toBe(1);

		// Server-side refresh lands new content. The mirror must copy it even though
		// flush is still throwing on the poison head.
		models[0] = {
			id: 'voice-global',
			content: '- New voice: signs off with "doei".',
			last_refreshed_at: '2026-07-26T20:21:08Z'
		};
		await memory.drain!();

		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('doei');
		expect(memory.queuedRetains).toBe(1);
		expect(log.warn).toHaveBeenCalled();
	});

	it('drops a forever-failing observation past the attempt threshold', async () => {
		const log = { warn: vi.fn() };
		let failForever = true;
		const retain = vi.fn(async () => {
			if (failForever) throw new Error('Fact extraction failed: JSONDecodeError');
			return {};
		});
		const memory = new HindsightMemory({
			dataDir: tempDataDir(),
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			maxRetainAttempts: 3,
			fetchImpl: mirrorFetch([]),
			log
		});

		await memory.retainVoiceObservation({
			chatJid: chat.jid,
			language: 'en',
			text: 'poison'
		});
		expect(memory.queuedRetains).toBe(1);

		// Three flush attempts (retryDelayMs: 0 so the offline window never blocks).
		await memory.drain!();
		expect(memory.queuedRetains).toBe(1);
		await memory.drain!();
		expect(memory.queuedRetains).toBe(1);
		await memory.drain!();
		expect(memory.queuedRetains).toBe(0);

		expect(log.warn.mock.calls.some((call) =>
			String(call[0]).includes('dropping poison observation')
		)).toBe(true);

		// A later observation is not stuck behind the dropped one.
		failForever = false;
		await memory.retainEditDelta({
			chatJid: chat.jid, draft: 'Hello!', final: 'Hi', skipped: false
		});
		expect(memory.queuedRetains).toBe(0);
		expect(retain).toHaveBeenCalled();
	});

	it('reflect mirrors even when the retain queue is poisoned', async () => {
		const dataDir = tempDataDir();
		const models: ModelRow[] = [
			{ id: 'voice-global', content: '- Boot voice.', last_refreshed_at: '2026-07-26T10:00:00Z' }
		];
		const retain = vi.fn(async () => {
			throw new Error('permanent retain failure');
		});
		const memory = new HindsightMemory({
			dataDir,
			client: fakeClient({ retain }),
			retryDelayMs: 0,
			maxRetainAttempts: 5,
			fetchImpl: mirrorFetch(models),
			log: { warn: vi.fn() }
		});

		await memory.retainVoiceObservation({
			chatJid: chat.jid, language: 'nl', text: 'hoi'
		});
		models[0] = {
			id: 'voice-global',
			content: '- Reflect still works.',
			last_refreshed_at: '2026-07-26T11:00:00Z'
		};
		await memory.reflect();
		expect(readFileSync(join(dataDir, 'voice', 'global.md'), 'utf8')).toContain('Reflect still works');
	});
});
