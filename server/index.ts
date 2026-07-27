import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Channel } from './channels/channel.js';
import { WhatsAppConnection } from './channels/whatsapp/connection.js';
import { downloadAndCacheMedia } from './channels/whatsapp/media.js';
import {
	createWhatsAppSendTransport,
	type WhatsAppSendTransport
} from './channels/whatsapp/send.js';
import {
	getDefaultDataDir,
	openDatabase,
	type AppDatabase,
	type OpenDatabaseOptions
} from './store/db.js';
import {
	createConnectionStatus,
	createIngestEventHooks,
	EventBus,
	type IngestEventHooks,
	type ServerEvent
} from './api/events.js';
import { chatViewFor } from './api/chat-view.js';
import { createRequestHandler } from './api/routes.js';
import { createSessionState } from './api/session.js';
import { buildAllowedOrigins, validateOriginAndHost } from './api/security.js';
import { DraftScheduler } from './agent/scheduler.js';
import type { Memory } from './agent/memory/memory.js';
import { NullMemory } from './agent/memory/null-memory.js';
import { createRuntimeMemory } from './agent/memory/hindsight.js';
import { bootstrapOwnerVoice } from './agent/voice.js';
import { refineDraft } from './agent/refiner.js';
import { OutboxPacer, type OutboxPacerOptions } from './outbox/pacer.js';
import { createDraftProvider, type DraftProviderName } from './providers/index.js';
import type { DraftProvider } from './providers/provider.js';
import { getDraft } from './store/drafts.js';
import { getChat } from './store/chats.js';
import {
	getSetting,
	listSettings,
	OUTBOX_DRY_RUN_SETTING,
	resolveOutboxDryRun,
	setSetting
} from './store/settings.js';
import { cancelStaleDraftOutbox } from './store/outbox.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
export const HISTORY_SYNC_COMPLETE_SETTING = 'whatsapp_history_sync_complete';

export type CreateAppOptions = {
	db?: AppDatabase;
	dbOptions?: OpenDatabaseOptions;
	events?: EventBus;
	port?: number;
	host?: string;
	staticDir?: string | null;
	/** Optional WhatsApp (or other) channel — started when provided. */
	channel?: Channel;
	/** Override the D2 on-demand media fetch (tests). */
	downloadMedia?: (messageId: string) => Promise<unknown>;
	/** App-data dir (media cache root). Defaults to the DB's data dir. */
	dataDir?: string;
	/** Supplying a provider mounts the U8 scheduler into the live runtime. */
	draftProvider?: DraftProvider;
	providerName?: string;
	memory?: Memory;
	memoryReflectMs?: number;
	/** Short-interval retry of the memory's retain queue, independent of `memoryReflectMs`. Default 60 s. */
	memoryQueueDrainMs?: number;
	draftDebounceMs?: number;
	/** Exact from-me message ID permitted for one non-production drafting test. */
	devDraftFromMeMessageId?: string;
	/** Supplying a transport mounts and starts the sole WhatsApp send path. */
	outboxTransport?: WhatsAppSendTransport;
	outboxPacer?: Omit<OutboxPacerOptions, 'db' | 'transport' | 'onUpdated'>;
};

export type App = {
	server: Server;
	db: AppDatabase;
	events: EventBus;
	ingestHooks: IngestEventHooks;
	port: number;
	host: string;
	url: string;
	start: () => Promise<void>;
	close: () => Promise<void>;
};

/**
 * Sending is opt-in: a fresh install and any malformed value remain in
 * dry-run. Only the explicit SQLite value `false` enables WhatsApp transport.
 * Re-exported from `store/settings.js` so existing callers (and tests) keep
 * importing it from here; the W4-U8 corrupt-setting test lives against this
 * polarity.
 */
export { resolveOutboxDryRun } from './store/settings.js';

function defaultStaticDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// server/ → repo root → build/ (adapter-static)
	return join(here, '..', 'build');
}

