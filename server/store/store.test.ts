import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** Embedded migrations — the expected schema_version row count after a boot. */
function migrationCount(): number {
	return MIGRATIONS.length;
}
import { listChats, markChatRead, upsertChat, getLastReadMsgId } from './chats.js';
import { upsertContact, getContact } from './contacts.js';
import { openDatabase, type AppDatabase } from './db.js';
import { MIGRATIONS } from './migrations.generated.js';
import { getDraft, upsertDraft } from './drafts.js';
import {
	countMessages,
	listMessageReactions,
	listMessages,
	listMessagesPage,
	upsertMessage,
	upsertMessageReaction
} from './messages.js';
import { enqueueOutbox, listPendingOutbox } from './outbox.js';
import {
	getOutboxPacingSettings,
	getSetting,
	listEffectiveSettings,
	setSetting
} from './settings.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-store-'));
	db = openDatabase({ dataDir });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('migrations', () => {
	it('creates all domain tables on a fresh DB', () => {
		const database = openTempDb();
		const tables = database
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
			)
			.all() as { name: string }[];

		expect(tables.map((t) => t.name)).toEqual([
			'chats',
			'contacts',
			'draft_feedback',
			'drafts',
			'message_reactions',
			'messages',
			'outbox',
			'schema_version',
			'settings',
			'wa_auth_creds',
			'wa_auth_keys'
		]);
	});

	it('re-running migrations is a no-op', () => {
		const database = openTempDb();
		const versionBefore = (
			database.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
		).v;

		// Second open against the same file re-runs migrate at boot.
		database.close();
		db = openDatabase({ dataDir: dataDir! });
		const versionAfter = (
			db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }
		).v;
		const versionRows = (
			db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }
		).c;

		expect(versionAfter).toBe(versionBefore);
		// Derived, not hardcoded — every unit that adds a migration would otherwise
		// have to edit this assertion.
		expect(versionRows).toBe(migrationCount());
	});

	it('creates the DB file under the app-data dir with 0600 permissions', () => {
		openTempDb();
		const dbPath = join(dataDir!, 'whatsagent.db');
		const mode = statSync(dbPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it('preserves contact names across partial identity updates', () => {
		const database = openTempDb();
		upsertContact(database, {
			jid: 'alice@s.whatsapp.net',
			name: 'Alice',
			phone_jid: 'alice@s.whatsapp.net'
		});
		upsertContact(database, {
			jid: 'alice@s.whatsapp.net',
			lid_jid: '123@lid'
		});

		expect(getContact(database, 'alice@s.whatsapp.net')).toMatchObject({
			name: 'Alice',
			lid_jid: '123@lid',
			phone_jid: 'alice@s.whatsapp.net'
		});
	});
});

describe('chats + messages', () => {
	it('lists chats ordered by last_msg_at with unread counts', () => {
		const database = openTempDb();

		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			name: 'Alice',
			kind: '1:1',
			last_msg_at: 100,
			unread: 2,
			muted: false,
			archived: false
		});
		upsertChat(database, {
			jid: 'bob@s.whatsapp.net',
			channel: 'whatsapp',
			name: 'Bob',
			kind: '1:1',
			last_msg_at: 200,
			unread: 0,
			muted: true,
			archived: false
		});
		upsertChat(database, {
			jid: 'group@g.us',
			channel: 'whatsapp',
			name: 'Team',
			kind: 'group',
			last_msg_at: 150,
			unread: 5,
			muted: false,
			archived: true
		});

		upsertMessage(database, {
			id: 'm1',
			chat_jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			from_me: false,
			sender: 'alice@s.whatsapp.net',
			ts: 100,
			type: 'text',
			text: 'hi',
			media_ref: null,
			raw: null
		});
		upsertMessage(database, {
			id: 'm2',
			chat_jid: 'bob@s.whatsapp.net',
			channel: 'whatsapp',
			from_me: true,
			sender: null,
			ts: 200,
			type: 'text',
			text: 'hey',
			media_ref: null,
			raw: null
		});

		const chats = listChats(database);
		expect(chats.map((c) => c.jid)).toEqual([
			'bob@s.whatsapp.net',
			'group@g.us',
			'alice@s.whatsapp.net'
		]);
		expect(chats[0]?.unread).toBe(0);
		expect(chats[0]?.muted).toBe(true);
		expect(chats[1]?.archived).toBe(true);
		expect(chats[2]?.unread).toBe(2);
		expect(listMessages(database, 'alice@s.whatsapp.net')).toHaveLength(1);
	});

	it('message upsert with the same id twice stays a single row', () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			name: 'Alice',
			kind: '1:1',
			last_msg_at: 100,
			unread: 0,
			muted: false,
			archived: false
		});

		const payload = {
			id: 'same-id',
			chat_jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			from_me: false,
			sender: 'alice@s.whatsapp.net',
			ts: 100,
			type: 'text',
			text: 'first',
			media_ref: null,
			raw: '{"n":1}'
		} as const;

		upsertMessage(database, payload);
		upsertMessage(database, { ...payload, text: 'second', raw: '{"n":2}' });

		expect(countMessages(database)).toBe(1);
		expect(listMessages(database, 'alice@s.whatsapp.net')[0]?.text).toBe('second');
	});

	it('stores quote snapshots and replay-safe actor reactions before a target exists', () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: 'team@g.us',
			kind: 'group',
			last_msg_at: 100
		});
		upsertMessage(database, {
			id: 'reply',
			chat_jid: 'team@g.us',
			from_me: false,
			sender: 'alice@s.whatsapp.net',
			ts: 100,
			text: 'reply',
			quote_target_id: 'not-here-yet',
			quote_sender: 'bob@s.whatsapp.net',
			quote_type: 'image',
			quote_text: 'fallback caption'
		});

		upsertMessageReaction(database, {
			chat_jid: 'team@g.us',
			target_msg_id: 'not-here-yet',
			actor: 'alice@s.whatsapp.net',
			emoji: '👍',
			updated_at: 1
		});
		upsertMessageReaction(database, {
			chat_jid: 'team@g.us',
			target_msg_id: 'not-here-yet',
			actor: 'alice@s.whatsapp.net',
			emoji: '❤️',
			updated_at: 2
		});

		expect(listMessages(database, 'team@g.us')[0]).toMatchObject({
			quote_target_id: 'not-here-yet',
			quote_sender: 'bob@s.whatsapp.net',
			quote_type: 'image',
			quote_text: 'fallback caption'
		});
		expect(listMessageReactions(database, 'team@g.us', 'not-here-yet')).toEqual([
			expect.objectContaining({ actor: 'alice@s.whatsapp.net', emoji: '❤️' })
		]);

		upsertMessageReaction(database, {
			chat_jid: 'team@g.us',
			target_msg_id: 'not-here-yet',
			actor: 'alice@s.whatsapp.net',
			emoji: '',
			updated_at: 3
		});
		expect(listMessageReactions(database, 'team@g.us', 'not-here-yet')).toEqual([]);
	});
});

