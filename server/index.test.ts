import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WAMessage, WAMessageKey } from 'baileys';
import type { Channel, ChannelEvent, ChannelEventListener } from './channels/channel.js';
import type { DraftProvider } from './providers/provider.js';
import { getChat, upsertChat } from './store/chats.js';
import { openDatabase, type AppDatabase } from './store/db.js';
import { getDraft } from './store/drafts.js';
import { getMessage, upsertMessage } from './store/messages.js';
import { enqueueDraftOutbox, enqueueManualOutbox, enqueueReactionOutbox, getOutbox } from './store/outbox.js';
import {
	assertSupportedPlatform,
	createApp,
	HISTORY_SYNC_COMPLETE_SETTING,
	resolveBootProvider,
	resolveDataDirOverride,
	resolveOutboxDryRun,
	type App
} from './index.js';
import { createSqliteAuthStore } from './channels/whatsapp/auth-store.js';
import {
	WA_WEB_VERSION_FALLBACK,
	WhatsAppConnection,
	type SocketFactory,
	type WhatsAppSocket
} from './channels/whatsapp/connection.js';
import { createWhatsAppSendTransport } from './channels/whatsapp/send.js';
import type { ServerEvent } from './api/events.js';
import type { Memory } from './agent/memory/memory.js';
import { getSetting, setSetting } from './store/settings.js';
import {
	FIXTURE_CHAT_LID_JID,
	FIXTURE_GROUP_JID,
	FIXTURE_US_PHONE
} from '../shared/test-fixtures.js';

class FakeChannel implements Channel {
	readonly listeners = new Set<ChannelEventListener>();
	start = vi.fn(async () => undefined);
	stop = vi.fn(async () => undefined);
	checkRegistered = vi.fn(async (jid: string) => ({ registered: true, jid }));

