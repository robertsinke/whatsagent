import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type DraftProvider } from '../providers/provider.js';
import { upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { createHeadlessDeps } from './headless.js';

const ALICE = 'alice@s.whatsapp.net';
const RETRY_AFTER_MS = 500;

let db: AppDatabase | undefined;
let dataDir: string | undefined;

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-headless-draft-'));
	db = openDatabase({ dataDir });
	upsertChat(db, {
		jid: ALICE,
		name: 'Alice',
		kind: '1:1',
		last_msg_at: 200
	});
	upsertMessage(db, {
		id: 'm1',
		chat_jid: ALICE,
		from_me: false,
		ts: 200,
		text: 'Are you free later?'
	});
	return db;
}

afterEach(() => {
	vi.useRealTimers();
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('headless generateDraft', () => {
	it('retries a provider rate limit so the draft row is not left deleted', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi
			.fn()
			.mockRejectedValueOnce(new ProviderError('rate_limit', 'wait', true, RETRY_AFTER_MS))
			.mockResolvedValueOnce({ kind: 'draft', text: 'After backoff' });
		const provider: DraftProvider = { draft };
		const deps = await createHeadlessDeps(database, dataDir!, { provider });

		expect(deps.generateDraft!(ALICE)).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(draft).toHaveBeenCalledOnce();
		// rate_limit deletes the row and returns, instead of throwing. Stopping
		// here is what used to leave the draft gone.
		expect(getDraft(database, ALICE)).toBeUndefined();

		await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
		expect(draft).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1);
		expect(draft).toHaveBeenCalledTimes(2);
		expect(getDraft(database, ALICE)).toMatchObject({
			status: 'ready',
			text: 'After backoff',
			basis_msg_id: 'm1'
		});
	});

	it.each(['approved', 'drafting'] as const)(
		'does not retry over a draft that is %s',
		async (status) => {
			vi.useFakeTimers();
			const database = setup();
			const draft = vi.fn(async () => {
				throw new ProviderError('rate_limit', 'wait', true, RETRY_AFTER_MS);
			});
			const provider: DraftProvider = { draft };
			const deps = await createHeadlessDeps(database, dataDir!, { provider });

			expect(deps.generateDraft!(ALICE)).toBe(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(draft).toHaveBeenCalledOnce();

			upsertDraft(database, {
				chat_jid: ALICE,
				text: 'Leave this row',
				original_text: 'Leave this row',
				status,
				basis_msg_id: 'm1',
				generated_at: 1
			});
			await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
			expect(draft).toHaveBeenCalledOnce();
			expect(getDraft(database, ALICE)).toMatchObject({
				status,
				text: 'Leave this row'
			});
		}
	);
});
