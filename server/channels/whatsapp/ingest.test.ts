import { BufferJSON } from 'baileys';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChat, listChats } from '../../store/chats.js';
import { getContact } from '../../store/contacts.js';
import { openDatabase, type AppDatabase } from '../../store/db.js';
import {
	countMessages,
	getMessage,
	listMessageReactions,
	listMessages
} from '../../store/messages.js';
import { deepenChatHistory } from './history.js';
import {
	attachIngest,
	handleLidMappingUpdate,
	handleHistorySet,
	handleMessagesReaction,
	handleMessagesUpdate,
	handleMessagesUpsert,
	isChatMuted,
	type HistorySetPayload
} from './ingest.js';
import { downloadAndCacheMedia } from './media.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-ingest-'));
	db = openDatabase({ dataDir });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('ingest helpers', () => {
	it('treats future muteEndTime and -1 as muted', () => {
		expect(isChatMuted(-1)).toBe(true);
		expect(isChatMuted(Date.now() + 60_000)).toBe(true);
		expect(isChatMuted(Math.floor(Date.now() / 1000) + 3_600)).toBe(true);
		expect(isChatMuted(Date.now() - 60_000)).toBe(false);
		expect(isChatMuted(null)).toBe(false);
		expect(isChatMuted(undefined)).toBe(false);
	});

	it('links LID and phone aliases while preserving the saved contact name', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [],
			contacts: [
				{
					id: '203663104602149@lid',
					lid: '203663104602149@lid',
					phoneNumber: '31683799485@s.whatsapp.net',
					name: 'Robert'
				}
			],
			messages: []
		});

		expect(getContact(database, '203663104602149@lid')).toMatchObject({
			name: 'Robert',
			lid_jid: '203663104602149@lid',
			phone_jid: '31683799485@s.whatsapp.net'
		});
		expect(getContact(database, '31683799485@s.whatsapp.net')).toMatchObject({
			name: 'Robert',
			lid_jid: '203663104602149@lid',
			phone_jid: '31683799485@s.whatsapp.net'
		});

		handleLidMappingUpdate(database, {
			lid: '999@lid',
			pn: '31123456789@s.whatsapp.net'
		});
		expect(getContact(database, '999@lid')?.phone_jid).toBe(
			'31123456789@s.whatsapp.net'
		);
	});
});

