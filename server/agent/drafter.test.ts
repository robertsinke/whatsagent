import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChat, upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { ProviderError, type DraftInput, type DraftProvider } from '../providers/provider.js';
import { draftChat } from './drafter.js';
import type { CalendarDigestSource } from './drafter.js';
import type { Memory } from './memory/memory.js';
import { NullMemory } from './memory/null-memory.js';

let db: AppDatabase | undefined;
let dataDir: string | undefined;

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-drafter-'));
	db = openDatabase({ dataDir });
	upsertChat(db, {
		jid: 'alice@s.whatsapp.net',
		name: 'Alice',
		kind: '1:1',
		last_msg_at: 200,
		muted: false,
		archived: false
	});
	upsertMessage(db, {
		id: 'm1',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: true,
		ts: 100,
		text: 'Ja, klinkt goed.'
	});
	upsertMessage(db, {
		id: 'm2',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: false,
		ts: 200,
		text: 'Zullen we om zeven uur afspreken?'
	});
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('draftChat', () => {
	it('builds language/style context and stores a ready draft with provenance', async () => {
		const database = setup();
		const draft = vi.fn(async (_input: DraftInput) => ({
			kind: 'draft' as const,
			text: 'Ja, zeven uur is goed.'
		}));
		const memory: Memory = {
			retainVoiceObservation: async () => undefined,
			retainEditDelta: async () => undefined,
			recallStyleFor: async () => 'Uses short, direct confirmations.',
			reflect: async () => undefined
		};

		const result = await draftChat({
			db: database,
			provider: { draft },
			providerName: 'fake',
			memory,
			chatJid: 'alice@s.whatsapp.net',
			now: () => 500
		});

		expect(result.kind).toBe('ready');
		expect(draft).toHaveBeenCalledOnce();
		expect(draft.mock.calls[0]![0].system).toContain('Match the language');
		expect(draft.mock.calls[0]![0].system).toContain('short, direct confirmations');
		expect(draft.mock.calls[0]![0].conversation).toEqual([
			{ role: 'assistant', content: 'Ja, klinkt goed.', ts: 100 },
			{ role: 'user', content: 'Zullen we om zeven uur afspreken?', ts: 200 }
		]);
		expect(draft.mock.calls[0]![0].now).toBe(500);
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			text: 'Ja, zeven uur is goed.',
			status: 'ready',
			provider: 'fake',
			basis_msg_id: 'm2'
		});
	});

	it('demotes no_reply_needed quietly and removes the drafting row', async () => {
		const database = setup();
		const provider: DraftProvider = {
			draft: async () => ({ kind: 'no_reply_needed', reason: 'Acknowledgement only' })
		};

		await expect(
			draftChat({
				db: database,
				provider,
				providerName: 'fake',
				memory: new NullMemory(),
				chatJid: 'alice@s.whatsapp.net'
			})
		).resolves.toEqual({ kind: 'no_reply_needed' });
		expect(getDraft(database, 'alice@s.whatsapp.net')).toBeUndefined();
		// 'quiet', not 'skipped' — an agent verdict is not an owner opt-out.
		expect(getChat(database, 'alice@s.whatsapp.net')?.agent_state).toBe('quiet');
	});

	it('stores a ProviderError code as failed without an agent retry', async () => {
		const database = setup();
		const provider: DraftProvider = {
			draft: vi.fn(async () => {
				throw new ProviderError('process_exit', 'CLI exited', true, 10);
			})
		};

		await expect(
			draftChat({
				db: database,
				provider,
				providerName: 'fake',
				memory: new NullMemory(),
				chatJid: 'alice@s.whatsapp.net'
			})
		).resolves.toEqual({ kind: 'failed', code: 'process_exit' });
		expect(provider.draft).toHaveBeenCalledOnce();
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			status: 'failed',
			error_code: 'process_exit',
			text: '',
			basis_msg_id: 'm2'
		});
		expect(getChat(database, 'alice@s.whatsapp.net')?.agent_state).toBe('failed');
	});

	it('returns rate-limit backoff without creating a failed row', async () => {
		const database = setup();
		const provider: DraftProvider = {
			draft: async () => {
				throw new ProviderError('rate_limit', 'Not yet', true, 2_500);
			}
		};

		await expect(
			draftChat({
				db: database,
				provider,
				providerName: 'fake',
				memory: new NullMemory(),
				chatJid: 'alice@s.whatsapp.net'
			})
		).resolves.toEqual({ kind: 'rate_limited', retryAfterMs: 2_500 });
		expect(getDraft(database, 'alice@s.whatsapp.net')).toBeUndefined();
		expect(getChat(database, 'alice@s.whatsapp.net')?.agent_state).toBe('needs_reply');
	});

	it('does not publish an obsolete provider result after a newer message', async () => {
		const database = setup();
		let resolve!: (result: { kind: 'draft'; text: string }) => void;
		const provider: DraftProvider = {
			draft: () => new Promise((done) => (resolve = done))
		};
		const attempt = draftChat({
			db: database,
			provider,
			providerName: 'fake',
			memory: new NullMemory(),
			chatJid: 'alice@s.whatsapp.net'
		});
		await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
		upsertMessage(database, {
			id: 'm3',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 300,
			text: 'And can we make it eight instead?'
		});
		resolve({ kind: 'draft', text: 'Obsolete reply' });

		await expect(attempt).resolves.toEqual({ kind: 'superseded' });
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			status: 'stale',
			basis_msg_id: 'm2'
		});
	});
});

