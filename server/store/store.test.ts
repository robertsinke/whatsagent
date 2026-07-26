import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** Migrations on disk — the expected schema_version row count after a boot. */
function migrationFileCount(): number {
	const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
	return readdirSync(dir).filter((name) => /^\d+.*\.sql$/.test(name)).length;
}
import { listChats, upsertChat } from './chats.js';
import { upsertContact, getContact } from './contacts.js';
import { openDatabase, type AppDatabase } from './db.js';
import { getDraft, upsertDraft } from './drafts.js';
import { countMessages, listMessages, upsertMessage } from './messages.js';
import { enqueueOutbox, listPendingOutbox } from './outbox.js';
import { getSetting, setSetting } from './settings.js';

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
		expect(versionRows).toBe(migrationFileCount());
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