	onEvent(listener: ChannelEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: ChannelEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

/**
 * A Baileys socket stand-in that reproduces `emitOwnEvents`: every successful
 * `sendMessage` re-emits the sent envelope back on `ev` as a
 * `messages.upsert` of type `append`, exactly as `Socket/messages-send.js`
 * does on `process.nextTick` after `relayMessage` resolves. Sends never leave
 * the process — this is how an outbound message is reproduced without putting
 * a second socket on the owner's live account.
 */
class FakeWaSocket implements WhatsAppSocket {
	readonly handlers = new Map<string, ((...args: any[]) => void)[]>();
	readonly sent: WAMessage[] = [];
	readonly end = vi.fn();
	readonly ev = {
		on: (event: string, handler: (...args: any[]) => void) => {
			const list = this.handlers.get(event) ?? [];
			list.push(handler);
			this.handlers.set(event, list);
		}
	};

	readonly sendPresenceUpdate = vi.fn(async () => undefined);
	readonly readMessages = vi.fn(async () => undefined);

	readonly sendMessage = vi.fn(
		async (
			jid: string,
			content: { text: string } | { react: { text: string; key: WAMessageKey } },
			options?: { messageId: string; quoted?: WAMessage }
		) => {
			const fullMsg = {
				key: { remoteJid: jid, fromMe: true, id: options?.messageId ?? 'WA-GENERATED-ID' },
				message:
					'react' in content
						? {
								reactionMessage: {
									key: content.react.key,
									text: content.react.text,
									senderTimestampMs: 1_700_000_100_000
								}
							}
						: {
								extendedTextMessage: { text: content.text },
								messageContextInfo: { messageSecret: 'c2VjcmV0' }
							},
				messageTimestamp: 1_700_000_100,
				status: 'PENDING'
			} as unknown as WAMessage;
			this.sent.push(fullMsg);
			this.emit('messages.upsert', { messages: [fullMsg], type: 'append' });
			return fullMsg;
		}
	);

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}
}

let dataDir: string | undefined;
let db: AppDatabase | undefined;
let app: App | undefined;

afterEach(async () => {
	if (app) {
		const current = app;
		app = undefined;
		db = undefined;
		await current.close();
	} else {
		db?.close();
		db = undefined;
	}
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('owner-sent messages reach the conversation live', () => {
	async function startSendingApp(chatJid: string, enqueue: (db: AppDatabase) => number) {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-live-send-'));
		db = openDatabase({ dataDir });
		upsertChat(db, { jid: chatJid, kind: '1:1', last_msg_at: 10 });
		upsertMessage(db, {
			id: 'INBOUND-1',
			chat_jid: chatJid,
			from_me: false,
			ts: 10,
			text: 'their message',
			raw: JSON.stringify({
				key: { remoteJid: chatJid, fromMe: false, id: 'INBOUND-1' },
				message: { conversation: 'their message' },
				messageTimestamp: 10
			})
		});

		const sockets: FakeWaSocket[] = [];
		const socketFactory: SocketFactory = () => {
			const socket = new FakeWaSocket();
			sockets.push(socket);
			return socket;
		};
		const channel = new WhatsAppConnection(db, {
			authStore: createSqliteAuthStore(db, Buffer.alloc(32, 7)),
			socketFactory,
			waVersion: WA_WEB_VERSION_FALLBACK,
			reconnectDelayMs: 10_000
		});
		app = createApp({
			db,
			channel,
			port: 0,
			staticDir: null,
			outboxTransport: createWhatsAppSendTransport(() => channel.getSendSocket()),
			// The transport is a local fake; nothing leaves the process.
			outboxPacer: {
				dryRun: false,
				manualPresenceMs: 0,
				minDraftDelayMs: 0,
				maxDraftDelayMs: 0,
				// The pacer drains once at start(), before the socket reports
				// `connected`; that first attempt fails fast and retries.
				retryDelayMs: 10
			}
		});
		// Queued before start so the `connected` transition is the pacer's wake.
		const outboxId = enqueue(db);
		const events: ServerEvent[] = [];
		app.events.subscribe((event) => events.push(event));
		await app.start();
		sockets[0]!.emit('connection.update', { connection: 'open' });
		return { chatJid, socket: sockets[0]!, events, outboxId };
	}

	it('emits exactly one message-new for a text the owner sent', async () => {
		const chatJid = FIXTURE_CHAT_LID_JID;
		const { socket, events, outboxId } = await startSendingApp(chatJid, (database) =>
			enqueueManualOutbox(database, {
				chatJid,
				text: 'So should I or you send it?',
				now: Date.now()
			})
		);
		const messageId = getOutbox(db!, outboxId)!.message_id!;

		await vi.waitFor(() => expect(getOutbox(db!, outboxId)?.status).toBe('sent'));
		await vi.waitFor(() =>
			expect(events.filter((e) => e.type === 'message-new')).toHaveLength(1)
		);

		const newEvents = events.filter(
			(e): e is Extract<ServerEvent, { type: 'message-new' }> => e.type === 'message-new'
		);
		expect(newEvents[0]!.message).toMatchObject({
			id: messageId,
			chat_jid: chatJid,
			from_me: true,
			text: 'So should I or you send it?'
		});

		// The server ack replays the same append upsert; the conversation must not
		// grow a second copy of the message.
		socket.emit('messages.upsert', { messages: socket.sent, type: 'append' });
		expect(events.filter((e) => e.type === 'message-new')).toHaveLength(1);
	});

	it('keeps an owner reaction on the message-updated path with no message-new', async () => {
		const chatJid = FIXTURE_GROUP_JID;
		const { events, outboxId } = await startSendingApp(chatJid, (database) =>
			enqueueReactionOutbox(database, {
				chatJid,
				targetMsgId: 'INBOUND-1',
				emoji: '❤️',
				now: Date.now()
			})
		);

		await vi.waitFor(() => expect(getOutbox(db!, outboxId)?.status).toBe('sent'));
		await vi.waitFor(() =>
			expect(events.filter((e) => e.type === 'message-updated')).toHaveLength(1)
		);
		expect(events.filter((e) => e.type === 'message-new')).toHaveLength(0);

		const updated = events.find(
			(e): e is Extract<ServerEvent, { type: 'message-updated' }> => e.type === 'message-updated'
		)!;
		expect(updated.message.id).toBe('INBOUND-1');
		expect(updated.message.reactions).toEqual([
			expect.objectContaining({ emoji: '❤️', count: 1 })
		]);
	});
});

describe('outbox dry-run safety default', () => {
	it.each([
		{ setting: undefined, expected: true },
		{ setting: 'true', expected: true },
		{ setting: 'invalid', expected: true },
		{ setting: 'false', expected: false }
	])('resolves $setting to $expected', ({ setting, expected }) => {
		expect(resolveOutboxDryRun(setting)).toBe(expected);
	});
});

describe('live draft scheduler wiring', () => {
	it('starts after history sync and receives only post-commit live inbound messages', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-runtime-'));
		db = openDatabase({ dataDir });
		upsertChat(db, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 10
		});
		upsertMessage(db, {
			id: 'owner-style',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 5,
			text: 'Short and direct.'
		});
		upsertMessage(db, {
			id: 'history-basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 10,
			text: 'history question'
		});

		let draftCount = 0;
		let voiceRetained = false;
		const memory: Memory = {
			retainVoiceObservation: vi.fn(async () => { voiceRetained = true; }),
			retainEditDelta: async () => undefined,
			recallStyleFor: async () => 'Uses short, direct replies.',
			reflect: async () => undefined
		};
		const draft: DraftProvider['draft'] = vi.fn(async (input) => {
			expect(voiceRetained).toBe(true);
			expect(input.system).toContain('Uses short, direct replies.');
			return {
				kind: 'draft' as const,
				text: `reply ${++draftCount}`
			};
		});
		const channel = new FakeChannel();
		app = createApp({
			db,
			channel,
			draftProvider: { draft },
			providerName: 'fake',
			memory,
			draftDebounceMs: 0,
			port: 0,
			staticDir: null
		});
		await app.start();

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(draft).not.toHaveBeenCalled();

		channel.emit({
			type: 'sync-progress',
			progress: 100,
			isLatest: true,
			chats: 1,
			messages: 1
		});
		await vi.waitFor(() => expect(draft).toHaveBeenCalledTimes(1));
		expect(getSetting(db!, HISTORY_SYNC_COMPLETE_SETTING)).toBe('true');
		expect(getDraft(db!, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('history-basis');
		const queued = enqueueDraftOutbox(db!, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'approved old answer',
			draftText: 'approved old answer',
			basisMsgId: 'history-basis',
			now: 11,
			jitterMs: 30_000
		});

		upsertMessage(db!, {
			id: 'live-basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 20,
			text: 'live follow-up'
		});
		const committed = getMessage(db!, 'live-basis')!;
		channel.emit({ type: 'message-committed', message: committed });

		await vi.waitFor(() => expect(draft).toHaveBeenCalledTimes(2));
		expect(getOutbox(db!, queued)?.status).toBe('cancelled');
		expect(getDraft(db!, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('live-basis');

		// A reconnect can recover inbound history without a live upsert event. Each
		// terminal sync batch rescans so that message is not stranded.
		upsertMessage(db!, {
			id: 'reconnect-history',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 30,
			text: 'arrived while offline'
		});
		channel.emit({
			type: 'sync-progress',
			progress: 100,
			isLatest: true,
			chats: 1,
			messages: 1
		});
		await vi.waitFor(() => expect(draft).toHaveBeenCalledTimes(3));
		expect(getDraft(db!, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('reconnect-history');
	});
});

describe('restart recovery', () => {
	it('restores ready status from a persisted completed history sync', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-runtime-'));
		db = openDatabase({ dataDir });
		setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'true');
		const channel = new FakeChannel();
		const sessionStatuses: string[] = [];
		app = createApp({
			db,
			channel,
			port: 0,
			staticDir: null
		});
		app.events.subscribe((event) => {
			if (event.type === 'session') sessionStatuses.push(event.session.status);
		});

		await app.start();
		channel.emit({ type: 'connection', state: 'connected' });

		expect(sessionStatuses.at(-1)).toBe('ready');
	});
});

describe('start-chat is wired to the live channel (NEWCHAT-1)', () => {
	/**
	 * `start-chat` refuses when `deps.checkRegistered` is absent, so the action
	 * can be fully implemented and fully tested against an injected dep while
	 * being permanently dead in production. Only `createApp` can populate it —
	 * this asserts it does, through the real HTTP route rather than by reading
	 * the deps object, so a future refactor that drops the line fails here.
	 */
	it('populates checkRegistered from the channel, so POST /api/chats creates a chat', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-runtime-'));
		db = openDatabase({ dataDir });
		const channel = new FakeChannel();
		app = createApp({ db, channel, port: 0, staticDir: null });
		await app.start();

		const res = await fetch(`${app.url}/api/chats`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: app.url },
			body: JSON.stringify({ phone: `+${FIXTURE_US_PHONE}` })
		});

		expect(res.status).toBe(201);
		expect(channel.checkRegistered).toHaveBeenCalledWith(
			`${FIXTURE_US_PHONE}@s.whatsapp.net`
		);
		expect(getChat(db, `${FIXTURE_US_PHONE}@s.whatsapp.net`)).toMatchObject({
			kind: '1:1'
		});
	});

	it('refuses when no channel is attached, and creates nothing', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-runtime-'));
		db = openDatabase({ dataDir });
		app = createApp({ db, port: 0, staticDir: null });
		await app.start();

		const res = await fetch(`${app.url}/api/chats`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: app.url },
			body: JSON.stringify({ phone: `+${FIXTURE_US_PHONE}` })
		});

		expect(res.status).toBe(503);
		expect(getChat(db, `${FIXTURE_US_PHONE}@s.whatsapp.net`)).toBeUndefined();
	});

	it('uses an injected checkRegistered when no channel is attached', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-runtime-'));
		db = openDatabase({ dataDir });
		const checkRegistered = vi.fn(async (jid: string) => ({ registered: true, jid }));
		app = createApp({ db, port: 0, staticDir: null, checkRegistered });
		await app.start();

		const res = await fetch(`${app.url}/api/chats`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: app.url },
			body: JSON.stringify({ phone: `+${FIXTURE_US_PHONE}` })
		});

		expect(res.status).toBe(201);
		expect(checkRegistered).toHaveBeenCalledWith(`${FIXTURE_US_PHONE}@s.whatsapp.net`);
		expect(getChat(db, `${FIXTURE_US_PHONE}@s.whatsapp.net`)).toMatchObject({ kind: '1:1' });
	});
});

