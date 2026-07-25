import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../../store/db.js';
import { createSqliteAuthStore } from './auth-store.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-wa-auth-'));
	db = openDatabase({ dataDir });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('SQLite WhatsApp auth store', () => {
	it('roundtrips credentials and signal keys through encrypted rows', async () => {
		const database = openTempDb();
		const encryptionKey = Buffer.alloc(32, 7);
		const store = createSqliteAuthStore(database, encryptionKey);

		store.state.creds.registered = true;
		store.state.creds.advSecretKey = 'account-hijack-secret';
		await store.saveCreds();
		await store.state.keys.set({
			'pre-key': {
				'17': {
					public: Buffer.from([1, 2, 3]),
					private: Buffer.from([4, 5, 6])
				}
			},
			session: { 'alice.0': Buffer.from([9, 8, 7]) }
		});

		const credsBlob = database
			.prepare('SELECT blob FROM wa_auth_creds WHERE id = 1')
			.get() as { blob: Buffer };
		expect(credsBlob.blob.toString('utf8')).not.toContain('account-hijack-secret');

		const reopened = createSqliteAuthStore(database, encryptionKey);
		expect(reopened.state.creds).toEqual(store.state.creds);
		expect(await reopened.state.keys.get('pre-key', ['17', 'missing'])).toEqual({
			'17': {
				public: Buffer.from([1, 2, 3]),
				private: Buffer.from([4, 5, 6])
			}
		});
		expect(await reopened.state.keys.get('session', ['alice.0'])).toEqual({
			'alice.0': Buffer.from([9, 8, 7])
		});
	});

	it('removes null signal keys and clears all auth state', async () => {
		const database = openTempDb();
		const store = createSqliteAuthStore(database, Buffer.alloc(32, 3));
		await store.saveCreds();
		await store.state.keys.set({ session: { old: Uint8Array.from([1]) } });
		await store.state.keys.set({ session: { old: null } });

		expect(await store.state.keys.get('session', ['old'])).toEqual({});
		await store.clear();
		expect(
			(database.prepare('SELECT COUNT(*) AS count FROM wa_auth_creds').get() as { count: number })
				.count
		).toBe(0);
		expect(
			(database.prepare('SELECT COUNT(*) AS count FROM wa_auth_keys').get() as { count: number })
				.count
		).toBe(0);
	});

	it('fails loudly when encrypted auth cannot be decrypted', async () => {
		const database = openTempDb();
		const store = createSqliteAuthStore(database, Buffer.alloc(32, 1));
		await store.saveCreds();

		expect(() => createSqliteAuthStore(database, Buffer.alloc(32, 2))).toThrow();
	});
});