describe('listMessagesPage — centered on a target (U5)', () => {
	const JID = 'focus@s.whatsapp.net';

	function seedChain(database: AppDatabase, count: number): void {
		upsertChat(database, { jid: JID, kind: '1:1', last_msg_at: count });
		for (let i = 1; i <= count; i++) {
			upsertMessage(database, {
				id: `m${i}`,
				chat_jid: JID,
				from_me: i % 2 === 0,
				ts: i,
				text: `msg ${i}`
			});
		}
	}

	it('returns a page centered on the focus target with context on both sides', () => {
		const database = openTempDb();
		seedChain(database, 20);
		// limit 10 → half=5 → 5 older (m5–m9) + target + 5 newer (m11–m15).
		const page = listMessagesPage(database, JID, { limit: 10, focusMsgId: 'm10' });
		expect(page.map((m) => m.id)).toEqual([
			'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15'
		]);
	});

	it('clamps at the oldest end: fewer older rows, the page just shrinks on that side', () => {
		const database = openTempDb();
		seedChain(database, 20);
		// Target m2: only 1 older (m1) fits the half=5 older window, plus 5 newer.
		const page = listMessagesPage(database, JID, { limit: 10, focusMsgId: 'm2' });
		expect(page.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
	});

	it('clamps at the newest end: fewer newer rows, the page just shrinks on that side', () => {
		const database = openTempDb();
		seedChain(database, 20);
		// Target m19: 5 older + target + 1 newer (m20).
		const page = listMessagesPage(database, JID, { limit: 10, focusMsgId: 'm19' });
		expect(page.map((m) => m.id)).toEqual([
			'm14', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20'
		]);
	});

	it('returns just the target and its older context when it is the newest message', () => {
		const database = openTempDb();
		seedChain(database, 20);
		const page = listMessagesPage(database, JID, { limit: 10, focusMsgId: 'm20' });
		// m20 is newest: 5 older + target + 0 newer.
		expect(page.map((m) => m.id)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19', 'm20']);
	});

	it('returns an empty page for an unknown target (graceful, not a throw)', () => {
		const database = openTempDb();
		seedChain(database, 5);
		expect(listMessagesPage(database, JID, { limit: 10, focusMsgId: 'nope' })).toEqual([]);
	});

	it('returns an empty page when the target belongs to a different chat', () => {
		const database = openTempDb();
		seedChain(database, 5);
		upsertChat(database, { jid: 'other@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(database, {
			id: 'm10',
			chat_jid: 'other@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'other chat'
		});
		// m10 exists but in another chat — must not leak across the chat boundary.
		expect(listMessagesPage(database, JID, { limit: 10, focusMsgId: 'm10' })).toEqual([]);
	});

	it('orders oldest-first to match the caller contract the API relies on', () => {
		const database = openTempDb();
		seedChain(database, 20);
		const page = listMessagesPage(database, JID, { limit: 10, focusMsgId: 'm10' });
		const ts = page.map((m) => m.ts);
		expect(ts).toEqual([...ts].sort((a, b) => a - b));
	});
});

describe('drafts', () => {
	it('upsert replaces the prior draft for the same chat (one active draft)', () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			name: 'Alice',
			kind: '1:1',
			last_msg_at: null,
			unread: 0,
			muted: false,
			archived: false
		});

		upsertDraft(database, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'draft v1',
			status: 'drafted',
			generated_at: 1,
			provider: 'claude',
			basis_msg_id: 'm1'
		});
		upsertDraft(database, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'draft v2',
			status: 'drafted',
			generated_at: 2,
			provider: 'claude',
			basis_msg_id: 'm2'
		});

		const draftCount = (
			database.prepare('SELECT COUNT(*) AS c FROM drafts').get() as { c: number }
		).c;
		expect(draftCount).toBe(1);
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			text: 'draft v2',
			basis_msg_id: 'm2',
			generated_at: 2
		});
	});
});

