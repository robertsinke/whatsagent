/**
 * CAL-2 — confirm-gated calendar writes.
 *
 * Load-bearing assertions:
 * - proposal cap → 409
 * - approval-hash mismatch → 409
 * - double confirm → one Google PUT, not two
 * - reject → no PUT
 * - non-2xx PUT → owner-visible failure, row stays/reverts to pending (Odysseus)
 * - PUT Authorization uses decrypted password from getCalendarCredentials
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	calendarProposalApprovalText,
	hashApprovalText
} from '../../shared/approval-hash.js';
import { actionRegistry, dispatch } from '../actions/index.js';
import type { ActionDefinition } from '../actions/types.js';
import { MAX_PENDING_CALENDAR_PROPOSALS } from '../actions/propose-calendar-event.js';
import { createConfirmCalendarEventAction } from '../actions/confirm-calendar-event.js';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';
import {
	CALENDAR_PASSWORD_ENC_SETTING,
	getCalendarCredentials,
	saveCalendarCredentials
} from '../calendar/credentials.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import {
	getCalendarProposal,
	insertCalendarProposal,
	listPendingCalendarProposals
} from '../store/calendar-proposals.js';
import { upsertChat } from '../store/chats.js';

function confirmRegistry(
	action: ReturnType<typeof createConfirmCalendarEventAction>
): Map<string, ActionDefinition<unknown>> {
	return new Map([[action.name, action as ActionDefinition<unknown>]]);
}

let dataDir: string | undefined;
let db: AppDatabase | undefined;

const KEY = Buffer.alloc(32, 9);

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-cal2-'));
	db = openDatabase({ dataDir });
	return db;
}

function makeDeps(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	return {
		db: db!,
		events: new EventBus(),
		port: 8799,
		getConnectionStatus: () => ({ state: 'connected', qr: null }),
		...overrides
	};
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

function seedCreds(database: AppDatabase): void {
	saveCalendarCredentials(
		database,
		{
			serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
			email: 'owner@gmail.com',
			password: 'abcd efgh ijkl mnop'
		},
		KEY
	);
}

function seedProposal(
	database: AppDatabase,
	overrides: Partial<{
		summary: string;
		start: string;
		end: string;
		location: string | null;
	}> = {}
): number {
	return insertCalendarProposal(database, {
		summary: overrides.summary ?? 'Lunch',
		start: overrides.start ?? '2026-08-01T12:00:00.000Z',
		end: overrides.end ?? '2026-08-01T13:00:00.000Z',
		location: overrides.location ?? 'Cafe',
		now: Date.now()
	});
}

describe('propose-calendar-event', () => {
	it('returns pending_confirmation and creates no Google write', async () => {
		openTempDb();
		const puts: unknown[] = [];
		const deps = makeDeps({
			calendarFetch: async () => {
				puts.push('hit');
				return new Response('', { status: 500 });
			},
			calendarEncryptionKey: KEY
		});

		const result = await dispatch(
			actionRegistry,
			'propose-calendar-event',
			{
				summary: 'Standup',
				start: '2026-08-02T09:00:00.000Z',
				end: '2026-08-02T09:30:00.000Z'
			},
			{ caller: 'tool', deps }
		);

		expect(result).toMatchObject({
			kind: 'json',
			status: 202,
			body: { status: 'pending_confirmation' }
		});
		expect(puts).toHaveLength(0);
		expect(listPendingCalendarProposals(db!).length).toBe(1);
	});

	it('frontend caller is refused', async () => {
		openTempDb();
		const result = await dispatch(
			actionRegistry,
			'propose-calendar-event',
			{
				summary: 'X',
				start: '2026-08-02T09:00:00.000Z',
				end: '2026-08-02T09:30:00.000Z'
			},
			{ caller: 'frontend', deps: makeDeps() }
		);
		expect(result).toMatchObject({ kind: 'error', status: 403 });
	});

	it('pending cap returns 409', async () => {
		openTempDb();
		const deps = makeDeps();
		for (let i = 0; i < MAX_PENDING_CALENDAR_PROPOSALS; i++) {
			seedProposal(db!, { summary: `Event ${i}` });
		}
		const result = await dispatch(
			actionRegistry,
			'propose-calendar-event',
			{
				summary: 'Overflow',
				start: '2026-08-02T09:00:00.000Z',
				end: '2026-08-02T09:30:00.000Z'
			},
			{ caller: 'tool', deps }
		);
		expect(result).toMatchObject({ kind: 'error', status: 409 });
		expect(listPendingCalendarProposals(db!).length).toBe(MAX_PENDING_CALENDAR_PROPOSALS);
	});
});

describe('confirm-calendar-event', () => {
	it('approval-hash mismatch returns 409 and does not PUT', async () => {
		openTempDb();
		seedCreds(db!);
		const id = seedProposal(db!);
		const puts: string[] = [];
		const action = createConfirmCalendarEventAction({
			encryptionKey: KEY,
			fetch: async (url) => {
				puts.push(String(url));
				return new Response('', { status: 201 });
			}
		});
		const registry = confirmRegistry(action);
		const result = await dispatch(registry, 'confirm-calendar-event', {
			id,
			base_hash: 'deadbeef'
		}, { caller: 'frontend', deps: makeDeps({ calendarEncryptionKey: KEY }) });

		expect(result).toMatchObject({
			kind: 'error',
			status: 409,
			extra: { conflict: 'text-changed' }
		});
		expect(puts).toHaveLength(0);
		expect(getCalendarProposal(db!, id)?.status).toBe('pending');
	});

	it('tool caller is refused', async () => {
		openTempDb();
		const id = seedProposal(db!);
		const result = await dispatch(
			actionRegistry,
			'confirm-calendar-event',
			{ id, base_hash: 'x' },
			{ caller: 'tool', deps: makeDeps() }
		);
		expect(result).toMatchObject({ kind: 'error', status: 403 });
	});

	it('successful PUT writes google_event_id and uses decrypted password', async () => {
		openTempDb();
		seedCreds(db!);
		const id = seedProposal(db!);
		const proposal = getCalendarProposal(db!, id)!;
		const authHeaders: string[] = [];
		const bodies: string[] = [];

		const enc = db!
			.prepare('SELECT value FROM settings WHERE key = ?')
			.get(CALENDAR_PASSWORD_ENC_SETTING) as { value: string };
		expect(enc.value).not.toContain('ijkl');

		const action = createConfirmCalendarEventAction({
			encryptionKey: KEY,
			newUid: () => 'fixed-uid',
			fetch: async (_url, init) => {
				authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
				bodies.push(String(init?.body ?? ''));
				return new Response('', { status: 201 });
			}
		});
		const registry = confirmRegistry(action);
		const result = await dispatch(
			registry,
			'confirm-calendar-event',
			{ id, base_hash: hashApprovalText(calendarProposalApprovalText(proposal)) },
			{ caller: 'frontend', deps: makeDeps({ calendarEncryptionKey: KEY }) }
		);

		expect(result).toMatchObject({
			kind: 'json',
			status: 200,
			body: { google_event_id: 'fixed-uid@whatsagent.local' }
		});
		const confirmed = getCalendarProposal(db!, id)!;
		expect(confirmed.status).toBe('confirmed');
		expect(confirmed.google_event_id).toBe('fixed-uid@whatsagent.local');

		const expectedAuth =
			'Basic ' + Buffer.from('owner@gmail.com:abcd efgh ijkl mnop', 'utf8').toString('base64');
		expect(authHeaders[0]).toBe(expectedAuth);
		expect(bodies[0]).toContain('BEGIN:VEVENT');
		expect(bodies[0]).toContain('SUMMARY:Lunch');
		// Ciphertext still in settings; password only via getCalendarCredentials.
		expect(getCalendarCredentials(db!, KEY)?.password).toBe('abcd efgh ijkl mnop');
	});

	it('non-2xx PUT surfaces failure and leaves no confirmed local success', async () => {
		openTempDb();
		seedCreds(db!);
		const id = seedProposal(db!);
		const proposal = getCalendarProposal(db!, id)!;
		const action = createConfirmCalendarEventAction({
			encryptionKey: KEY,
			newUid: () => 'fail-uid',
			fetch: async () => new Response('unauthorized', { status: 401 })
		});
		const registry = confirmRegistry(action);
		const result = await dispatch(
			registry,
			'confirm-calendar-event',
			{ id, base_hash: hashApprovalText(calendarProposalApprovalText(proposal)) },
			{ caller: 'frontend', deps: makeDeps({ calendarEncryptionKey: KEY }) }
		);

		expect(result).toMatchObject({ kind: 'error', status: 502 });
		const row = getCalendarProposal(db!, id)!;
		expect(row.status).toBe('pending');
		expect(row.google_event_id).toBeNull();
	});

	it('double confirm writes one Google event not two', async () => {
		openTempDb();
		seedCreds(db!);
		const id = seedProposal(db!);
		const proposal = getCalendarProposal(db!, id)!;
		const hash = hashApprovalText(calendarProposalApprovalText(proposal));
		let puts = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});

		const action = createConfirmCalendarEventAction({
			encryptionKey: KEY,
			newUid: () => 'once-uid',
			fetch: async () => {
				puts += 1;
				await gate;
				return new Response('', { status: 201 });
			}
		});
		const registry = confirmRegistry(action);
		const deps = makeDeps({ calendarEncryptionKey: KEY });

		const first = dispatch(registry, 'confirm-calendar-event', { id, base_hash: hash }, {
			caller: 'frontend',
			deps
		});
		// Let the first claim land before the second starts.
		await new Promise((r) => setTimeout(r, 20));
		const second = await dispatch(
			registry,
			'confirm-calendar-event',
			{ id, base_hash: hash },
			{ caller: 'frontend', deps }
		);
		release();
		const firstResult = await first;

		expect(firstResult).toMatchObject({ kind: 'json', status: 200 });
		expect(second).toMatchObject({ kind: 'error', status: 409 });
		expect(puts).toBe(1);
	});
});

describe('reject-calendar-event', () => {
	it('leaves no Google event (no PUT) and flips status', async () => {
		openTempDb();
		seedCreds(db!);
		const id = seedProposal(db!);
		let puts = 0;
		const deps = makeDeps({
			calendarEncryptionKey: KEY,
			calendarFetch: async () => {
				puts += 1;
				return new Response('', { status: 201 });
			}
		});

		const result = await dispatch(
			actionRegistry,
			'reject-calendar-event',
			{ id },
			{ caller: 'frontend', deps }
		);
		expect(result).toMatchObject({ kind: 'json', status: 200 });
		expect(getCalendarProposal(db!, id)?.status).toBe('rejected');
		expect(puts).toBe(0);
	});
});

describe('calendar_proposals chat_jid is optional', () => {
	it('accepts a proposal with no chat and with a chat', async () => {
		openTempDb();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: Date.now()
		});
		const a = await dispatch(
			actionRegistry,
			'propose-calendar-event',
			{
				summary: 'Solo lunch',
				start: '2026-08-02T12:00:00.000Z',
				end: '2026-08-02T13:00:00.000Z'
			},
			{ caller: 'tool', deps: makeDeps() }
		);
		const b = await dispatch(
			actionRegistry,
			'propose-calendar-event',
			{
				summary: 'From chat',
				start: '2026-08-02T14:00:00.000Z',
				end: '2026-08-02T15:00:00.000Z',
				chatJid: 'alice@s.whatsapp.net'
			},
			{ caller: 'tool', deps: makeDeps() }
		);
		expect(a).toMatchObject({ kind: 'json', status: 202 });
		expect(b).toMatchObject({ kind: 'json', status: 202 });
		const pending = listPendingCalendarProposals(db!);
		expect(pending.some((p) => p.chat_jid === null)).toBe(true);
		expect(pending.some((p) => p.chat_jid === 'alice@s.whatsapp.net')).toBe(true);
	});
});