export function createApp(options: CreateAppOptions = {}): App {
	const requestedPort = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
	const host = options.host ?? DEFAULT_HOST;
	const db = options.db ?? openDatabase(options.dbOptions);
	const dataDir = options.dataDir ?? options.dbOptions?.dataDir ?? getDefaultDataDir();
	const events = options.events ?? new EventBus();
	const connection = createConnectionStatus();
	let historySyncComplete = getSetting(db, HISTORY_SYNC_COMPLETE_SETTING) === 'true';
	// D5 — derived pairing/sync view, pushed on every transition (QR rotations included).
	const session = createSessionState({
		initialSyncComplete: historySyncComplete,
		onChange: (view) => events.emit({ type: 'session', session: view })
	});
	const ingestHooks = createIngestEventHooks(events, db);
	const memory: Memory = options.memory ?? new NullMemory();
	const scheduler = options.draftProvider
		? new DraftScheduler({
				db,
				provider: options.draftProvider,
				providerName: options.providerName ?? 'claude',
				memory,
				devDraftFromMeMessageId: options.devDraftFromMeMessageId,
				debounceMs: options.draftDebounceMs,
				hooks: {
					onDraftUpdated: (draft) => events.emit({ type: 'draft-updated', draft }),
					onDraftRemoved: (chatJid) => events.emit({ type: 'draft-removed', chat_jid: chatJid }),
					onChatUpdated: (chat) => events.emit({ type: 'chat-updated', chat: chatViewFor(db, chat) })
				}
			})
		: undefined;
	const refiner = options.draftProvider
		? (request: Parameters<typeof refineDraft>[1]) =>
				refineDraft(
					{
						db,
						provider: options.draftProvider!,
						providerName: options.providerName ?? 'claude',
						onDraftUpdated: (draft) => events.emit({ type: 'draft-updated', draft })
					},
					request
				)
		: undefined;
	let schedulerStarted = false;
	const pacer = options.outboxTransport
		? new OutboxPacer({
				...options.outboxPacer,
				db,
				transport: options.outboxTransport,
				draftsPaused: true,
				onUpdated: (outbox) => {
					events.emit({ type: 'outbox-updated', outbox });
					const draft = getDraft(db, outbox.chat_jid);
					if (draft) events.emit({ type: 'draft-updated', draft });
					const chat = getChat(db, outbox.chat_jid);
					if (chat) events.emit({ type: 'chat-updated', chat: chatViewFor(db, chat) });
				}
			})
		: undefined;

	const downloadMedia =
		options.downloadMedia ??
		(options.channel
			? (messageId: string) => downloadAndCacheMedia(db, messageId, { dataDir })
			: undefined);
	const staticDir =
		options.staticDir === null
			? undefined
			: (options.staticDir ?? defaultStaticDir());

	let listeningPort = requestedPort;

	const getAllowedOrigins = () => buildAllowedOrigins(listeningPort);

	const handleRequest = createRequestHandler({
		db,
		events,
		getConnectionStatus: connection.get,
		getSessionStatus: session.get,
		regeneratePairing: options.channel
			? async () => {
					const channel = options.channel!;
					await channel.stop();
					// After `logged_out` the stored session is dead. A channel still
					// holding it will not offer a fresh QR, so forget it first.
					if (session.get().status === 'logged_out') await channel.resetAuth?.();
					await channel.start();
				}
			: undefined,
		dataDir,
		downloadMedia,
		staticDir,
		port: requestedPort,
		getAllowedOrigins,
		nextDraftJitterMs: pacer ? () => pacer.jitterMs() : undefined,
		wakeOutbox: pacer ? () => pacer.wake() : undefined,
		setOutboxDryRun: pacer ? (dryRun: boolean) => pacer.setDryRun(dryRun) : undefined,
		memory,
		refineDraft: refiner,
		deepenHistory: options.channel?.deepenHistory
			? (chatJid, count) => options.channel!.deepenHistory!(chatJid, count)
			: undefined
	});

	const server = createServer((req, res) => {
		void handleRequest(req, res);
	});

	const wss = new WebSocketServer({ noServer: true });
	const sockets = new Set<WebSocket>();

	server.on('upgrade', (req, socket, head) => {
		const hostHeader = req.headers.host ?? `${host}:${listeningPort}`;
		const url = new URL(req.url ?? '/', `http://${hostHeader}`);
		if (url.pathname !== '/api/ws') {
			socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
			socket.destroy();
			return;
		}

		const check = validateOriginAndHost(req, getAllowedOrigins());
		if (!check.ok) {
			socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', (ws) => {
		sockets.add(ws);
		ws.send(
			JSON.stringify({
				type: 'connection',
				state: connection.get().state
			} satisfies ServerEvent)
		);
		// Snapshot the derived session immediately — a client that connects
		// mid-QR-rotation must not wait up to 20s for the next push.
		ws.send(JSON.stringify({ type: 'session', session: session.get() } satisfies ServerEvent));
		// W4-U8: snapshot the current send-mode so the topbar indicator and the
		// settings toggle render the right state before any WS event lands.
		const liveSendMode = getSetting(db, OUTBOX_DRY_RUN_SETTING) === 'false';
		ws.send(
			JSON.stringify({
				type: 'send-mode',
				live: liveSendMode,
				dry_run: !liveSendMode
			} satisfies ServerEvent)
		);
		const qr = connection.get().qr;
		if (qr) {
			ws.send(JSON.stringify({ type: 'pairing-needed', qr } satisfies ServerEvent));
		}
		ws.on('close', () => sockets.delete(ws));
	});

	const unsubscribeEvents = events.subscribe((event) => {
		const payload = JSON.stringify(event);
		for (const ws of sockets) {
			if (ws.readyState === ws.OPEN) ws.send(payload);
		}
	});

	let channelUnsub: (() => void) | undefined;
	let started = false;
	let closing = false;
	let voiceBootstrap: Promise<void> | undefined;
	let reflectTimer: ReturnType<typeof setInterval> | undefined;
	let drainTimer: ReturnType<typeof setInterval> | undefined;

	function completeHistorySync(): void {
		if (voiceBootstrap) {
			if (schedulerStarted) scheduler?.start();
			return;
		}
		voiceBootstrap = bootstrapOwnerVoice(db, memory)
			.catch((error) => console.warn('[memory] voice bootstrap failed; continuing without it', error))
			.then(() => {
				if (closing || !scheduler) return;
				schedulerStarted = true;
				scheduler.start();
			});
	}

	server.on('listening', () => {
		const addr = server.address();
		if (addr && typeof addr !== 'string') {
			listeningPort = addr.port;
		}
		started = true;
	});

	async function start(): Promise<void> {
		if (started) return;
		closing = false;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(requestedPort, host, () => {
				server.off('error', reject);
				resolve();
			});
		});

		if (options.channel) {
			channelUnsub = options.channel.onEvent((event) => {
				// Every channel event feeds the D5 derivation, which emits `session`
				// itself via onChange. Transport events stay published as-is.
				session.applyChannelEvent(event);
				if (event.type === 'connection') {
					connection.setState(event.state);
					events.emit({ type: 'connection', state: event.state });
					if (event.state === 'connected') {
						pacer?.wake();
						if (historySyncComplete) {
							pacer?.setDraftsPaused(false);
							completeHistorySync();
						}
					} else {
						pacer?.setDraftsPaused(true);
					}
				} else if (event.type === 'pairing-needed') {
					historySyncComplete = false;
					setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'false');
					connection.setQr(event.qr);
					events.emit({ type: 'pairing-needed', qr: event.qr });
				} else if (event.type === 'sync-progress') {
					const view = session.get().sync;
					events.emit({
						type: 'sync-progress',
						phase: 'history',
						chatsSynced: view.chatsSynced,
						messagesSynced: view.messagesSynced,
						complete: view.complete
					});
					if (event.isLatest) {
						historySyncComplete = true;
						setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'true');
						completeHistorySync();
						pacer?.setDraftsPaused(false);
					}
				} else if (event.type === 'logged-out') {
					historySyncComplete = false;
					setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'false');
				} else if (event.type === 'message-committed') {
					ingestHooks.onMessageIngested(event.message);
					if (!event.message.from_me) {
						for (const outbox of cancelStaleDraftOutbox(
							db,
							event.message.chat_jid,
							event.message.id
						)) {
							events.emit({ type: 'outbox-updated', outbox });
						}
					}
					if (schedulerStarted) scheduler?.onMessage(event.message);
				} else if (event.type === 'message-updated') {
					ingestHooks.onMessageUpdated(event.message);
				} else if (event.type === 'chats-merged') {
					// Survivor first, then the removal: a client that drops `from` on
					// receipt must already have the row it is about to be pointed at.
					const survivor = getChat(db, event.to);
					if (survivor) {
						events.emit({ type: 'chat-updated', chat: chatViewFor(db, survivor) });
					}
					events.emit({ type: 'chat-removed', jid: event.from, merged_into: event.to });
				}
			});
			await options.channel.start();
		}
		pacer?.start();
		const reflectMs = options.memoryReflectMs ?? 6 * 60 * 60 * 1_000;
		if (reflectMs > 0) {
			const sync = () =>
				void memory.reflect().catch((error) => console.warn('[memory] reflection failed', error));
			// `setInterval` does not fire immediately, and this call is now the voice mirror's
			// heartbeat — without a run at start, a restart would draft against files up to
			// one full interval stale.
			sync();
			reflectTimer = setInterval(sync, reflectMs);
		}
		// Short-interval queue retry: a cold-start retain timeout sets the memory's offline
		// window, and without this the queue sits until the next retain or the 6-hourly
		// reflect — one 2 s timeout parked the whole voice bootstrap for six hours. The
		// memory's `drain` is a no-op when offline or when the queue is empty.
		const drainMs = options.memoryQueueDrainMs ?? 60_000;
		if (drainMs > 0 && typeof memory.drain === 'function') {
			const drain = () =>
				void memory.drain!().catch((error) => console.warn('[memory] queue drain failed', error));
			drainTimer = setInterval(drain, drainMs);
		}
	}

	async function close(): Promise<void> {
		closing = true;
		channelUnsub?.();
		if (reflectTimer) clearInterval(reflectTimer);
		reflectTimer = undefined;
		if (drainTimer) clearInterval(drainTimer);
		drainTimer = undefined;
		scheduler?.stop();
		pacer?.stop();
		session.dispose();
		if (options.channel) await options.channel.stop();
		unsubscribeEvents();
		for (const ws of sockets) ws.close();
		sockets.clear();
		await new Promise<void>((resolve) => {
			wss.close(() => resolve());
		});
		if (started) {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
		db.close();
		started = false;
	}

	return {
		server,
		db,
		events,
		ingestHooks,
		host,
		get port() {
			return listeningPort;
		},
		get url() {
			return `http://${host}:${listeningPort}`;
		},
		start,
		close
	};
}

