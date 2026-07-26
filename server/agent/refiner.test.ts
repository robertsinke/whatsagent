import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import { listDraftFeedback } from '../store/draft-feedback.js';
import { upsertMessage } from '../store/messages.js';
import { listOutbox } from '../store/outbox.js';
import { ProviderError, type DraftInput, type DraftProvider } from '../providers/provider.js';
import { refineDraft } from './refiner.js';

let db: AppDatabase | undefined;
let dataDir: string | undefined;

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-refiner-'));
	db = openDatabase({ dataDir });
	upsertChat(db, {
		jid: 'alice@s.whatsapp.net',
		name: 'Alice',
		kind: '1:1',
		last_msg_at: 200
	});
	upsertMessage(db, {
		id: 'm1',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: true,
		ts: 100,
		text: 'Sounds good.'
	});
	upsertMessage(db, {
		id: 'm2',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: false,
		ts: 200,
		text: 'Can we meet at seven?'
	});
	upsertDraft(db, {
		chat_jid: 'alice@s.whatsapp.net',
		text: 'Yes, seven works for me.',
		status: 'ready',
		generated_at: 250,
		provider: 'fake',
		basis_msg_id: 'm2'
	});
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('refineDraft', () => {
	it.each([
		['shorter', 'Seven works.'],
		['longer', 'Yes, meeting at seven works well for me.'],
		['more_formal', 'Yes, seven o clock would suit me.'],
		['less_formal', 'Yep, seven works!']
	] as const)('applies %s to the submitted preview while retaining its basis', async (intent, text) => {
		const database = setup();
		const draft = vi.fn(async (_input: DraftInput) => ({ kind: 'draft' as const, text }));

		const result = await refineDraft(
			{ db: database, provider: { draft }, providerName: 'fake', now: () => 300 },
			{ chatJid: 'alice@s.whatsapp.net', intent, preview: 'Owner-edited preview' }
		);

		expect(result).toMatchObject({ kind: 'ready', draft: { text, basis_msg_id: 'm2' } });
		expect(draft.mock.calls[0]![0].system).toContain('Owner-edited preview');
		expect(draft.mock.calls[0]![0].system).toContain('never return no_reply_needed');
		expect(draft.mock.calls[0]![0].conversation.at(-1)).toEqual({
			role: 'user',
			content: 'Can we meet at seven?'
		});
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			text,
			original_text: text,
			basis_msg_id: 'm2'
		});
		expect(listOutbox(database)).toEqual([]);
		expect(listDraftFeedback(database, 'alice@s.whatsapp.net')).toEqual([]);
	});

	it('regenerates from current history and advances to the latest inbound basis', async () => {
		const database = setup();
		upsertMessage(database, {
			id: 'm3',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 300,
			text: 'Actually, can we make it eight?'
		});
		const draft = vi.fn(async (_input: DraftInput) => ({
			kind: 'draft' as const,
			text: 'Eight works too.'
		}));

		const result = await refineDraft(
			{ db: database, provider: { draft }, providerName: 'fake', now: () => 400 },
			{ chatJid: 'alice@s.whatsapp.net', intent: 'regenerate' }
		);

		expect(result).toMatchObject({
			kind: 'ready',
			draft: { text: 'Eight works too.', basis_msg_id: 'm3', status: 'ready' }
		});
		expect(draft.mock.calls[0]![0].conversation.at(-1)?.content).toBe(
			'Actually, can we make it eight?'
		);
	});

	it.each(['newer inbound context', 'a replacement draft'] as const)(
		'does not overwrite the active draft after %s arrives',
		async (change) => {
			const database = setup();
			let resolve!: (value: { kind: 'draft'; text: string }) => void;
			const provider: DraftProvider = { draft: () => new Promise((done) => (resolve = done)) };
			const attempt = refineDraft(
				{ db: database, provider, providerName: 'fake' },
				{ chatJid: 'alice@s.whatsapp.net', intent: 'shorter' }
			);
			await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
			if (change === 'newer inbound context') {
				upsertMessage(database, {
					id: 'm3',
					chat_jid: 'alice@s.whatsapp.net',
					from_me: false,
					ts: 300,
					text: 'New context'
				});
			} else {
				upsertDraft(database, {
					chat_jid: 'alice@s.whatsapp.net',
					text: 'Replacement draft',
					status: 'ready',
					generated_at: 301,
					provider: 'other',
					basis_msg_id: 'm2'
				});
			}
			resolve({ kind: 'draft', text: 'Late result' });

			await expect(attempt).resolves.toEqual({ kind: 'superseded' });
			expect(getDraft(database, 'alice@s.whatsapp.net')?.text).toBe(
				change === 'a replacement draft' ? 'Replacement draft' : 'Yes, seven works for me.'
			);
		}
	);

	it.each([
		new ProviderError('timeout', 'Timed out'),
		new ProviderError('unavailable', 'Unavailable'),
		undefined
	])('preserves the active draft when the provider fails or returns an invalid verdict', async (failure) => {
		const database = setup();
		const provider: DraftProvider = {
			draft: async () => {
				if (failure) throw failure;
				return { kind: 'no_reply_needed', reason: 'Invalid for refinement' };
			}
		};
		const before = getDraft(database, 'alice@s.whatsapp.net');

		const result = await refineDraft(
			{ db: database, provider, providerName: 'fake' },
			{ chatJid: 'alice@s.whatsapp.net', intent: 'shorter' }
		);

		expect(result.kind).toBe('failed');
		expect(getDraft(database, 'alice@s.whatsapp.net')).toEqual(before);
		expect(listOutbox(database)).toEqual([]);
		expect(listDraftFeedback(database, 'alice@s.whatsapp.net')).toEqual([]);
	});
});