describe('assertSupportedPlatform', () => {
	it('allows darwin', () => {
		expect(() => assertSupportedPlatform('darwin')).not.toThrow();
	});

	it('rejects linux and win32 with a macOS-required message', () => {
		for (const platform of ['linux', 'win32'] as const) {
			expect(() => assertSupportedPlatform(platform)).toThrow(/requires macOS/i);
		}
	});
});

describe('resolveBootProvider', () => {
	it('returns the default and a null coercedFrom when no setting is present', () => {
		expect(resolveBootProvider({})).toEqual({ name: 'claude', coercedFrom: null });
	});

	it('returns the default plus the original string when the setting is a typo', () => {
		expect(resolveBootProvider({ provider: 'claud' })).toEqual({
			name: 'claude',
			coercedFrom: 'claud'
		});
	});

	it('does not throw on a typo or trailing whitespace', () => {
		expect(() => resolveBootProvider({ provider: 'nope' })).not.toThrow();
		expect(resolveBootProvider({ provider: ' Codex ' })).toEqual({
			name: 'codex',
			coercedFrom: ' Codex '
		});
	});

	it('passes through an exact known provider without coercion', () => {
		expect(resolveBootProvider({ provider: 'ollama' })).toEqual({
			name: 'ollama',
			coercedFrom: null
		});
	});
});

