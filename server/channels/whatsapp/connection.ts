import makeWASocket, {
	Browsers,
	BufferJSON,
	DisconnectReason,
	fetchLatestWaWebVersion,
	type GroupMetadata,
	type UserFacingSocketConfig,
	type WAMessage,
	type WAMessageKey,
	type WAVersion
} from 'baileys';
import type { AppDatabase } from '../../store/db.js';
import { getMessage } from '../../store/messages.js';
import type { Channel, ChannelConnectionState, ChannelEvent, ChannelEventListener } from '../channel.js';
import {
	createSqliteAuthStore,
	loadKeychainEncryptionKey,
	type SqliteAuthStore
} from './auth-store.js';
import { attachIngest, handleLidMappingUpdate } from './ingest.js';
import { deepenChatHistory } from './history.js';
import type { WhatsAppSendSocket } from './send.js';

type SocketEventHandler = (...args: any[]) => void;

export type WhatsAppSocket = Partial<WhatsAppSendSocket> & {
	ev: {
		on(event: string, handler: SocketEventHandler): unknown;
	};
	end(error?: Error): void;
	fetchMessageHistory?(
		count: number,
		oldestMsgKey: WAMessageKey,
		oldestMsgTimestamp: number
	): Promise<string>;
};

export type SocketFactory = (config: UserFacingSocketConfig) => WhatsAppSocket;

/**
 * Baileys' rc13 bundled version currently gets rejected before WhatsApp emits
 * the first pairing QR. Runtime startup resolves the live web version; this is
 * the last live-tested value used only when that lookup is unavailable.
 */
export const WA_WEB_VERSION_FALLBACK: WAVersion = [2, 3000, 1043856522];

type WhatsAppVersionFetcher = () => Promise<{ version: WAVersion; error?: unknown }>;

export async function resolveWhatsAppWebVersion(
	fetchVersion: WhatsAppVersionFetcher = () =>
		fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) })
): Promise<WAVersion> {
	try {
		const result = await fetchVersion();
		return result.error ? WA_WEB_VERSION_FALLBACK : result.version;
	} catch {
		return WA_WEB_VERSION_FALLBACK;
	}
}

export type WhatsAppConnectionOptions = {
	socketFactory?: SocketFactory;
	authStore?: SqliteAuthStore;
	/**
	 * Builds the auth store. Preferred over `authStore` when `resetAuth()` is
	 * used, since a reset must produce a store reading the now-empty tables.
	 */
	createAuthStore?: () => SqliteAuthStore;
	waVersion?: WAVersion;
	resolveWaVersion?: () => Promise<WAVersion>;
	reconnectDelayMs?: number;
	maxReconnectDelayMs?: number;
	groupCacheSize?: number;
	onError?: (error: Error) => void;
};

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function disconnectStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const candidate = error as {
		statusCode?: number;
		output?: { statusCode?: number };
	};
	return candidate.output?.statusCode ?? candidate.statusCode;
}

export function createStoredMessageLoader(db: AppDatabase) {
	return async (key: WAMessageKey) => {
		if (!key.id) return undefined;
		const stored = getMessage(db, key.id);
		if (!stored?.raw) return undefined;

		try {
			const parsed = JSON.parse(stored.raw, BufferJSON.reviver) as WAMessage;
			return parsed.message ?? undefined;
		} catch {
			return undefined;
		}
	};
}

export class GroupMetadataCache {
	readonly #entries = new Map<string, GroupMetadata>();

	constructor(private readonly maxSize = 100) {}

	get(jid: string): GroupMetadata | undefined {
		const value = this.#entries.get(jid);
		if (!value) return undefined;
		this.#entries.delete(jid);
		this.#entries.set(jid, value);
		return value;
	}

	set(metadata: GroupMetadata): void {
		this.#entries.delete(metadata.id);
		this.#entries.set(metadata.id, metadata);
		while (this.#entries.size > this.maxSize) {
			const oldest = this.#entries.keys().next().value as string | undefined;
			if (!oldest) break;
			this.#entries.delete(oldest);
		}
	}
}

