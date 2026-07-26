import { BufferJSON, DisconnectReason, initAuthCreds, type UserFacingSocketConfig } from 'baileys';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertChat } from '../../store/chats.js';
import { getContact, upsertContact } from '../../store/contacts.js';
import { openDatabase, type AppDatabase } from '../../store/db.js';
import { upsertMessage } from '../../store/messages.js';
import type { ChannelEvent } from '../channel.js';
import { createSqliteAuthStore, type SqliteAuthStore } from './auth-store.js';
import {
	WA_WEB_VERSION_FALLBACK,
	WhatsAppConnection,
	resolveWhatsAppWebVersion,
	type SocketFactory,
	type WhatsAppSocket
} from './connection.js';

class FakeSocket implements WhatsAppSocket {
	readonly handlers = new Map<string, ((...args: any[]) => void)[]>();
	readonly end = vi.fn();
	readonly ev = {
		on: (event: string, handler: (...args: any[]) => void) => {
			const handlers = this.handlers.get(event) ?? [];
			handlers.push(handler);
			this.handlers.set(event, handlers);
		}
	};

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-wa-connection-'));
	db = openDatabase({ dataDir });
	return db;
}

function fakeSocketFactory() {
	const sockets: FakeSocket[] = [];
	const configs: UserFacingSocketConfig[] = [];
	const factory: SocketFactory = (config) => {
		configs.push(config);
		const socket = new FakeSocket();
		sockets.push(socket);
		return socket;
	};
	return { factory, sockets, configs };
}

