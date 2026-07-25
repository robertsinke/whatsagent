import {
	BufferJSON,
	extractMessageContent,
	getContentType,
	isJidGroup,
	type Chat,
	type ChatUpdate,
	type Contact,
	type MessageUpsertType,
	type WAMessage
} from 'baileys';
import { getChat, upsertChat, type ChatKind } from '../../store/chats.js';
import { upsertContact } from '../../store/contacts.js';
import type { AppDatabase } from '../../store/db.js';
import { upsertMessage } from '../../store/messages.js';

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
	progress: number | null;
	isLatest: boolean;
};

export type IngestListener = {
	on(event: string, handler: (...args: any[]) => void): unknown;
};

export type AttachIngestOptions = {
	onSyncProgress?: (progress: SyncProgress) => void;
};

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

export function ingestBaileysContact(db: AppDatabase, contact: Contact): void {
	if (!contact.id) return;
	upsertContact(db, {
		jid: contact.id,
		channel: 'whatsapp',
		name: contact.name ?? contact.verifiedName ?? null,
		push_name: contact.notify ?? null
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

	// FK: chat row must exist before the message row.
	const existing = getChat(db, chatJid);
	const nextLast = existing?.last_msg_at == null ? ts : Math.max(existing.last_msg_at, ts);
	let unread = existing?.unread ?? 0;
	if (options.bumpUnread && !fromMe) unread += 1;

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
		isLatest: Boolean(payload.isLatest)
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
	const onMessages = (payload: MessagesUpsertPayload) => handleMessagesUpsert(db, payload);
	const onChats = (chats: Chat[]) => handleChatsUpsert(db, chats);
	const onChatUpdates = (updates: ChatUpdate[]) => handleChatsUpdate(db, updates);
	const onContacts = (contacts: Contact[]) => handleContactsUpsert(db, contacts);

	ev.on('messaging-history.set', onHistory);
	ev.on('messages.upsert', onMessages);
	ev.on('chats.upsert', onChats);
	ev.on('chats.update', onChatUpdates);
	ev.on('contacts.upsert', onContacts);

	return () => {
		// Baileys EventEmitter has .off; FakeSocket in tests may not — best-effort.
		const off = (ev as { off?: (event: string, handler: (...args: any[]) => void) => void }).off;
		off?.('messaging-history.set', onHistory);
		off?.('messages.upsert', onMessages);
		off?.('chats.upsert', onChats);
		off?.('chats.update', onChatUpdates);
		off?.('contacts.upsert', onContacts);
	};
}
