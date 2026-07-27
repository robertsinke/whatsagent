import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WAMessage, WAMessageKey } from 'baileys';
import type { Channel, ChannelEvent, ChannelEventListener } from './channels/channel.js';
import type { DraftProvider } from './providers/provider.js';
import { upsertChat } from './store/chats.js';
import { openDatabase, type AppDatabase } from './store/db.js';
import { getDraft } from './store/drafts.js';
import { getMessage, upsertMessage } from './store/messages.js';
import { enqueueDraftOutbox, enqueueManualOutbox, enqueueReactionOutbox, getOutbox } from './store/outbox.js';
import {
	assertSupportedPlatform,
	createApp,
	HISTORY_SYNC_COMPLETE_SETTING,
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

class FakeChannel implements Channel {
	readonly listeners = new Set<ChannelEventListener>();
	start = vi.fn(async () => undefined);
	stop = vi.fn(async () => undefined);

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
		const chatJid = '110573949866107@lid';
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
		const chatJid = '31653244557-1532101770@g.us';
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