describe('messaging-history.set', () => {
	it('normalizes group senders, quotes, and historical reactions from a fixture', () => {
		const database = openTempDb();
		const fixture = JSON.parse(
			readFileSync(new URL('./fixtures/message-fidelity.json', import.meta.url), 'utf8')
		) as HistorySetPayload;

		handleHistorySet(database, fixture);
		const messages = listMessages(database, 'team@g.us');

		expect(messages.map((message) => message.id)).toEqual([
			'group-target',
			'group-bob',
			'quote-resolved',
			'quote-missing'
		]);
		expect(messages.map((message) => message.sender)).toEqual([
			'alice@s.whatsapp.net',
			'222@lid',
			'unknown@s.whatsapp.net',
			'alice@s.whatsapp.net'
		]);
		expect(getMessage(database, 'quote-resolved')).toMatchObject({
			quote_target_id: 'group-target',
			quote_sender: 'alice@s.whatsapp.net',
			quote_type: 'text',
			quote_text: 'Original text'
		});
		expect(getMessage(database, 'quote-missing')).toMatchObject({
			quote_target_id: 'missing-target',
			quote_sender: '222@lid',
			quote_type: 'image',
			quote_text: 'Fallback caption'
		});
		expect(listMessageReactions(database, 'team@g.us', 'group-target')).toMatchObject([
			{ actor: 'alice@s.whatsapp.net', emoji: '👍' },
			{ actor: '222@lid', emoji: '👍' }
		]);

		// Full replay remains duplicate-free for messages and reaction actors.
		handleHistorySet(database, fixture);
		expect(countMessages(database)).toBe(4);
		expect(listMessageReactions(database, 'team@g.us', 'group-target')).toHaveLength(2);
	});

	it('persists chats, contacts, and messages with kind / from_me / timestamps', () => {
		const database = openTempDb();
		const progress = handleHistorySet(database, {
			progress: 40,
			isLatest: false,
			chats: [
				{
					id: 'alice@s.whatsapp.net',
					name: 'Alice',
					conversationTimestamp: 1_700_000_100,
					unreadCount: 2,
					muteEndTime: -1,
					archived: false
				},
				{
					id: 'family@g.us',
					name: 'Family',
					conversationTimestamp: 1_700_000_050,
					unreadCount: 0,
					archived: true
				}
			],
			contacts: [
				{ id: 'alice@s.whatsapp.net', name: 'Alice Smith', notify: 'Ali' },
				{ id: 'bob@s.whatsapp.net', notify: 'Bobby' }
			],
			messages: [
				{
					key: {
						id: 'm-alice-1',
						remoteJid: 'alice@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 1_700_000_100,
					message: { conversation: 'hallo' }
				},
				{
					key: {
						id: 'm-alice-2',
						remoteJid: 'alice@s.whatsapp.net',
						fromMe: true
					},
					messageTimestamp: 1_700_000_090,
					message: { conversation: 'hoi' }
				},
				{
					key: {
						id: 'm-group-1',
						remoteJid: 'family@g.us',
						participant: 'bob@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 1_700_000_050,
					message: { conversation: 'ping' }
				}
			]
		});

		// Batch counts are the only honest sync unit — Baileys never sends a total (D5).
	expect(progress).toEqual({ progress: 40, isLatest: false, chats: 2, messages: 3 });

		const chats = listChats(database);
		expect(chats.map((c) => c.jid)).toEqual(['alice@s.whatsapp.net', 'family@g.us']);
		expect(getChat(database, 'alice@s.whatsapp.net')).toMatchObject({
			kind: '1:1',
			name: 'Alice',
			muted: true,
			archived: false,
			unread: 2,
			last_msg_at: 1_700_000_100
		});
		expect(getChat(database, 'family@g.us')).toMatchObject({
			kind: 'group',
			archived: true
		});

		expect(getContact(database, 'alice@s.whatsapp.net')).toMatchObject({
			name: 'Alice Smith',
			push_name: 'Ali'
		});

		const aliceMsgs = listMessages(database, 'alice@s.whatsapp.net');
		expect(aliceMsgs).toHaveLength(2);
		expect(aliceMsgs[0]).toMatchObject({
			id: 'm-alice-2',
			from_me: true,
			text: 'hoi',
			type: 'text'
		});
		expect(aliceMsgs[1]).toMatchObject({
			id: 'm-alice-1',
			from_me: false,
			text: 'hallo'
		});

		const stored = getMessage(database, 'm-alice-1');
		const envelope = JSON.parse(stored!.raw!, BufferJSON.reviver);
		expect(envelope.message).toEqual({ conversation: 'hallo' });
		expect(envelope.key.id).toBe('m-alice-1');
	});

	it('history batch with already-ingested ids stays duplicate-free', () => {
		const database = openTempDb();
		const payload = {
			chats: [
				{
					id: 'alice@s.whatsapp.net',
					name: 'Alice',
					conversationTimestamp: 100,
					unreadCount: 0
				}
			],
			contacts: [] as { id: string }[],
			messages: [
				{
					key: {
						id: 'dup-id',
						remoteJid: 'alice@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 100,
					message: { conversation: 'first' }
				}
			]
		};

		handleHistorySet(database, payload);
		handleHistorySet(database, {
			...payload,
			messages: [
				{
					key: {
						id: 'dup-id',
						remoteJid: 'alice@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 100,
					message: { conversation: 'second' }
				}
			]
		});

		expect(countMessages(database)).toBe(1);
		expect(getMessage(database, 'dup-id')?.text).toBe('second');
	});

	it('ingests sticker and call-log placeholders without rendering reactions as messages', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: 'alice@s.whatsapp.net', name: 'Alice', conversationTimestamp: 1 }],
			contacts: [],
			messages: [
				{
					key: { id: 'sticker-1', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 1,
					message: { stickerMessage: { url: 'https://example/sticker' } }
				},
				{
					key: { id: 'reaction-1', remoteJid: 'alice@s.whatsapp.net', fromMe: true },
					messageTimestamp: 2,
					message: {
						reactionMessage: {
							text: '👍',
							key: { id: 'sticker-1', remoteJid: 'alice@s.whatsapp.net' }
						}
					}
				},
				{
					key: { id: 'call-1', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 3,
					messageStubType: 40,
					message: undefined
				}
			]
		});

		const msgs = listMessages(database, 'alice@s.whatsapp.net');
		expect(msgs.map((m) => [m.id, m.type, m.text])).toEqual([
			['sticker-1', 'sticker', null],
			['call-1', 'call', null]
		]);
		expect(countMessages(database)).toBe(2);
		expect(listMessageReactions(database, 'alice@s.whatsapp.net', 'sticker-1')).toMatchObject([
			{ actor: 'me', emoji: '👍' }
		]);
	});
});

describe('messages.upsert (live)', () => {
	it('notify upserts bump last_msg_at and unread', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [
				{
					id: 'alice@s.whatsapp.net',
					name: 'Alice',
					conversationTimestamp: 100,
					unreadCount: 0
				}
			],
			contacts: [],
			messages: []
		});

		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: {
						id: 'live-1',
						remoteJid: 'alice@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 200,
					message: { conversation: 'nieuw' }
				}
			]
		});

		expect(getChat(database, 'alice@s.whatsapp.net')).toMatchObject({
			last_msg_at: 200,
			unread: 1
		});
		expect(getMessage(database, 'live-1')?.text).toBe('nieuw');

		// Own outbound notify must not increment unread.
		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: {
						id: 'live-2',
						remoteJid: 'alice@s.whatsapp.net',
						fromMe: true
					},
					messageTimestamp: 300,
					message: { conversation: 'antwoord' }
				}
			]
		});
		expect(getChat(database, 'alice@s.whatsapp.net')).toMatchObject({
			last_msg_at: 300,
			unread: 1
		});
	});
});

