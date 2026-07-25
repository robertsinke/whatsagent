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
			{ role: 'assistant', content: 'Ja, klinkt goed.' },
			{ role: 'user', content: 'Zullen we om zeven uur afspreken?' }
		]);
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
