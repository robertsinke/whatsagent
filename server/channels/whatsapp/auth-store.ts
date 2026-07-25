import {
	BufferJSON,
	initAuthCreds,
	proto,
	type AuthenticationCreds,
	type AuthenticationState,
	type SignalDataSet,
	type SignalDataTypeMap
} from 'baileys';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { AppDatabase } from '../../store/db.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEYCHAIN_SERVICE = 'whatsagent.whatsapp-auth';

type AuthRow = { blob: Buffer };

export type SqliteAuthStore = {
	state: AuthenticationState;
	saveCreds(): Promise<void>;
	clear(): Promise<void>;
};

function assertEncryptionKey(key: Buffer): void {
	if (key.byteLength !== KEY_BYTES) {
		throw new Error(`WhatsApp auth encryption key must be ${KEY_BYTES} bytes`);
	}
}

function encrypt(value: unknown, key: Buffer): Buffer {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt<T>(blob: Buffer, key: Buffer): T {
	if (blob.byteLength < IV_BYTES + TAG_BYTES) {
		throw new Error('Encrypted WhatsApp auth blob is truncated');
	}

	const iv = blob.subarray(0, IV_BYTES);
	const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	return JSON.parse(plaintext.toString('utf8'), BufferJSON.reviver) as T;
}

/** Load the auth master key from the macOS login keychain, creating it once if absent. */
export function loadKeychainEncryptionKey(
	service = KEYCHAIN_SERVICE,
	account = userInfo().username
): Buffer {
	if (process.platform !== 'darwin') {
		throw new Error('WhatsApp auth keychain storage currently requires macOS');
	}

	let encoded: string;
	try {
		encoded = execFileSync(
			'security',
			['find-generic-password', '-s', service, '-a', account, '-w'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		).trim();
	} catch {
		encoded = randomBytes(KEY_BYTES).toString('base64');
		execFileSync(
			'security',
			['add-generic-password', '-U', '-s', service, '-a', account, '-w', encoded],
			{ stdio: 'ignore' }
		);
	}

	const key = Buffer.from(encoded, 'base64');
	assertEncryptionKey(key);
	return key;
}

/** Baileys auth state persisted as independently encrypted SQLite rows. */
export function createSqliteAuthStore(db: AppDatabase, encryptionKey: Buffer): SqliteAuthStore {
	assertEncryptionKey(encryptionKey);

	const credsRow = db.prepare('SELECT blob FROM wa_auth_creds WHERE id = 1').get() as
		| AuthRow
		| undefined;
	const creds = credsRow
		? decrypt<AuthenticationCreds>(credsRow.blob, encryptionKey)
		: initAuthCreds();

	const getKeys = <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
		const result: { [id: string]: SignalDataTypeMap[T] } = {};
		const read = db.prepare('SELECT blob FROM wa_auth_keys WHERE type = ? AND id = ?');

		for (const id of ids) {
			const row = read.get(type, id) as AuthRow | undefined;
			if (!row) continue;
			let value = decrypt<SignalDataTypeMap[T]>(row.blob, encryptionKey);
			if (type === 'app-state-sync-key') {
				value = proto.Message.AppStateSyncKeyData.fromObject(
					value as unknown as Record<string, unknown>
				) as unknown as SignalDataTypeMap[T];
			}
			result[id] = value;
		}

		return result;
	};

	const setKeys = db.transaction((data: SignalDataSet) => {
		const write = db.prepare(
			`INSERT INTO wa_auth_keys (type, id, blob, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(type, id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`
		);
		const remove = db.prepare('DELETE FROM wa_auth_keys WHERE type = ? AND id = ?');
		const now = Date.now();

		for (const [type, entries] of Object.entries(data)) {
			if (!entries) continue;
			for (const [id, value] of Object.entries(entries)) {
				if (value === null) remove.run(type, id);
				else write.run(type, id, encrypt(value, encryptionKey), now);
			}
		}
	});

	const clear = db.transaction(() => {
		db.prepare('DELETE FROM wa_auth_keys').run();
		db.prepare('DELETE FROM wa_auth_creds').run();
	});

	const state: AuthenticationState = {
		creds,
		keys: {
			get: getKeys,
			set: async (data) => setKeys(data),
			clear: async () => clear()
		}
	};

	return {
		state,
		saveCreds: async () => {
			db.prepare(
				`INSERT INTO wa_auth_creds (id, blob, updated_at) VALUES (1, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`
			).run(encrypt(state.creds, encryptionKey), Date.now());
		},
		clear: async () => clear()
	};
}
