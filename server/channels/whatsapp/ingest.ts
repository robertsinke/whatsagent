import {
	BufferJSON,
	extractMessageContent,
	getContentType,
	isJidGroup,
	type Chat,
	type ChatUpdate,
	type Contact,
	type LIDMapping,
	type MessageUpsertType,
	type WAMessage
} from 'baileys';
import { getChat, upsertChat, type ChatKind } from '../../store/chats.js';
import {
	getContact,
	linkContactIdentity,
	upsertContact
} from '../../store/contacts.js';
import type { AppDatabase } from '../../store/db.js';
import { getMessage, upsertMessage, type Message } from '../../store/messages.js';

export type HistorySetPayload = {
	chats: Chat[];
	contacts: Contact[];
	messages: WAMessage[];
	isLatest?: boolean;
	progress?: number | null;
};

export type MessagesUpsertPayload = {
	messages: WAMessage[];
	type: MessageUpsertType;
};

export type SyncProgress = {
	/** Baileys' own percentage. Kept for logs; the UI must not render it (D5). */
	progress: number | null;
	isLatest: boolean;
	/** Chats in this batch. Baileys never tells us the total, so counts only. */
	chats: number;
	/** Messages in this batch. */
	messages: number;
};

export type IngestListener = {
	on(event: string, handler: (...args: any[]) => void): unknown;
};

export type AttachIngestOptions = {
	onSyncProgress?: (progress: SyncProgress) => void;
	onMessageIngested?: (message: Message) => void;
};

type ContactPatch = Partial<Contact> & Pick<Contact, 'id'>;

type LongLike = { toNumber(): number };

