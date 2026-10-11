import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type DraftProvider, type DraftResult } from '../providers/provider.js';
import { upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft, type Draft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { MCP_ENABLED_SETTING, setSetting } from '../store/settings.js';
import { createHeadlessDeps, headlessStillEnabled, releaseHeadlessDatabase } from './headless.js';

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
	if (db?.open) db.close();
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

	it('does not start a second chain while the rate-limit sleep still holds the chat', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi
			.fn()
			.mockRejectedValueOnce(new ProviderError('rate_limit', 'wait', true, RETRY_AFTER_MS))
			.mockResolvedValueOnce({ kind: 'draft', text: 'From the first chain' });
		const provider: DraftProvider = { draft };
		const deps = await createHeadlessDeps(database, dataDir!, { provider });

		expect(deps.generateDraft!(ALICE)).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(getDraft(database, ALICE)).toBeUndefined();

		// The row is gone, so the approved-or-drafting guard would accept this.
		// The sleeper is the chain, and a second loop must not start.
		expect(deps.generateDraft!(ALICE)).toBe(false);

		await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
		expect(draft).toHaveBeenCalledTimes(2);
		expect(getDraft(database, ALICE)).toMatchObject({
			status: 'ready',
			text: 'From the first chain'
		});
	});

	it('finishes the draft before closing the database while the provider is still pending', async () => {
		const database = setup();
		const pending = hang();
		const provider: DraftProvider = { draft: pending.draft };
		const deps = await createHeadlessDeps(database, dataDir!, { provider });

		expect(deps.generateDraft!(ALICE)).toBe(true);
		await vi.waitFor(() => expect(pending.draft).toHaveBeenCalledOnce());
		expect(getDraft(database, ALICE)?.status).toBe('drafting');
		expect(deps.generateDraft!(ALICE)).toBe(false);

		const closing = releaseHeadlessDatabase(database);
		expect(database.open).toBe(true);
		expect(getDraft(database, ALICE)?.status).toBe('drafting');

		pending.resolve({ kind: 'draft', text: 'Landed before close' });
		await closing;

		expect(readDraft()).toMatchObject({ status: 'ready', text: 'Landed before close' });
	});

	it('finishes the draft when mcp_enabled flips off while the provider is still pending', async () => {
		const database = setup();
		setSetting(database, MCP_ENABLED_SETTING, 'true');
		const pending = hang();
		const provider: DraftProvider = { draft: pending.draft };
		const deps = await createHeadlessDeps(database, dataDir!, { provider });

		expect(deps.generateDraft!(ALICE)).toBe(true);
		await vi.waitFor(() => expect(pending.draft).toHaveBeenCalledOnce());
		expect(getDraft(database, ALICE)?.status).toBe('drafting');

		setSetting(database, MCP_ENABLED_SETTING, 'false');
		const decision = headlessStillEnabled(database);
		expect(database.open).toBe(true);
		expect(getDraft(database, ALICE)?.status).toBe('drafting');

		pending.resolve({ kind: 'draft', text: 'Landed before the switch closed it' });
		expect(await decision).toBe(false);

		expect(readDraft()).toMatchObject({
			status: 'ready',
			text: 'Landed before the switch closed it'
		});
	});

	it('does not leave the row drafting when a write hits an already-closed database', async () => {
		const database = setup();
		const pending = hang();
		const provider: DraftProvider = { draft: pending.draft };
		const deps = await createHeadlessDeps(database, dataDir!, { provider });

		expect(deps.generateDraft!(ALICE)).toBe(true);
		await vi.waitFor(() => expect(pending.draft).toHaveBeenCalledOnce());
		expect(getDraft(database, ALICE)?.status).toBe('drafting');

		database.close();
		pending.resolve({ kind: 'draft', text: 'too late' });
		await releaseHeadlessDatabase(database);

		const row = readDraft();
		expect(row?.status).not.toBe('drafting');
		expect(row).toMatchObject({ status: 'failed', error_code: 'unavailable' });
	});
});

function hang(): { draft: DraftProvider['draft']; resolve: (result: DraftResult) => void } {
	let resolve: (result: DraftResult) => void = () => {};
	const gate = new Promise<DraftResult>((settle) => {
		resolve = settle;
	});
	const draft = vi.fn<DraftProvider['draft']>(() => gate);
	return { draft, resolve };
}

function readDraft(): Draft | undefined {
	const reader = openDatabase({ dataDir: dataDir!, migrate: false });
	try {
		return getDraft(reader, ALICE);
	} finally {
		reader.close();
	}
}
