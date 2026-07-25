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
import { createRequestHandler } from './api/routes.js';
import { createSessionState } from './api/session.js';
import { buildAllowedOrigins, validateOriginAndHost } from './api/security.js';
import { DraftScheduler } from './agent/scheduler.js';
import type { Memory } from './agent/memory/memory.js';
import { NullMemory } from './agent/memory/null-memory.js';
import { createRuntimeMemory } from './agent/memory/hindsight.js';
import { bootstrapOwnerVoice } from './agent/voice.js';
import { OutboxPacer, type OutboxPacerOptions } from './outbox/pacer.js';
import { createDraftProvider, type DraftProviderName } from './providers/index.js';
import type { DraftProvider } from './providers/provider.js';
import { getDraft } from './store/drafts.js';
import { getChat } from './store/chats.js';
import { getSetting, listSettings } from './store/settings.js';
import { cancelStaleDraftOutbox } from './store/outbox.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

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
	draftDebounceMs?: number;
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
	// D5 — derived pairing/sync view, pushed on every transition (QR rotations included).
	const session = createSessionState({
		onChange: (view) => events.emit({ type: 'session', session: view })
	});
	const ingestHooks = createIngestEventHooks(events);
	const memory = options.memory ?? new NullMemory();
	const scheduler = options.draftProvider
		? new DraftScheduler({
				db,
				provider: options.draftProvider,
				providerName: options.providerName ?? 'claude',
				memory,
				debounceMs: options.draftDebounceMs,
				hooks: {
					onDraftUpdated: (draft) => events.emit({ type: 'draft-updated', draft }),
					onDraftRemoved: (chatJid) => events.emit({ type: 'draft-removed', chat_jid: chatJid }),
					onChatUpdated: (chat) => events.emit({ type: 'chat-updated', chat })
				}
			})
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
					if (chat) events.emit({ type: 'chat-updated', chat });
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
		memory,
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
					if (event.state === 'connected') pacer?.wake();
					else pacer?.setDraftsPaused(true);
				} else if (event.type === 'pairing-needed') {
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
					if (event.isLatest) completeHistorySync();
					if (event.isLatest) pacer?.setDraftsPaused(false);
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
				}
			});
			await options.channel.start();
		}
		pacer?.start();
		const reflectMs = options.memoryReflectMs ?? 6 * 60 * 60 * 1_000;
		if (reflectMs > 0) {
			reflectTimer = setInterval(() => {
				void memory.reflect().catch((error) => console.warn('[memory] reflection failed', error));
			}, reflectMs);
		}
	}

	async function close(): Promise<void> {
		closing = true;
		channelUnsub?.();
		if (reflectTimer) clearInterval(reflectTimer);
		reflectTimer = undefined;
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
	const memory = createRuntimeMemory(settings);
	const dryRunSetting = getSetting(db, 'outbox_dry_run');
	const app = createApp({
		db,
		channel,
		draftProvider: createDraftProvider(settings),
		providerName,
		memory,
		outboxTransport: createWhatsAppSendTransport(() => channel.getSendSocket()),
		outboxPacer: {
			dryRun: dryRunSetting === undefined
				? process.env.NODE_ENV !== 'production'
				: dryRunSetting === 'true'
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