describe('resolveDataDirOverride', () => {
	const home = () => '/Users/example';

	it('returns undefined when neither env nor argv supplies one', () => {
		expect(resolveDataDirOverride({}, ['node', 'server/index.js'], home)).toBeUndefined();
	});

	it('reads WHATSAGENT_DATA_DIR', () => {
		expect(
			resolveDataDirOverride({ WHATSAGENT_DATA_DIR: '/tmp/throwaway' }, ['node'], home)
		).toBe('/tmp/throwaway');
	});

	it('reads --data-dir=<path> and --data-dir <path>', () => {
		expect(resolveDataDirOverride({}, ['node', '--data-dir=/tmp/a'], home)).toBe('/tmp/a');
		expect(resolveDataDirOverride({}, ['node', '--data-dir', '/tmp/b'], home)).toBe('/tmp/b');
	});

	it('lets argv win over the environment', () => {
		expect(
			resolveDataDirOverride({ WHATSAGENT_DATA_DIR: '/tmp/env' }, ['node', '--data-dir=/tmp/argv'], home)
		).toBe('/tmp/argv');
	});

	// A blank value must not resolve to the process cwd: an empty env var is a
	// launcher mistake, and silently rooting the live database in whatever
	// directory the app happened to start from is worse than ignoring it.
	it('treats blank values as absent', () => {
		expect(resolveDataDirOverride({ WHATSAGENT_DATA_DIR: '   ' }, ['node'], home)).toBeUndefined();
		expect(
			resolveDataDirOverride({ WHATSAGENT_DATA_DIR: '/tmp/env' }, ['node', '--data-dir='], home)
		).toBe('/tmp/env');
	});

	it('expands ~ and resolves relative paths to absolute', () => {
		expect(resolveDataDirOverride({ WHATSAGENT_DATA_DIR: '~/wa' }, ['node'], home)).toBe(
			'/Users/example/wa'
		);
		expect(resolveDataDirOverride({ WHATSAGENT_DATA_DIR: '~' }, ['node'], home)).toBe(
			'/Users/example'
		);
		const relative = resolveDataDirOverride({ WHATSAGENT_DATA_DIR: 'rel/dir' }, ['node'], home);
		expect(relative).toBe(join(process.cwd(), 'rel', 'dir'));
	});

	// The override is what makes the packaged app safe to run at all: an app
	// bundle is not a git checkout, so `assertNotLiveDbFromWorktree` takes its
	// "installed copy" exit and the live database opens without complaint.
	// Proving the *effect* (a DB where we pointed it) is the point, not the
	// string handling above.
	it('opens the database under the overridden directory', () => {
		const dir = mkdtempSync(join(tmpdir(), 'whatsagent-override-'));
		try {
			const resolved = resolveDataDirOverride({ WHATSAGENT_DATA_DIR: dir }, ['node'], home);
			expect(resolved).toBe(dir);
			const db = openDatabase({ dataDir: resolved! });
			try {
				expect(db.name).toBe(join(dir, 'whatsagent.db'));
				const applied = db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as {
					c: number;
				};
				expect(applied.c).toBeGreaterThan(0);
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * PANEL-S1 — the panel is reachable from Settings. Before this, `electron/main.js`
 * had no way to pass a panel option and no way to set `WHATSAGENT_MCP`, so the
 * shipped app rendered a feature nobody could turn on.
 *
 * Asserted through `GET /api/agent/status` rather than internals: that response
 * is what the composer and the empty state read, so it is the thing that has to
 * be right.
 */
describe('agent panel configuration (PANEL-S1)', () => {
	const savedMcpEnv = process.env.WHATSAGENT_MCP;

	afterEach(() => {
		if (savedMcpEnv === undefined) delete process.env.WHATSAGENT_MCP;
		else process.env.WHATSAGENT_MCP = savedMcpEnv;
		vi.restoreAllMocks();
	});

	async function startPanelApp(
		configure: (database: AppDatabase) => void,
		options: Parameters<typeof createApp>[0] = {}
	) {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-panel-'));
		db = openDatabase({ dataDir });
		configure(db);
		app = createApp({ db, dataDir, port: 0, staticDir: null, ...options });
		await app.start();
		const res = await fetch(`${app.url}/api/agent/status`);
		return {
			status: (await res.json()) as {
				available: boolean;
				harness: string | null;
			},
			mcp: app.mcp
		};
	}

	/** A harness that never spawns anything — the panel is built, not run. */
	const inertHarness = { id: 'opencode' as const, run: () => (async function* () {})() };

	it('builds the panel and mints the MCP surface from the settings rows alone', async () => {
		delete process.env.WHATSAGENT_MCP;
		const { status, mcp } = await startPanelApp((database) => {
			setSetting(database, 'panel_enabled', 'true');
			setSetting(database, 'panel_harness', 'opencode');
		});
		expect(status.available).toBe(true);
		// Enabling the panel implies enabling MCP: the panel has no tools without
		// it, so a toggle that left `/mcp` closed would be a toggle that does
		// nothing. The token is minted here and nowhere else.
		expect(mcp).not.toBeNull();
	});

	it('warns and stays unavailable when the row is on with no harness — and leaves /mcp closed', async () => {
		delete process.env.WHATSAGENT_MCP;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { status, mcp } = await startPanelApp((database) => {
			setSetting(database, 'panel_enabled', 'true');
		});
		expect(status.available).toBe(false);
		// No harness means no panel, and no panel means no reason to mint a
		// token — an unused token file is pure attack surface.
		expect(mcp).toBeNull();
		expect(warn.mock.calls.flat().join(' ')).toMatch(/panel_harness/);
	});

	it('does not throw on a harness id this build does not have', async () => {
		delete process.env.WHATSAGENT_MCP;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { status } = await startPanelApp((database) => {
			setSetting(database, 'panel_enabled', 'true');
			// `codex` is a drafting provider id, not a harness id. A row written by
			// an older build (or by hand) must degrade, not crash startup.
			setSetting(database, 'panel_harness', 'codex');
		});
		expect(status.available).toBe(false);
		expect(warn.mock.calls.flat().join(' ')).toMatch(/"codex"/);
	});

	it('stays unavailable when the caller shut the surface, whatever the rows say', async () => {
		delete process.env.WHATSAGENT_MCP;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { status, mcp } = await startPanelApp(
			(database) => {
				setSetting(database, 'panel_enabled', 'true');
				setSetting(database, 'panel_harness', 'claude');
			},
			// An explicit `mcp: false` is the caller overriding the row, and it wins
			// in that direction too: no surface, so no panel to run on it.
			{ mcp: false }
		);
		expect(status.available).toBe(false);
		expect(mcp).toBeNull();
		expect(warn.mock.calls.flat().join(' ')).toMatch(/explicitly off/);
	});

	it('lets an explicit option beat the row', async () => {
		delete process.env.WHATSAGENT_MCP;
		const { status } = await startPanelApp(
			(database) => {
				setSetting(database, 'panel_enabled', 'false');
				setSetting(database, 'panel_harness', 'claude');
			},
			{ mcp: true, panel: { harness: 'opencode', harnessImpl: inertHarness } }
		);
		expect(status.available).toBe(true);
		expect(status.harness).toBeNull();
	});

	it('still honours WHATSAGENT_MCP=1 with an explicit panel and no rows at all', async () => {
		process.env.WHATSAGENT_MCP = '1';
		const { status, mcp } = await startPanelApp(
			() => undefined,
			{ panel: { harness: 'opencode', harnessImpl: inertHarness } }
		);
		expect(status.available).toBe(true);
		expect(mcp).not.toBeNull();
	});

	it('lets an explicit mcp:false override the row, so the surface stays closed', async () => {
		process.env.WHATSAGENT_MCP = '1';
		const { mcp } = await startPanelApp(
			(database) => {
				setSetting(database, 'panel_enabled', 'true');
				setSetting(database, 'panel_harness', 'opencode');
			},
			{ mcp: false }
		);
		// Precedence is explicit option, then env, then the row — in that order,
		// in both directions. A settings row must never re-open a surface the
		// caller shut.
		expect(mcp).toBeNull();
	});

	it('reports not-configured with no rows and no options', async () => {
		delete process.env.WHATSAGENT_MCP;
		const { status, mcp } = await startPanelApp(() => undefined);
		expect(status).toMatchObject({ available: false });
		expect(mcp).toBeNull();
	});
});
