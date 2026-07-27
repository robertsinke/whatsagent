import { BufferJSON, generateWAMessage, makeEventBuffer } from 'baileys';
import { EventEmitter } from 'node:events';
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
	classifyMessageType,
	handleChatsUpdate,
	handleChatsUpsert,
	handleLidMappingUpdate,
	handleHistorySet,
	handleMessagesReaction,
	handleMessagesUpdate,
	handleMessagesUpsert,
	isChatMuted,
	type HistorySetPayload
} from './ingest.js';
import { downloadAndCacheMedia } from './media.js';
import {
	FIXTURE_ALT_PHONE_JID,
	FIXTURE_CHAT_LID_JID,
	FIXTURE_GROUP_JID,
	FIXTURE_OWNER_LID_JID,
	FIXTURE_OWNER_NAME,
	FIXTURE_OWNER_PHONE,
	FIXTURE_OWNER_PHONE_JID,
	FIXTURE_SPLIT_LID_JID,
	FIXTURE_SPLIT_NAME,
	FIXTURE_SPLIT_NAME_SHORT,
	FIXTURE_SPLIT_PHONE_JID
} from '../../../shared/test-fixtures.js';

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
					id: FIXTURE_OWNER_LID_JID,
					lid: FIXTURE_OWNER_LID_JID,
					phoneNumber: FIXTURE_OWNER_PHONE_JID,
					name: FIXTURE_OWNER_NAME
				}
			],
			messages: []
		});

		expect(getContact(database, FIXTURE_OWNER_LID_JID)).toMatchObject({
			name: FIXTURE_OWNER_NAME,
			lid_jid: FIXTURE_OWNER_LID_JID,
			phone_jid: FIXTURE_OWNER_PHONE_JID
		});
		expect(getContact(database, FIXTURE_OWNER_PHONE_JID)).toMatchObject({
			name: FIXTURE_OWNER_NAME,
			lid_jid: FIXTURE_OWNER_LID_JID,
			phone_jid: FIXTURE_OWNER_PHONE_JID
		});

		handleLidMappingUpdate(database, {
			lid: '999@lid',
			pn: FIXTURE_ALT_PHONE_JID
		});
		expect(getContact(database, '999@lid')?.phone_jid).toBe(FIXTURE_ALT_PHONE_JID);
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
		expect(listMessages(database, 'team@g.us')).toHaveLength(4);
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