describe('draftChat — owner-requested (W4-U15)', () => {
	function options(database: AppDatabase, provider: DraftProvider) {
		return {
			db: database,
			provider,
			providerName: 'fake',
			memory: new NullMemory() as Memory,
			chatJid: 'alice@s.whatsapp.net',
			ownerRequested: true
		};
	}

	it('drafts off a trailing outbound message without superseding itself', async () => {
		const database = setup();
		upsertMessage(database, {
			id: 'm3',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 300,
			text: 'Ik laat het je weten.'
		});
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Nog even over morgen…' }));

		const result = await draftChat(options(database, { draft }));

		expect(result.kind).toBe('ready');
		expect(draft).toHaveBeenCalledOnce();
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			status: 'ready',
			basis_msg_id: 'm3'
		});
	});

	it('keeps the trailing owner message as an assistant turn, never rewritten to inbound', async () => {
		const database = setup();
		upsertMessage(database, {
			id: 'm3',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 300,
			text: 'Ik laat het je weten.'
		});
		let captured: DraftInput | undefined;
		await draftChat(
			options(database, {
				draft: async (input: DraftInput) => {
					captured = input;
					return { kind: 'draft' as const, text: 'ok' };
				}
			})
		);

		const last = captured!.conversation.at(-1)!;
		expect(last).toMatchObject({ role: 'assistant', content: 'Ik laat het je weten.' });
		// Without this clause the base prompt invites no_reply_needed on exactly
		// the runs the owner asked for.
		expect(captured!.system).toContain('Do not return no_reply_needed');
	});

	it('refuses a group chat — R8 holds inside the drafter, not only at the route', async () => {
		const database = setup();
		upsertChat(database, {
			jid: 'team@g.us',
			name: 'Team',
			kind: 'group',
			last_msg_at: 400,
			muted: false,
			archived: false
		});
		upsertMessage(database, {
			id: 'g1',
			chat_jid: 'team@g.us',
			from_me: false,
			ts: 400,
			text: '@owner joining?'
		});
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Never' }));

		const result = await draftChat({ ...options(database, { draft }), chatJid: 'team@g.us' });

		expect(result).toEqual({ kind: 'not_needed' });
		expect(draft).not.toHaveBeenCalled();
		expect(getDraft(database, 'team@g.us')).toBeUndefined();
	});

	it('still supersedes when newer inbound lands mid-run, so approval re-confirms', async () => {
		const database = setup();
		upsertMessage(database, {
			id: 'm3',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 300,
			text: 'Ik laat het je weten.'
		});
		const draft = vi.fn(async () => {
			upsertMessage(database, {
				id: 'm4',
				chat_jid: 'alice@s.whatsapp.net',
				from_me: false,
				ts: 400,
				text: 'Wacht even!'
			});
			return { kind: 'draft' as const, text: 'Too late' };
		});

		const result = await draftChat(options(database, { draft }));

		expect(result).toEqual({ kind: 'superseded' });
		expect(getDraft(database, 'alice@s.whatsapp.net')?.status).toBe('stale');
	});

	it('does not silence the chat when the provider declines an owner request', async () => {
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'no_reply_needed' as const, reason: 'owner already covered it' }));

		const result = await draftChat(options(database, { draft }));

		expect(result).toEqual({ kind: 'no_reply_needed' });
		expect(getChat(database, 'alice@s.whatsapp.net')?.agent_state).toBeNull();
	});

	it('returns not_needed for an empty chat rather than drafting from nothing', async () => {
		const database = setup();
		upsertChat(database, {
			jid: 'empty@s.whatsapp.net',
			name: 'Empty',
			kind: '1:1',
			last_msg_at: 0,
			muted: false,
			archived: false
		});
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Never' }));

		const result = await draftChat({
			...options(database, { draft }),
			chatJid: 'empty@s.whatsapp.net'
		});

		expect(result).toEqual({ kind: 'not_needed' });
		expect(draft).not.toHaveBeenCalled();
	});
});

