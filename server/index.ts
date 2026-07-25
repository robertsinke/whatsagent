import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Channel } from './channels/channel.js';
import { downloadAndCacheMedia } from './channels/whatsapp/media.js';
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
					await options.channel!.stop();
					await options.channel!.start();
				}
			: undefined,
		dataDir,
		downloadMedia,
		staticDir,
		port: requestedPort,
		getAllowedOrigins
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

	server.on('listening', () => {
		const addr = server.address();
		if (addr && typeof addr !== 'string') {
			listeningPort = addr.port;
		}
		started = true;
	});

	async function start(): Promise<void> {
		if (started) return;
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
				}
			});
			await options.channel.start();
		}
	}

	async function close(): Promise<void> {
		channelUnsub?.();
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
	const app = createApp();
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