describe('quoted-message subtypes', () => {
	// The live DB currently holds zero stored quotes — these fixtures are the
	// only evidence that ingest captures a meaningful preview per subtype.
	function loadFixture(): HistorySetPayload {
		return JSON.parse(
			readFileSync(new URL('./fixtures/message-fidelity.json', import.meta.url), 'utf8')
		) as HistorySetPayload;
	}

	it('stores a text caption as the image quote preview', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-image')).toMatchObject({
			quote_target_id: 'target-image',
			quote_type: 'image',
			quote_text: 'Sunset at the pier',
			quote_sender: 'alice@s.whatsapp.net'
		});
	});

	it('falls back to no text for an image quote without a caption', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		const quote = getMessage(database, 'quote-image-no-caption')!;
		expect(quote.quote_type).toBe('image');
		// No caption on the quoted image — the preview body is the UI's noun
		// fallback ("Photo"), not a fabricated string.
		expect(quote.quote_text).toBeNull();
	});

	it('stores a caption as the video quote preview', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-video')).toMatchObject({
			quote_type: 'video',
			quote_text: 'Clip from the gig'
		});
	});

	it('classifies a voice note quote as audio with no fabricated text', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		// Audio has no caption field — the UI renders the "Voice message" noun.
		expect(getMessage(database, 'quote-audio')).toMatchObject({
			quote_type: 'audio',
			quote_text: null
		});
	});

	it('falls back to the document title for a document quote without a caption', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-document')).toMatchObject({
			quote_type: 'document',
			quote_text: 'Contract'
		});
	});

	it('classifies a sticker quote with no fabricated text', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-sticker')).toMatchObject({
			quote_type: 'sticker',
			quote_text: null
		});
	});

	it('uses the location name as the location quote preview', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-location')).toMatchObject({
			quote_type: 'location',
			quote_text: 'Amsterdam Office'
		});
	});

	it('uses the contact display name as the contact quote preview', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-contact')).toMatchObject({
			quote_type: 'contact',
			quote_text: 'Sara Patel'
		});
	});

	it('uses the caption as the live-location quote preview', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-live-location')).toMatchObject({
			quote_type: 'location',
			quote_text: 'On my way'
		});
	});

	it('uses the array display name as the contacts-array quote preview', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		expect(getMessage(database, 'quote-contacts-array')).toMatchObject({
			quote_type: 'contact',
			quote_text: 'Two contacts'
		});
	});

	it('still classifies an unrecognized quote subtype without crashing', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		// pollCreation is not a subtype we render specially, but ingest must
		// still store a typed quote rather than dropping it.
		const quote = getMessage(database, 'quote-unrecognized')!;
		expect(quote.quote_target_id).toBe('missing-unknown');
		expect(quote.quote_type).toBe('pollCreation');
		expect(quote.quote_text).toBeNull();
	});

	it('resolves the quote type and text against the stored target message', () => {
		const database = openTempDb();
		handleHistorySet(database, loadFixture());
		// The target image is in local history, so the server-side toQuoteView
		// resolves the live type/text over the persisted snapshot.
		const target = getMessage(database, 'target-image')!;
		expect(target.type).toBe('image');
		// quote_text from the snapshot matches the target's text (caption).
		const quote = getMessage(database, 'quote-image')!;
		expect(quote.quote_text).toBe(target.text);
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

/**
 * W4-U11. An owner-sent message reaches the ingest layer the same way an
 * inbound one does: Baileys' `emitOwnEvents` re-emits the envelope it just
 * relayed as a `messages.upsert` of type `append`, carrying the stable message
 * id the pacer generated. The envelope here is the genuine article — built by
 * `generateWAMessage` — and it is driven through the genuine
 * `makeEventBuffer`, because the buffer is what consolidates and defers the
 * event in production and it is the only Baileys machinery between the send
 * and `attachIngest`.
 */
describe('owner-sent messages through the real Baileys event buffer', () => {
	const quietLogger: any = {
		info() {},
		warn() {},
		error() {},
		debug() {},
		trace() {},
		child() {
			return quietLogger;
		}
	};

	async function ownSendEnvelope(chatJid: string, text: string, messageId: string) {
		// `upload` is only reached for media; a text send never calls it.
		return generateWAMessage(chatJid, { text }, {
			userJid: '31612345678:12@s.whatsapp.net',
			messageId,
			logger: quietLogger
		} as any);
	}

	function bufferedUpsert(ev: any) {
		// Verbatim shape of `Socket/chats.js`'s `upsertMessage`.
		return ev.createBufferedFunction(async (msg: any, type: string) => {
			ev.emit('messages.upsert', { messages: [msg], type });
		});
	}

	it('publishes a from_me append exactly once, and not again on replay', async () => {
		const database = openTempDb();
		const ev: any = makeEventBuffer(quietLogger);
		const onMessageIngested = vi.fn();
		const onMessageUpdated = vi.fn();
		attachIngest(ev, database, { onMessageIngested, onMessageUpdated });
		const upsertMessage = bufferedUpsert(ev);

		const chatJid = FIXTURE_CHAT_LID_JID;
		const sent = await ownSendEnvelope(chatJid, 'So should I or you send it?', 'OWNSEND0001');
		// The stored type must be `text`, not the `system` a defaulted
		// protobuf `messageStubType` would produce.
		expect(classifyMessageType(sent)).toBe('text');

		await upsertMessage(sent, 'append');
		await vi.waitFor(() => expect(onMessageIngested).toHaveBeenCalledOnce());
		expect(onMessageIngested).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'OWNSEND0001',
				chat_jid: chatJid,
				from_me: true,
				text: 'So should I or you send it?'
			})
		);

		// The server ack can replay the same append. One copy on screen, always.
		await upsertMessage(sent, 'append');
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(onMessageIngested).toHaveBeenCalledOnce();
		expect(countMessages(database)).toBe(1);
	});

	it('leaves an owner reaction on the message-updated path', async () => {
		const database = openTempDb();
		const chatJid = FIXTURE_GROUP_JID;
		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: { id: 'REACT-TARGET', remoteJid: chatJid, fromMe: false },
					messageTimestamp: 100,
					message: { conversation: 'their message' }
				}
			]
		});

		const ev: any = makeEventBuffer(quietLogger);
		const onMessageIngested = vi.fn();
		const onMessageUpdated = vi.fn();
		attachIngest(ev, database, { onMessageIngested, onMessageUpdated });
		const upsertMessage = bufferedUpsert(ev);

		await upsertMessage(
			{
				key: { id: 'OWNREACT0001', remoteJid: chatJid, fromMe: true },
				messageTimestamp: 200,
				message: {
					reactionMessage: {
						key: { id: 'REACT-TARGET', remoteJid: chatJid, fromMe: false },
						text: '❤️',
						senderTimestampMs: 200_000
					}
				}
			},
			'append'
		);

		await vi.waitFor(() => expect(onMessageUpdated).toHaveBeenCalledOnce());
		expect(onMessageIngested).not.toHaveBeenCalled();
		expect(onMessageUpdated).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'REACT-TARGET' })
		);
		// The reaction is not a message row of its own.
		expect(getMessage(database, 'OWNREACT0001')).toBeUndefined();
		expect(listMessageReactions(database, chatJid, 'REACT-TARGET')).toEqual([
			expect.objectContaining({ emoji: '❤️' })
		]);
	});
});