describe('live reaction updates', () => {
	it('adds, changes, and removes one actor reaction across installed Baileys payload shapes', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: 'team@g.us', conversationTimestamp: 1 }],
			contacts: [],
			messages: [
				{
					key: { id: 'target', remoteJid: 'team@g.us', participant: 'alice@s.whatsapp.net' },
					messageTimestamp: 1,
					message: { conversation: 'hello' }
				}
			]
		});

		expect(
			handleMessagesReaction(database, [
				{
					key: { id: 'target', remoteJid: 'team@g.us' },
					reaction: {
						key: { id: 'reaction', remoteJid: 'team@g.us', participant: 'bob@s.whatsapp.net' },
						text: '👍',
						senderTimestampMs: 2
					}
				}
			])
		).toEqual(['target']);
		expect(
			handleMessagesUpdate(database, [
				{
					key: { id: 'target', remoteJid: 'team@g.us' },
					update: {
						reactions: [
							{
								key: { id: 'reaction', remoteJid: 'team@g.us', participant: 'bob@s.whatsapp.net' },
								text: '❤️',
								senderTimestampMs: 3
							}
						]
					}
				}
			])
		).toEqual(['target']);
		expect(listMessageReactions(database, 'team@g.us', 'target')).toMatchObject([
			{ actor: 'bob@s.whatsapp.net', emoji: '❤️' }
		]);

		handleMessagesReaction(database, [
			{
				key: { id: 'target', remoteJid: 'team@g.us' },
				reaction: {
					key: { id: 'reaction', remoteJid: 'team@g.us', participant: 'bob@s.whatsapp.net' },
					text: '',
					senderTimestampMs: 4
				}
			}
		]);
		expect(listMessageReactions(database, 'team@g.us', 'target')).toEqual([]);
	});
});