describe('contacts, outbox, settings', () => {
	it('supports contact, outbox, and settings CRUD', () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			name: 'Alice',
			kind: '1:1',
			last_msg_at: null,
			unread: 0,
			muted: false,
			archived: false
		});

		upsertContact(database, {
			jid: 'alice@s.whatsapp.net',
			channel: 'whatsapp',
			name: 'Alice Smith',
			push_name: 'Ali'
		});
		expect(getContact(database, 'alice@s.whatsapp.net')?.push_name).toBe('Ali');

		const id = enqueueOutbox(database, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'queued hello',
			queued_at: 10,
			send_after: 20,
			status: 'pending'
		});
		expect(id).toBeGreaterThan(0);
		expect(listPendingOutbox(database)).toHaveLength(1);

		setSetting(database, 'provider', 'ollama');
		expect(getSetting(database, 'provider')).toBe('ollama');
		setSetting(database, 'provider', 'claude');
		expect(getSetting(database, 'provider')).toBe('claude');
	});
});

describe('permissions helper', () => {
	it('chmod on an existing file stays 0600 after reopen', () => {
		openTempDb();
		const dbPath = join(dataDir!, 'whatsagent.db');
		chmodSync(dbPath, 0o644);
		db!.close();
		db = openDatabase({ dataDir: dataDir! });
		expect(statSync(dbPath).mode & 0o777).toBe(0o600);
	});
});