function toNumber(value: number | LongLike | null | undefined): number | null {
	if (value == null) return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'object' && typeof value.toNumber === 'function') {
		const n = value.toNumber();
		return Number.isFinite(n) ? n : null;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export function chatKindFromJid(jid: string): ChatKind {
	return isJidGroup(jid) ? 'group' : '1:1';
}

/** Normalize WA timestamps that may be seconds or milliseconds. */
function toMillis(value: number): number {
	return value > 0 && value < 1e12 ? value * 1000 : value;
}

/** WhatsApp mute: end-time in the future (or -1 forever) means muted. */
export function isChatMuted(muteEndTime: number | LongLike | null | undefined): boolean {
	const end = toNumber(muteEndTime);
	if (end == null) return false;
	if (end < 0) return true; // forever
	return toMillis(end) > Date.now();
}

export function classifyMessageType(msg: WAMessage): string {
	if (msg.messageStubType != null) {
		const stub = Number(msg.messageStubType);
		// Common call-related stubs; anything else still gets a typed placeholder.
		if (stub === 40 || stub === 41 || stub === 42 || stub === 46 || stub === 50) {
			return 'call';
		}
		return 'system';
	}

	const content = extractMessageContent(msg.message);
	const key = getContentType(content);
	if (!key) return 'unknown';

	switch (key) {
		case 'conversation':
		case 'extendedTextMessage':
			return 'text';
		case 'imageMessage':
			return 'image';
		case 'videoMessage':
			return 'video';
		case 'audioMessage':
			return 'audio';
		case 'documentMessage':
			return 'document';
		case 'stickerMessage':
			return 'sticker';
		case 'reactionMessage':
			return 'reaction';
		case 'contactMessage':
		case 'contactsArrayMessage':
			return 'contact';
		case 'locationMessage':
		case 'liveLocationMessage':
			return 'location';
		default:
			return key.replace(/Message$/, '') || 'unknown';
	}
}

export function extractMessageText(msg: WAMessage): string | null {
	const content = extractMessageContent(msg.message);
	if (!content) return null;

	if (typeof content.conversation === 'string' && content.conversation.length > 0) {
		return content.conversation;
	}
	if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
	if (content.imageMessage?.caption) return content.imageMessage.caption;
	if (content.videoMessage?.caption) return content.videoMessage.caption;
	if (content.documentMessage?.caption) return content.documentMessage.caption;
	if (content.reactionMessage?.text) return content.reactionMessage.text;
	return null;
}

function chatJidFromMessage(msg: WAMessage): string | undefined {
	const key = msg.key;
	if (!key) return undefined;
	// Group messages: remoteJid is the group; 1:1 uses remoteJid (or remoteJidAlt).
	return key.remoteJid ?? key.remoteJidAlt ?? undefined;
}

function lidPhonePair(
	first: string | null | undefined,
	second: string | null | undefined
): LIDMapping | undefined {
	if (!first || !second || first === second) return undefined;
	if (first.endsWith('@lid') && second.endsWith('@s.whatsapp.net')) {
		return { lid: first, pn: second };
	}
	if (second.endsWith('@lid') && first.endsWith('@s.whatsapp.net')) {
		return { lid: second, pn: first };
	}
	return undefined;
}

export function handleLidMappingUpdate(db: AppDatabase, mapping: LIDMapping): void {
	const pair = lidPhonePair(mapping.lid, mapping.pn);
	if (!pair) return;
	linkContactIdentity(db, { lidJid: pair.lid, phoneJid: pair.pn });
}

/**
 * Upsert a chat while preserving unspecified fields from any existing row.
 * Always runs before message/draft/outbox writes (FK order).
 */
export function upsertChatMerged(
	db: AppDatabase,
	input: {
		jid: string;
		name?: string | null;
		kind?: ChatKind;
		last_msg_at?: number | null;
		unread?: number;
		muted?: boolean;
		archived?: boolean;
		agent_state?: string | null;
	}
): void {
	const existing = getChat(db, input.jid);
	upsertChat(db, {
		jid: input.jid,
		channel: existing?.channel ?? 'whatsapp',
		name: input.name !== undefined ? input.name : (existing?.name ?? null),
		kind: input.kind ?? existing?.kind ?? chatKindFromJid(input.jid),
		last_msg_at:
			input.last_msg_at !== undefined ? input.last_msg_at : (existing?.last_msg_at ?? null),
		unread: input.unread !== undefined ? input.unread : (existing?.unread ?? 0),
		muted: input.muted !== undefined ? input.muted : (existing?.muted ?? false),
		archived: input.archived !== undefined ? input.archived : (existing?.archived ?? false),
		agent_state:
			input.agent_state !== undefined ? input.agent_state : (existing?.agent_state ?? null)
	});
}

export function ingestBaileysChat(db: AppDatabase, chat: Chat): void {
	const jid = chat.id;
	if (!jid) return;

	const ts =
		toNumber(chat.conversationTimestamp) ??
		toNumber(chat.lastMsgTimestamp) ??
		toNumber(chat.lastMessageRecvTimestamp);

	upsertChatMerged(db, {
		jid,
		name: chat.name ?? chat.displayName ?? undefined,
		kind: chatKindFromJid(jid),
		last_msg_at: ts ?? undefined,
		unread: chat.unreadCount != null ? Number(chat.unreadCount) : undefined,
		muted: chat.muteEndTime !== undefined ? isChatMuted(chat.muteEndTime) : undefined,
		archived: chat.archived != null ? Boolean(chat.archived) : undefined
	});
}

export function ingestBaileysChatUpdate(db: AppDatabase, update: ChatUpdate): void {
	const jid = update.id;
	if (!jid) return;

	// Ensure the chat row exists before applying a partial update.
	upsertChatMerged(db, { jid, kind: chatKindFromJid(jid) });

	const patch: Parameters<typeof upsertChatMerged>[1] = { jid };
	if (update.name !== undefined || update.displayName !== undefined) {
		patch.name = update.name ?? update.displayName ?? null;
	}
	if (update.conversationTimestamp !== undefined || update.lastMsgTimestamp !== undefined) {
		patch.last_msg_at =
			toNumber(update.conversationTimestamp) ?? toNumber(update.lastMsgTimestamp);
	}
	if (update.unreadCount !== undefined) {
		patch.unread = update.unreadCount == null ? 0 : Number(update.unreadCount);
	}
	if (update.muteEndTime !== undefined) {
		patch.muted = isChatMuted(update.muteEndTime);
	}
	if (update.archived !== undefined) {
		patch.archived = Boolean(update.archived);
	}
	upsertChatMerged(db, patch);
}

export function ingestBaileysContact(db: AppDatabase, contact: ContactPatch): void {
	if (!contact.id) return;
	const name = contact.name ?? contact.verifiedName ?? null;
	const pushName = contact.notify ?? null;
	const lidJid = contact.lid ?? (contact.id.endsWith('@lid') ? contact.id : undefined);
	const phoneJid =
		contact.phoneNumber ??
		(contact.id.endsWith('@s.whatsapp.net') ? contact.id : undefined);

	if (lidJid && phoneJid) {
		linkContactIdentity(db, { lidJid, phoneJid, name, pushName });
		return;
	}

	const existing = getContact(db, contact.id);
	upsertContact(db, {
		jid: contact.id,
		channel: 'whatsapp',
		name,
		push_name: pushName,
		lid_jid: lidJid ?? existing?.lid_jid ?? null,
		phone_jid: phoneJid ?? existing?.phone_jid ?? null
	});
}

export function ingestBaileysMessage(
	db: AppDatabase,
	msg: WAMessage,
	options: { bumpUnread?: boolean } = {}
): void {
	const id = msg.key?.id;
	const chatJid = chatJidFromMessage(msg);
	if (!id || !chatJid) return;

	const fromMe = Boolean(msg.key?.fromMe);
	const ts = toNumber(msg.messageTimestamp) ?? Date.now();
	const type = classifyMessageType(msg);
	const text = extractMessageText(msg);
	const sender = fromMe
		? null
		: (msg.key?.participant ?? msg.participant ?? chatJid);
	const chatIdentity = lidPhonePair(msg.key?.remoteJid, msg.key?.remoteJidAlt);
	if (chatIdentity) handleLidMappingUpdate(db, chatIdentity);
	const senderIdentity = lidPhonePair(msg.key?.participant, msg.key?.participantAlt);
	if (senderIdentity) handleLidMappingUpdate(db, senderIdentity);

	// FK: chat row must exist before the message row.
	const existing = getChat(db, chatJid);
	const existingMessage = getMessage(db, id);
	const nextLast = existing?.last_msg_at == null ? ts : Math.max(existing.last_msg_at, ts);
	let unread = existing?.unread ?? 0;
	if (options.bumpUnread && !fromMe && !existingMessage) unread += 1;

	upsertChatMerged(db, {
		jid: chatJid,
		kind: chatKindFromJid(chatJid),
		last_msg_at: nextLast,
		unread
	});

	upsertMessage(db, {
		id,
		chat_jid: chatJid,
		channel: 'whatsapp',
		from_me: fromMe,
		sender,
		ts,
		type,
		text,
		media_ref: null,
		// Full WAMessage envelope — required for getMessage(key) → .message retries.
		raw: JSON.stringify(msg, BufferJSON.replacer)
	});
}

export function handleHistorySet(db: AppDatabase, payload: HistorySetPayload): SyncProgress {
	const apply = db.transaction(() => {
		for (const chat of payload.chats) ingestBaileysChat(db, chat);
		for (const contact of payload.contacts) ingestBaileysContact(db, contact);
		for (const message of payload.messages) {
			ingestBaileysMessage(db, message, { bumpUnread: false });
		}
	});
	apply();

	return {
		progress: payload.progress ?? null,
		isLatest: Boolean(payload.isLatest),
		chats: payload.chats.length,
		messages: payload.messages.length
	};
}

export function handleMessagesUpsert(db: AppDatabase, payload: MessagesUpsertPayload): void {
	const bumpUnread = payload.type === 'notify';
	const apply = db.transaction(() => {
		for (const message of payload.messages) {
			ingestBaileysMessage(db, message, { bumpUnread });
		}
	});
	apply();
}

export function handleChatsUpsert(db: AppDatabase, chats: Chat[]): void {
	const apply = db.transaction(() => {
		for (const chat of chats) ingestBaileysChat(db, chat);
	});
	apply();
}

export function handleChatsUpdate(db: AppDatabase, updates: ChatUpdate[]): void {
	const apply = db.transaction(() => {
		for (const update of updates) ingestBaileysChatUpdate(db, update);
	});
	apply();
}

export function handleContactsUpsert(db: AppDatabase, contacts: Contact[]): void {
	const apply = db.transaction(() => {
		for (const contact of contacts) ingestBaileysContact(db, contact);
	});
	apply();
}

export function handleContactsUpdate(db: AppDatabase, contacts: ContactPatch[]): void {
	const apply = db.transaction(() => {
		for (const contact of contacts) ingestBaileysContact(db, contact);
	});
	apply();
}

/** Bind Baileys socket events → SQLite upserts. */
export function attachIngest(
	ev: IngestListener,
	db: AppDatabase,
	options: AttachIngestOptions = {}
): () => void {
	const onHistory = (payload: HistorySetPayload) => {
		const progress = handleHistorySet(db, payload);
		options.onSyncProgress?.(progress);
	};
	const onMessages = (payload: MessagesUpsertPayload) => {
		const existingIds = new Set(
			payload.messages
				.map((message) => message.key?.id)
				.filter((id): id is string => Boolean(id && getMessage(db, id)))
		);
		handleMessagesUpsert(db, payload);
		// The transaction above has committed. Consumers may now safely classify
		// against the complete stored chat/message state.
		for (const incoming of payload.messages) {
			const id = incoming.key?.id;
			if (!id || existingIds.has(id)) continue;
			const stored = getMessage(db, id);
			if (stored) options.onMessageIngested?.(stored);
		}
	};
	const onChats = (chats: Chat[]) => handleChatsUpsert(db, chats);
	const onChatUpdates = (updates: ChatUpdate[]) => handleChatsUpdate(db, updates);
	const onContacts = (contacts: Contact[]) => handleContactsUpsert(db, contacts);
	const onContactUpdates = (contacts: ContactPatch[]) => handleContactsUpdate(db, contacts);
	const onLidMapping = (mapping: LIDMapping) => handleLidMappingUpdate(db, mapping);

	ev.on('messaging-history.set', onHistory);
	ev.on('messages.upsert', onMessages);
	ev.on('chats.upsert', onChats);
	ev.on('chats.update', onChatUpdates);
	ev.on('contacts.upsert', onContacts);
	ev.on('contacts.update', onContactUpdates);
	ev.on('lid-mapping.update', onLidMapping);

	return () => {
		// Baileys EventEmitter has .off; FakeSocket in tests may not — best-effort.
		const off = (ev as { off?: (event: string, handler: (...args: any[]) => void) => void }).off;
		off?.('messaging-history.set', onHistory);
		off?.('messages.upsert', onMessages);
		off?.('chats.upsert', onChats);
		off?.('chats.update', onChatUpdates);
		off?.('contacts.upsert', onContacts);
		off?.('contacts.update', onContactUpdates);
		off?.('lid-mapping.update', onLidMapping);
	};
}