describe('attachIngest + mute/archive updates', () => {
	it('wires socket events and applies chats.update mute/archive flags', () => {
		const database = openTempDb();
		const handlers = new Map<string, ((...args: any[]) => void)[]>();
		const ev = {
			on(event: string, handler: (...args: any[]) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}
		};
		const onSyncProgress = vi.fn();
		const onMessageIngested = vi.fn();
		const onMessageUpdated = vi.fn();
		attachIngest(ev, database, { onSyncProgress, onMessageIngested, onMessageUpdated });

		for (const handler of handlers.get('messaging-history.set') ?? []) {
			handler({
				progress: 100,
				isLatest: true,
				chats: [
					{
						id: 'alice@s.whatsapp.net',
						name: 'Alice',
						conversationTimestamp: 10,
						unreadCount: 0,
						muteEndTime: null,
						archived: false
					}
				],
				contacts: [],
				messages: []
			});
		}
		expect(onSyncProgress).toHaveBeenCalledWith({
		progress: 100,
		isLatest: true,
		chats: 1,
		messages: 0
	});

		for (const handler of handlers.get('chats.update') ?? []) {
			handler([
				{
					id: 'alice@s.whatsapp.net',
					muteEndTime: Date.now() + 3_600_000,
					archived: true
				}
			]);
		}

		expect(getChat(database, 'alice@s.whatsapp.net')).toMatchObject({
			muted: true,
			archived: true,
			name: 'Alice'
		});

		const live = {
			type: 'notify' as const,
			messages: [
				{
					key: { id: 'live-once', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 20,
					message: { conversation: 'new inbound' }
				}
			]
		};
		for (const handler of handlers.get('messages.upsert') ?? []) handler(live);
		for (const handler of handlers.get('messages.upsert') ?? []) handler(live);
		expect(onMessageIngested).toHaveBeenCalledOnce();
		expect(onMessageIngested).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'live-once', text: 'new inbound' })
		);
		expect(getChat(database, 'alice@s.whatsapp.net')?.unread).toBe(1);

		for (const handler of handlers.get('messages.reaction') ?? []) {
			handler([
				{
					key: { id: 'live-once', remoteJid: 'alice@s.whatsapp.net' },
					reaction: {
						key: { id: 'reaction-live', remoteJid: 'alice@s.whatsapp.net', fromMe: true },
						text: '🔥'
					}
				}
			]);
		}
		expect(onMessageUpdated).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'live-once' })
		);
	});
});

describe('history deepen + media download', () => {
	it('deepenChatHistory calls fetchMessageHistory with the oldest stored key', async () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: 'alice@s.whatsapp.net', conversationTimestamp: 200 }],
			contacts: [],
			messages: [
				{
					key: { id: 'old', remoteJid: 'alice@s.whatsapp.net', fromMe: true },
					messageTimestamp: 100,
					message: { conversation: 'earlier' }
				},
				{
					key: { id: 'new', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 200,
					message: { conversation: 'later' }
				}
			]
		});

		const fetchMessageHistory = vi.fn().mockResolvedValue('session-1');
		const result = await deepenChatHistory(database, fetchMessageHistory, 'alice@s.whatsapp.net', 25);

		expect(result).toEqual({
			requested: true,
			sessionId: 'session-1',
			oldestMsgId: 'old'
		});
		expect(fetchMessageHistory).toHaveBeenCalledWith(
			25,
			expect.objectContaining({
				id: 'old',
				remoteJid: 'alice@s.whatsapp.net',
				fromMe: true
			}),
			100
		);
	});

	it('downloadAndCacheMedia writes bytes under dataDir/media and sets media_ref', async () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: 'alice@s.whatsapp.net', conversationTimestamp: 1 }],
			contacts: [],
			messages: [
				{
					key: { id: 'img-1', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 1,
					message: {
						imageMessage: {
							url: 'https://example/img',
							mimetype: 'image/jpeg'
						}
					}
				}
			]
		});

		const bytes = Buffer.from('fake-image-bytes');
		const result = await downloadAndCacheMedia(database, 'img-1', {
			dataDir: dataDir!,
			download: async () => bytes
		});

		expect(result.mediaRef).toMatch(/^media[/\\][a-f0-9]{64}\.jpg$/);
		expect(result.bytes).toBe(bytes.byteLength);
		expect(readFileSync(join(dataDir!, result.mediaRef))).toEqual(bytes);
		expect(getMessage(database, 'img-1')?.media_ref).toBe(result.mediaRef);
		expect(getMessage(database, 'img-1')?.type).toBe('image');
	});
});