export class WhatsAppConnection implements Channel {
	readonly #listeners = new Set<ChannelEventListener>();
	readonly #socketFactory: SocketFactory;
	readonly #createAuthStore: () => SqliteAuthStore;
	#authStore: SqliteAuthStore;
	#waVersion?: WAVersion;
	readonly #resolveWaVersion: () => Promise<WAVersion>;
	readonly #reconnectDelayMs: number;
	readonly #maxReconnectDelayMs: number;
	readonly #groupCache: GroupMetadataCache;
	readonly #onError?: (error: Error) => void;
	readonly #getStoredMessage: ReturnType<typeof createStoredMessageLoader>;

	readonly #db: AppDatabase;

	#socket?: WhatsAppSocket;
	#reconnectTimer?: ReturnType<typeof setTimeout>;
	#detachIngest?: () => void;
	#running = false;
	#reconnectAttempt = 0;
	#state?: ChannelConnectionState;
	#identityMappingsBackfilled = false;

	constructor(db: AppDatabase, options: WhatsAppConnectionOptions = {}) {
		this.#db = db;
		this.#socketFactory =
			options.socketFactory ??
			((config) => makeWASocket(config) as unknown as WhatsAppSocket);
		this.#createAuthStore =
			options.createAuthStore ??
			(options.authStore
				? () => options.authStore!
				: () => createSqliteAuthStore(db, loadKeychainEncryptionKey()));
		this.#authStore = this.#createAuthStore();
		this.#waVersion = options.waVersion;
		this.#resolveWaVersion = options.resolveWaVersion ?? resolveWhatsAppWebVersion;
		this.#reconnectDelayMs = options.reconnectDelayMs ?? 5_000;
		this.#maxReconnectDelayMs = Math.max(
			this.#reconnectDelayMs,
			options.maxReconnectDelayMs ?? 60_000
		);
		this.#groupCache = new GroupMetadataCache(options.groupCacheSize);
		this.#onError = options.onError;
		this.#getStoredMessage = createStoredMessageLoader(db);
	}

	onEvent(listener: ChannelEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		await this.#backfillIdentityMappings();
		await this.#connect();
	}

	async stop(): Promise<void> {
		this.#running = false;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#detachIngest?.();
		this.#detachIngest = undefined;
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.end(new Error('WhatsApp connection stopped'));
		this.#setState('disconnected');
	}

	/**
	 * Forget the stored session. `clear()` empties the tables but leaves the
	 * in-memory `creds` object, which Baileys would still present as a valid
	 * session — so the store is rebuilt from the now-empty tables.
	 */
	async resetAuth(): Promise<void> {
		await this.stop();
		await this.#authStore.clear();
		this.#authStore = this.#createAuthStore();
	}

	/** Restricted send capability handed only to the outbox adapter at boot. */
	getSendSocket(): WhatsAppSendSocket | undefined {
		if (this.#state !== 'connected') return undefined;
		const socket = this.#socket;
		if (
			!socket?.sendMessage ||
			!socket.sendPresenceUpdate ||
			!socket.readMessages
		) return undefined;
		return socket as WhatsAppSendSocket;
	}

	async deepenHistory(chatId: string, count = 50): Promise<unknown> {
		const fetchMessageHistory = this.#socket?.fetchMessageHistory;
		if (!fetchMessageHistory) throw new Error('WhatsApp history is unavailable while disconnected');
		return deepenChatHistory(
			this.#db,
			fetchMessageHistory.bind(this.#socket),
			chatId,
			count
		);
	}

	/**
	 * Baileys already persists encrypted LID↔phone mappings in the auth store.
	 * Mirror them into contact aliases so the UI can resolve saved names and
	 * real phone numbers without exposing or duplicating auth credentials.
	 */
	async #backfillIdentityMappings(): Promise<void> {
		if (this.#identityMappingsBackfilled) return;
		const ids = (
			this.#db
				.prepare(
					`SELECT id FROM wa_auth_keys
					 WHERE type = 'lid-mapping' AND id LIKE '%_reverse'`
				)
				.all() as Array<{ id: string }>
		).map(({ id }) => id);

		const apply = this.#db.transaction((entries: Array<{ lid: string; pn: string }>) => {
			for (const entry of entries) handleLidMappingUpdate(this.#db, entry);
		});
		for (let offset = 0; offset < ids.length; offset += 250) {
			const batch = ids.slice(offset, offset + 250);
			const stored = await this.#authStore.state.keys.get('lid-mapping', batch);
			const mappings: Array<{ lid: string; pn: string }> = [];
			for (const id of batch) {
				const pnUser = stored[id];
				if (typeof pnUser !== 'string' || !id.endsWith('_reverse')) continue;
				const lidUser = id.slice(0, -'_reverse'.length);
				if (!lidUser || !pnUser) continue;
				mappings.push({
					lid: `${lidUser}@lid`,
					pn: `${pnUser}@s.whatsapp.net`
				});
			}
			apply(mappings);
		}
		this.#identityMappingsBackfilled = true;
	}

	async #connect(): Promise<void> {
		if (!this.#running) return;
		this.#setState('connecting');

		try {
			const version = this.#waVersion ?? (this.#waVersion = await this.#resolveWaVersion());
			if (!this.#running) return;
			this.#detachIngest?.();
			const socket = this.#socketFactory({
				auth: this.#authStore.state,
				browser: Browsers.macOS('Desktop'),
				version,
				syncFullHistory: true,
				getMessage: this.#getStoredMessage,
				cachedGroupMetadata: async (jid) => this.#groupCache.get(jid)
			});
			this.#socket = socket;

			this.#detachIngest = attachIngest(socket.ev, this.#db, {
				onMessageIngested: (message) =>
					this.#emit({ type: 'message-committed', message }),
				onMessageUpdated: (message) =>
					this.#emit({ type: 'message-updated', message }),
				onSyncProgress: (progress) =>
					this.#emit({
						type: 'sync-progress',
						progress: progress.progress,
						isLatest: progress.isLatest,
						chats: progress.chats,
						messages: progress.messages
					})
			});

			socket.ev.on('connection.update', (update: {
				connection?: 'close' | 'connecting' | 'open';
				lastDisconnect?: { error?: unknown };
				qr?: string;
			}) => this.#handleConnectionUpdate(update));
			socket.ev.on('creds.update', (update: Record<string, unknown>) => {
				Object.assign(this.#authStore.state.creds, update);
				void this.#authStore.saveCreds().catch((error) => this.#surfaceError(error, true));
			});
			socket.ev.on('groups.upsert', (groups: GroupMetadata[]) => {
				for (const group of groups) this.#groupCache.set(group);
			});
		} catch (error) {
			this.#surfaceError(error, true);
			this.#scheduleReconnect();
		}
	}

	#handleConnectionUpdate(update: {
		connection?: 'close' | 'connecting' | 'open';
		lastDisconnect?: { error?: unknown };
		qr?: string;
	}): void {
		if (update.qr) {
			this.#reconnectAttempt = 0;
			this.#emit({ type: 'pairing-needed', qr: update.qr });
		}
		if (update.connection === 'connecting') this.#setState('connecting');
		if (update.connection === 'open') {
			this.#reconnectAttempt = 0;
			this.#setState('connected');
		}
		if (update.connection !== 'close') return;

		this.#socket = undefined;
		this.#setState('disconnected');
		const code = disconnectStatusCode(update.lastDisconnect?.error);
		if (code === DisconnectReason.loggedOut) {
			this.#running = false;
			// Terminal — no reconnect will help; the owner must re-pair (D5).
			this.#emit({ type: 'logged-out' });
			return;
		}
		this.#scheduleReconnect();
	}

	#scheduleReconnect(): void {
		if (!this.#running || this.#reconnectTimer) return;
		const delay = Math.min(
			this.#reconnectDelayMs * 2 ** Math.min(this.#reconnectAttempt, 10),
			this.#maxReconnectDelayMs
		);
		this.#reconnectAttempt += 1;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#connect();
		}, delay);
	}

	#setState(state: ChannelConnectionState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#emit({ type: 'connection', state });
	}

	#surfaceError(error: unknown, fatal: boolean): void {
		const normalized = asError(error);
		this.#onError?.(normalized);
		this.#emit({ type: 'error', error: normalized, fatal });
	}

	#emit(event: ChannelEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}