async function main(): Promise<void> {
	const db = openDatabase();
	const settings = listSettings(db);
	const channel = new WhatsAppConnection(db);
	const providerName = (settings.provider ?? 'claude') as DraftProviderName;
	const memory = createRuntimeMemory(settings, { dataDir: getDefaultDataDir() });
	const dryRunSetting = getSetting(db, OUTBOX_DRY_RUN_SETTING);
	const devDraftFromMeMessageId =
		process.env.NODE_ENV === 'production'
			? undefined
			: process.env.WHATSAGENT_DEV_DRAFT_FROM_ME_MESSAGE_ID?.trim() || undefined;
	if (devDraftFromMeMessageId) {
		console.warn(
			`[draft] development override enabled for from-me message ${devDraftFromMeMessageId}`
		);
	}
	const app = createApp({
		db,
		channel,
		draftProvider: createDraftProvider(settings),
		providerName,
		memory,
		devDraftFromMeMessageId,
		outboxTransport: createWhatsAppSendTransport(() => channel.getSendSocket()),
		outboxPacer: {
			dryRun: resolveOutboxDryRun(dryRunSetting)
		}
	});
	await app.start();
	console.log(`whatsagent listening on ${app.url} (loopback only)`);

	const shutdown = async () => {
		console.log('shutting down…');
		await app.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());
}

const entry = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (
	typeof entry === 'string' &&
	(thisFile === entry ||
		entry.replace(/\\/g, '/').endsWith('/server/index.ts') ||
		entry.replace(/\\/g, '/').endsWith('/server/index.js'))
) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