describe('outbox pacing settings', () => {
	it('provides near-immediate effective defaults without persisting rows', () => {
		const database = openTempDb();

		expect(getOutboxPacingSettings(database)).toEqual({
			minSpacingMs: 0,
			maxSpacingMs: 1_000
		});
		expect(listEffectiveSettings(database)).toMatchObject({
			pacing_min_seconds: '0',
			pacing_max_seconds: '1'
		});
		expect(getSetting(database, 'pacing_min_seconds')).toBeUndefined();
	});

	it('normalizes invalid values and never puts the ceiling below the floor', () => {
		const database = openTempDb();
		setSetting(database, 'pacing_min_seconds', '2.5');
		setSetting(database, 'pacing_max_seconds', '-1');

		expect(getOutboxPacingSettings(database)).toEqual({
			minSpacingMs: 2_500,
			maxSpacingMs: 2_500
		});
		expect(listEffectiveSettings(database)).toMatchObject({
			pacing_min_seconds: '2.5',
			pacing_max_seconds: '2.5'
		});
	});
});

describe('read cursor (U4)', () => {
	it('starts null and advances to the latest message id when markChatRead runs', () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 300,
			unread: 3
		});
		upsertMessage(database, {
			id: 'm1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 100,
			text: 'hi'
		});
		upsertMessage(database, {
			id: 'm2',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 200,
			text: 'hello'
		});
		upsertMessage(database, {
			id: 'm3',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 300,
			text: 'ping'
		});

		expect(getLastReadMsgId(database, 'alice@s.whatsapp.net')).toBeNull();
		expect(markChatRead(database, 'alice@s.whatsapp.net')).toBe(true);

		// Cursor points at the latest message by ts/id ordering, and unread is zeroed.
		const chat = listChats(database).find((c) => c.jid === 'alice@s.whatsapp.net')!;
		expect(chat.last_read_msg_id).toBe('m3');
		expect(chat.unread).toBe(0);
		expect(getLastReadMsgId(database, 'alice@s.whatsapp.net')).toBe('m3');
	});

	it('survives a simulated restart — close and reopen the DB', () => {
		// Use a stable dataDir for this test only (afterEach clears it).
		const stableDir = mkdtempSync(join(tmpdir(), 'whatsagent-cursor-'));
		try {
			let db1 = openDatabase({ dataDir: stableDir });
			upsertChat(db1, { jid: 'bob@s.whatsapp.net', kind: '1:1', unread: 2 });
			upsertMessage(db1, {
				id: 'b1',
				chat_jid: 'bob@s.whatsapp.net',
				from_me: false,
				ts: 10,
				text: 'a'
			});
			upsertMessage(db1, {
				id: 'b2',
				chat_jid: 'bob@s.whatsapp.net',
				from_me: false,
				ts: 20,
				text: 'b'
			});
			markChatRead(db1, 'bob@s.whatsapp.net');
			db1.close();

			// Simulate a restart: reopen the same DB file.
			let db2 = openDatabase({ dataDir: stableDir });
			expect(getLastReadMsgId(db2, 'bob@s.whatsapp.net')).toBe('b2');
			expect(listChats(db2)[0]!.unread).toBe(0);
			db2.close();
		} finally {
			rmSync(stableDir, { recursive: true, force: true });
		}
	});
});