/**
 * W4-U12 fragility 2. Baileys flushes a consolidated map inside one loop
 * (`Utils/event-buffer.js`: `for (const event in map) ev.emit(event, map[event])`),
 * so a handler that throws aborts the loop and every later key in that same
 * flush vanishes without a trace. The map is ordered history-set → chats →
 * messages, so the earliest key is the one that can swallow the messages.
 */
describe('a throwing handler must not drop the rest of a Baileys flush', () => {
	const quietLogger: any = {
		info() {},
		warn() {},
		error() {},
		debug() {},
		trace() {},
		child() {
			return quietLogger;
		}
	};

	it('keeps ingesting messages.upsert when messaging-history.set throws in the same flush', () => {
		const database = openTempDb();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const ev: any = makeEventBuffer(quietLogger);
		const onMessageIngested = vi.fn();
		const onHandlerError = vi.fn();
		// A realistic throw: the history handler's own consumer blows up after the
		// rows are committed — index.ts publishes to WS clients from right here.
		const onSyncProgress = vi.fn(() => {
			throw new Error('sync-progress consumer exploded');
		});
		attachIngest(ev, database, { onSyncProgress, onMessageIngested, onHandlerError });

		ev.buffer();
		ev.emit('messaging-history.set', {
			chats: [{ id: 'alice@s.whatsapp.net', conversationTimestamp: 10, unreadCount: 0 }],
			contacts: [],
			messages: [
				{
					key: { id: 'HIST0001', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 10,
					message: { conversation: 'from history' }
				}
			],
			isLatest: true,
			progress: 100,
			syncType: 2
		});
		ev.emit('messages.upsert', {
			type: 'notify',
			messages: [
				{
					key: { id: 'LIVE0001', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 20,
					message: { conversation: 'live inbound behind the throw' }
				}
			]
		});

		expect(() => ev.flush()).not.toThrow();

		// The later key survived the earlier handler's throw.
		expect(getMessage(database, 'LIVE0001')).toMatchObject({
			text: 'live inbound behind the throw'
		});
		expect(onMessageIngested).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'LIVE0001' })
		);
		// The history rows still committed — the throw was downstream of the write.
		expect(getMessage(database, 'HIST0001')).toBeDefined();

		// Contained, never silent.
		expect(onHandlerError).toHaveBeenCalledWith(
			expect.objectContaining({ event: 'messaging-history.set' })
		);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('messaging-history.set'),
			expect.any(Error)
		);
		consoleError.mockRestore();
	});

	it('keeps notifying later messages when one onMessageIngested callback throws', () => {
		const database = openTempDb();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const handlers = new Map<string, ((...args: any[]) => void)[]>();
		const ev = {
			on(event: string, handler: (...args: any[]) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}
		};
		const seen: string[] = [];
		const onMessageIngested = vi.fn((message: { id: string }) => {
			seen.push(message.id);
			if (message.id === 'FANOUT01') throw new Error('consumer exploded');
		});
		attachIngest(ev, database, { onMessageIngested });

		for (const handler of handlers.get('messages.upsert') ?? []) {
			handler({
				type: 'notify',
				messages: ['FANOUT01', 'FANOUT02', 'FANOUT03'].map((id, index) => ({
					key: { id, remoteJid: 'alice@s.whatsapp.net', fromMe: false },
					messageTimestamp: 30 + index,
					message: { conversation: id }
				}))
			});
		}

		// One bad consumer call must not take its siblings down with it.
		expect(seen).toEqual(['FANOUT01', 'FANOUT02', 'FANOUT03']);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
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

/**
 * W4-U13. WhatsApp is migrating contacts to LID addressing, so the same person
 * starts arriving under a second identifier mid-conversation. Reproduces a
 * live split: the owner's approved reply went to the phone chat holding
 * history, and the contact's answer later arrived keyed by LID and opened an
 * empty second chat.
 */
describe('canonical chat identity across LID and phone aliases', () => {
	const LID = FIXTURE_SPLIT_LID_JID;
	const PHONE = FIXTURE_SPLIT_PHONE_JID;

	function seedPhoneChatWithHistory(database: AppDatabase): void {
		handleHistorySet(database, {
			chats: [{ id: PHONE, name: FIXTURE_SPLIT_NAME, conversationTimestamp: 100, unreadCount: 0 }],
			contacts: [{ id: PHONE, name: FIXTURE_SPLIT_NAME }],
			messages: [
				{
					key: { id: 'history-1', remoteJid: PHONE, fromMe: false },
					messageTimestamp: 100,
					message: { conversation: 'eerder bericht' }
				}
			]
		});
	}

	it('lands a LID-keyed reply in the existing phone chat when the mapping is known', () => {
		const database = openTempDb();
		seedPhoneChatWithHistory(database);
		handleLidMappingUpdate(database, { lid: LID, pn: PHONE });

		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: { id: 'reply-1', remoteJid: LID, fromMe: false },
					messageTimestamp: 200,
					message: { conversation: 'ja doe maar' }
				}
			]
		});

		expect(listChats(database).map((chat) => chat.jid)).toEqual([PHONE]);
		expect(getMessage(database, 'reply-1')?.chat_jid).toBe(PHONE);
		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['history-1', 'reply-1']);
		expect(getChat(database, PHONE)).toMatchObject({ last_msg_at: 200, unread: 1 });
	});

	it('canonicalises from the key alone, before any mapping event has arrived', () => {
		const database = openTempDb();
		seedPhoneChatWithHistory(database);

		// `remoteJid` + `remoteJidAlt` on the key IS the mapping. Learning it here
		// is what lets this very message land on the chat that already exists.
		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: { id: 'reply-1', remoteJid: LID, remoteJidAlt: PHONE, fromMe: false },
					messageTimestamp: 200,
					message: { conversation: 'ja doe maar' }
				}
			]
		});

		expect(listChats(database).map((chat) => chat.jid)).toEqual([PHONE]);
		expect(getMessage(database, 'reply-1')?.chat_jid).toBe(PHONE);
	});

	it('keeps an unmapped LID chat rather than dropping the message', () => {
		const database = openTempDb();
		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: { id: 'reply-1', remoteJid: LID, fromMe: false },
					messageTimestamp: 200,
					message: { conversation: 'wie ben ik' }
				}
			]
		});

		expect(listChats(database).map((chat) => chat.jid)).toEqual([LID]);
		expect(getMessage(database, 'reply-1')?.chat_jid).toBe(LID);
	});

	it('converges two existing chats when the mapping arrives afterwards', () => {
		const database = openTempDb();
		seedPhoneChatWithHistory(database);
		// Split: the reply arrives before anything knows the two are one person.
		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: { id: 'reply-1', remoteJid: LID, fromMe: false },
					messageTimestamp: 200,
					message: { conversation: 'ja doe maar' }
				}
			]
		});
		expect(listChats(database)).toHaveLength(2);

		expect(handleLidMappingUpdate(database, { lid: LID, pn: PHONE })).toEqual({
			from: LID,
			to: PHONE
		});

		expect(listChats(database).map((chat) => chat.jid)).toEqual([PHONE]);
		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['history-1', 'reply-1']);
		expect(getChat(database, PHONE)).toMatchObject({ last_msg_at: 200, unread: 1 });
	});

	it('does not let a chats.update under the old LID resurrect the merged row', () => {
		const database = openTempDb();
		seedPhoneChatWithHistory(database);
		handleLidMappingUpdate(database, { lid: LID, pn: PHONE });

		handleChatsUpsert(database, [{ id: LID, name: FIXTURE_SPLIT_NAME_SHORT, conversationTimestamp: 300 }]);
		handleChatsUpdate(database, [{ id: LID, unreadCount: 4 }]);

		expect(listChats(database).map((chat) => chat.jid)).toEqual([PHONE]);
		expect(getChat(database, PHONE)).toMatchObject({ last_msg_at: 300, unread: 4 });
	});

	it('announces the merge to consumers only after the transaction commits', () => {
		const database = openTempDb();
		seedPhoneChatWithHistory(database);
		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: { id: 'reply-1', remoteJid: LID, fromMe: false },
					messageTimestamp: 200,
					message: { conversation: 'ja doe maar' }
				}
			]
		});

		const ev = new EventEmitter();
		const onChatsMerged = vi.fn(() => {
			// The consumer must never see the losing chat: by the time it is told,
			// the row is gone and every reference points at the survivor.
			expect(getChat(database, LID)).toBeUndefined();
		});
		attachIngest(ev, database, { onChatsMerged });

		ev.emit('lid-mapping.update', { lid: LID, pn: PHONE });

		expect(onChatsMerged).toHaveBeenCalledWith({ from: LID, to: PHONE });
		expect(listChats(database).map((chat) => chat.jid)).toEqual([PHONE]);
	});
});

