import { BufferJSON, DisconnectReason, initAuthCreds, type UserFacingSocketConfig } from 'baileys';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertChat } from '../../store/chats.js';
import { openDatabase, type AppDatabase } from '../../store/db.js';
import { upsertMessage } from '../../store/messages.js';
import type { ChannelEvent } from '../channel.js';
import { createSqliteAuthStore, type SqliteAuthStore } from './auth-store.js';
import {
	WhatsAppConnection,
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
			{ type: 'connection', state: 'disconnected' }
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
			socketFactory: fake.factory
		});
		await connection.start();

		const config = fake.configs[0]!;
		expect(config.browser).toEqual(['Mac OS', 'Desktop', '14.4.1']);
		expect(config.syncFullHistory).toBe(true);
		expect(
			await config.getMessage?.({ id: 'stored-id', remoteJid: 'alice@s.whatsapp.net' })
		).toMatchObject({ conversation: 'stored hello' });
		expect(await config.getMessage?.({ id: 'missing' })).toBeUndefined();
	});
});