describe('draftChat — CAL-3 schedule digest', () => {
	function baseOptions(database: AppDatabase, provider: DraftProvider) {
		return {
			db: database,
			provider,
			providerName: 'fake',
			memory: new NullMemory() as Memory,
			chatJid: 'alice@s.whatsapp.net'
		};
	}

	it('injects the digest as a third input beside conversation and voice', async () => {
		const database = setup();
		let captured: DraftInput | undefined;
		const provider: DraftProvider = {
			draft: async (input: DraftInput) => {
				captured = input;
				return { kind: 'draft' as const, text: 'Thursday works.' };
			}
		};
		const digest: CalendarDigestSource = async () => ({
			text: 'Owner schedule for the next 7 days:\n- 2026-08-06 09:00–09:30 Standup',
			totalEvents: 1,
			renderedEvents: 1,
			truncated: false
		});

		await draftChat({ ...baseOptions(database, provider), calendarDigest: digest });

		expect(captured!.system).toContain('Owner schedule');
		expect(captured!.system).toContain('Standup');
		// The not-instruction framing is extended to calendar content.
		expect(captured!.system).toContain('not instructions to you');
	});

	it('degrades to drafting without a digest when the source throws (outage path)', async () => {
		const database = setup();
		const draft = vi.fn(async (_input: DraftInput) => ({ kind: 'draft' as const, text: 'Sure.' }));
		const throwingDigest: CalendarDigestSource = async () => {
			throw new Error('Google outage: 503');
		};

		const result = await draftChat({
			...baseOptions(database, { draft }),
			calendarDigest: throwingDigest
		});

		// Drafting must still produce a draft — a calendar outage never makes
		// the core loop unavailable (mirrors recallStyleFor's try/catch).
		expect(result.kind).toBe('ready');
		expect(draft).toHaveBeenCalledOnce();
		expect(draft.mock.calls[0]![0].system).not.toContain('Owner schedule');
	});

	it('degrades to drafting without a digest when the source returns null', async () => {
		const database = setup();
		const draft = vi.fn(async (_input: DraftInput) => ({ kind: 'draft' as const, text: 'Sure.' }));
		const nullDigest: CalendarDigestSource = async () => null;

		const result = await draftChat({
			...baseOptions(database, { draft }),
			calendarDigest: nullDigest
		});

		expect(result.kind).toBe('ready');
		expect(draft.mock.calls[0]![0].system).not.toContain('Owner schedule');
	});

	it('omits the schedule block entirely when no calendarDigest is wired', async () => {
		const database = setup();
		const draft = vi.fn(async (_input: DraftInput) => ({ kind: 'draft' as const, text: 'Sure.' }));

		await draftChat(baseOptions(database, { draft }));

		expect(draft.mock.calls[0]![0].system).not.toContain('Owner schedule');
	});
});