describe('W4-U16: stop rendering people as phone numbers', () => {
	it('ingest stores a phone-shaped chat name as null (history sync)', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [
				{
					id: '31612345678@s.whatsapp.net',
					// The WhatsApp privacy mask — stored verbatim today.
					name: '+31 \u2219\u2219\u2219\u2219 85',
					conversationTimestamp: 100
				}
			],
			contacts: [],
			messages: []
		});

		const chat = getChat(database, '31612345678@s.whatsapp.net');
		expect(chat?.name).toBeNull();
	});

	it('ingest stores a bare-number chat name as null too', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [
				{
					id: '31612345678@s.whatsapp.net',
					name: `+${FIXTURE_OWNER_PHONE}`,
					conversationTimestamp: 100
				}
			],
			contacts: [],
			messages: []
		});
		expect(getChat(database, '31612345678@s.whatsapp.net')?.name).toBeNull();
	});

	it('ingest keeps a real contact name (non-Latin included)', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [
				{ id: 'a@s.whatsapp.net', name: '李明', conversationTimestamp: 1 },
				{ id: 'b@s.whatsapp.net', name: 'Александр', conversationTimestamp: 1 },
				{ id: 'c@s.whatsapp.net', name: 'محمد', conversationTimestamp: 1 }
			],
			contacts: [],
			messages: []
		});
		expect(getChat(database, 'a@s.whatsapp.net')?.name).toBe('李明');
		expect(getChat(database, 'b@s.whatsapp.net')?.name).toBe('Александр');
		expect(getChat(database, 'c@s.whatsapp.net')?.name).toBe('محمد');
	});

	it('a live message with pushName populates contacts.push_name', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: '31612345678@s.whatsapp.net', conversationTimestamp: 100 }],
			contacts: [],
			messages: []
		});

		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: {
						id: 'live-1',
						remoteJid: '31612345678@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 200,
					message: { conversation: 'hi' },
					pushName: 'Felix'
				}
			]
		});

		expect(getContact(database, '31612345678@s.whatsapp.net')?.push_name).toBe('Felix');
	});

	it('a live pushName does not overwrite an existing address-book name', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: '31612345678@s.whatsapp.net', conversationTimestamp: 100 }],
			contacts: [
				{ id: '31612345678@s.whatsapp.net', name: 'Felix de G.' }
			],
			messages: []
		});

		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: {
						id: 'live-1',
						remoteJid: '31612345678@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 200,
					message: { conversation: 'hi' },
					pushName: 'felix-phone-self-name'
				}
			]
		});

		// The address-book name survives; the push_name is recorded too.
		const contact = getContact(database, '31612345678@s.whatsapp.net');
		expect(contact?.name).toBe('Felix de G.');
		expect(contact?.push_name).toBe('felix-phone-self-name');
	});

	it('a phone-shaped pushName is not stored as a push name', () => {
		const database = openTempDb();
		handleHistorySet(database, {
			chats: [{ id: '31612345678@s.whatsapp.net', conversationTimestamp: 100 }],
			contacts: [],
			messages: []
		});

		handleMessagesUpsert(database, {
			type: 'notify',
			messages: [
				{
					key: {
						id: 'live-1',
						remoteJid: '31612345678@s.whatsapp.net',
						fromMe: false
					},
					messageTimestamp: 200,
					message: { conversation: 'hi' },
					pushName: '+31 \u2219\u2219 85'
				}
			]
		});

		// A phone-shaped pushName is dropped by `usableName`, so no contact row
		// is created and the chat falls through to its number on render — the
		// mask never reaches the contact table.
		const contact = getContact(database, '31612345678@s.whatsapp.net');
		expect(contact).toBeUndefined();
	});

	it('a chat.update carrying a mask strips it on the way in', () => {
		const database = openTempDb();
		// Seed a real-named chat first.
		handleHistorySet(database, {
			chats: [{ id: '31612345678@s.whatsapp.net', name: 'Felix', conversationTimestamp: 1 }],
			contacts: [],
			messages: []
		});
		expect(getChat(database, '31612345678@s.whatsapp.net')?.name).toBe('Felix');

		// A subsequent chat.update arrives with the mask.
		handleChatsUpdate(database, [
			{
				id: '31612345678@s.whatsapp.net',
				name: '+31 \u2219\u2219\u2219\u2219 85'
			}
		]);
		expect(getChat(database, '31612345678@s.whatsapp.net')?.name).toBeNull();
	});
});