afterEach(() => {
	vi.useRealTimers();
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('WhatsApp connection', () => {
	it('emits pairing and connection states, reconnecting only when not logged out', async () => {
		vi.useFakeTimers();
		const database = openTempDb();
		const authStore = createSqliteAuthStore(database, Buffer.alloc(32, 1));
		const fake = fakeSocketFactory();
		const connection = new WhatsAppConnection(database, {
			authStore,
			socketFactory: fake.factory,
			waVersion: WA_WEB_VERSION_FALLBACK,
			reconnectDelayMs: 10
		});
		const events: ChannelEvent[] = [];
		connection.onEvent((event) => events.push(event));

		await connection.start();
		expect(fake.sockets).toHaveLength(1);
		fake.sockets[0]!.emit('connection.update', { connection: 'connecting', qr: 'qr-payload' });
		fake.sockets[0]!.emit('connection.update', { connection: 'open' });
		fake.sockets[0]!.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } }
		});

		await vi.advanceTimersByTimeAsync(10);
		expect(fake.sockets).toHaveLength(2);
		fake.sockets[1]!.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } }
		});
		await vi.advanceTimersByTimeAsync(100);

		expect(fake.sockets).toHaveLength(2);
		expect(events).toEqual([
			{ type: 'connection', state: 'connecting' },
			{ type: 'pairing-needed', qr: 'qr-payload' },
			{ type: 'connection', state: 'connected' },
			{ type: 'connection', state: 'disconnected' },
			{ type: 'connection', state: 'connecting' },
			{ type: 'connection', state: 'disconnected' },
			// Terminal signal the transport enum can't express — drives D5's `logged_out`.
			{ type: 'logged-out' }
		]);
	});

	it('surfaces a credentials write failure as a fatal channel error', async () => {
		const database = openTempDb();
		const baseStore = createSqliteAuthStore(database, Buffer.alloc(32, 2));
		const writeError = new Error('disk write failed');
		const authStore: SqliteAuthStore = {
			state: baseStore.state,
			saveCreds: vi.fn().mockRejectedValue(writeError),
			clear: baseStore.clear
		};
		const fake = fakeSocketFactory();
		const onError = vi.fn();
		const connection = new WhatsAppConnection(database, {
			authStore,
			socketFactory: fake.factory,
			waVersion: WA_WEB_VERSION_FALLBACK,
			onError
		});
		const events: ChannelEvent[] = [];
		connection.onEvent((event) => events.push(event));
		await connection.start();

		fake.sockets[0]!.emit('creds.update', { registered: true });
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(writeError));

		expect(events.at(-1)).toEqual({ type: 'error', error: writeError, fatal: true });
	});

	it('configures the desktop socket and retrieves stored messages by key', async () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			name: 'Alice',
			kind: '1:1',
			last_msg_at: 1,
			unread: 0,
			muted: false,
			archived: false
		});
		upsertMessage(database, {
			id: 'stored-id',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 1,
			raw: JSON.stringify(
				{
					key: { id: 'stored-id', remoteJid: 'alice@s.whatsapp.net' },
					message: { conversation: 'stored hello' }
				},
				BufferJSON.replacer
			)
		});

		const fake = fakeSocketFactory();
		const connection = new WhatsAppConnection(database, {
			authStore: {
				state: {
					creds: initAuthCreds(),
					keys: { get: async () => ({}), set: async () => undefined }
				},
				saveCreds: async () => undefined,
				clear: async () => undefined
			},
			socketFactory: fake.factory,
			waVersion: WA_WEB_VERSION_FALLBACK
		});
		await connection.start();

		const config = fake.configs[0]!;
		expect(config.browser).toEqual(['Mac OS', 'Desktop', '14.4.1']);
		expect(config.version).toEqual(WA_WEB_VERSION_FALLBACK);
		expect(config.syncFullHistory).toBe(true);
		expect(
			await config.getMessage?.({ id: 'stored-id', remoteJid: 'alice@s.whatsapp.net' })
		).toMatchObject({ conversation: 'stored hello' });
		expect(await config.getMessage?.({ id: 'missing' })).toBeUndefined();
	});

	it('backfills encrypted LID mappings into contact aliases before connecting', async () => {
		const database = openTempDb();
		const authStore = createSqliteAuthStore(database, Buffer.alloc(32, 4));
		await authStore.state.keys.set({
			'lid-mapping': {
				'203663104602149_reverse': '31683799485'
			}
		});
		upsertContact(database, {
			jid: '31683799485@s.whatsapp.net',
			name: 'Robert'
		});
		const fake = fakeSocketFactory();
		const connection = new WhatsAppConnection(database, {
			authStore,
			socketFactory: fake.factory,
			waVersion: WA_WEB_VERSION_FALLBACK
		});

		await connection.start();

		expect(getContact(database, '203663104602149@lid')).toMatchObject({
			name: 'Robert',
			lid_jid: '203663104602149@lid',
			phone_jid: '31683799485@s.whatsapp.net'
		});
		expect(fake.sockets).toHaveLength(1);
	});

	it('resetAuth clears stored credentials and hands the socket a fresh session', async () => {
		const database = openTempDb();
		const key = Buffer.alloc(32, 7);
		const fake = fakeSocketFactory();
		const connection = new WhatsAppConnection(database, {
			// Factory, not a fixed instance: a reset must re-read the emptied tables.
			createAuthStore: () => createSqliteAuthStore(database, key),
			socketFactory: fake.factory,
			waVersion: WA_WEB_VERSION_FALLBACK
		});

		await connection.start();
		const store = createSqliteAuthStore(database, key);
		await store.saveCreds();
		await store.state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(4) } } } as never);
		expect(
			(database.prepare('SELECT COUNT(*) AS c FROM wa_auth_creds').get() as { c: number }).c
		).toBe(1);

		// After `logged-out` the stored session is dead — re-pairing must forget it.
		await connection.resetAuth();

		expect(
			(database.prepare('SELECT COUNT(*) AS c FROM wa_auth_creds').get() as { c: number }).c
		).toBe(0);
		expect(
			(database.prepare('SELECT COUNT(*) AS c FROM wa_auth_keys').get() as { c: number }).c
		).toBe(0);

		await connection.start();
		const before = fake.configs[0]!.auth.creds.registrationId;
		const after = fake.configs.at(-1)!.auth.creds.registrationId;
		expect(fake.configs).toHaveLength(2);
		// A rebuilt store means `initAuthCreds()`, not the cleared-but-cached object.
		expect(after).not.toBe(before);
	});

	it('backs off repeated reconnects and resets the delay after pairing resumes', async () => {
		vi.useFakeTimers();
		const database = openTempDb();
		const fake = fakeSocketFactory();
		const connection = new WhatsAppConnection(database, {
			authStore: createSqliteAuthStore(database, Buffer.alloc(32, 3)),
			socketFactory: fake.factory,
			waVersion: WA_WEB_VERSION_FALLBACK,
			reconnectDelayMs: 10,
			maxReconnectDelayMs: 40
		});

		await connection.start();
		fake.sockets[0]!.emit('connection.update', { connection: 'close' });

		await vi.advanceTimersByTimeAsync(9);
		expect(fake.sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.sockets).toHaveLength(2);

		fake.sockets[1]!.emit('connection.update', { connection: 'close' });
		await vi.advanceTimersByTimeAsync(19);
		expect(fake.sockets).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.sockets).toHaveLength(3);

		fake.sockets[2]!.emit('connection.update', { connection: 'close' });
		await vi.advanceTimersByTimeAsync(40);
		expect(fake.sockets).toHaveLength(4);

		fake.sockets[3]!.emit('connection.update', { qr: 'fresh-qr' });
		fake.sockets[3]!.emit('connection.update', { connection: 'close' });
		await vi.advanceTimersByTimeAsync(10);
		expect(fake.sockets).toHaveLength(5);
	});

	it('uses the live WhatsApp Web version and falls back when lookup fails', async () => {
		const live: [number, number, number] = [2, 3000, 9999999999];
		await expect(
			resolveWhatsAppWebVersion(async () => ({ version: live }))
		).resolves.toEqual(live);
		await expect(
			resolveWhatsAppWebVersion(async () => ({
				version: [0, 0, 0],
				error: new Error('offline')
			}))
		).resolves.toEqual(WA_WEB_VERSION_FALLBACK);
		await expect(
			resolveWhatsAppWebVersion(async () => {
				throw new Error('offline');
			})
		).resolves.toEqual(WA_WEB_VERSION_FALLBACK);
	});
});
