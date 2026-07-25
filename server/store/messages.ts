import type { AppDatabase } from './db.js';

export type Message = {
	id: string;
	chat_jid: string;
	channel: string;
	from_me: boolean;
	sender: string | null;
	ts: number;
	type: string;
	text: string | null;
	media_ref: string | null;
	raw: string | null;
};

export type MessageInput = {
	id: string;
	chat_jid: string;
	channel?: string;
	from_me: boolean;
	sender?: string | null;
	ts: number;
	type?: string;
	text?: string | null;
	media_ref?: string | null;
	raw?: string | null;
};

type MessageRow = {
	id: string;
	chat_jid: string;
	channel: string;
	from_me: number;
	sender: string | null;
	ts: number;
	type: string;
	text: string | null;
	media_ref: string | null;
	raw: string | null;
};

function mapMessage(row: MessageRow): Message {
	return {
		id: row.id,
		chat_jid: row.chat_jid,
		channel: row.channel,
		from_me: row.from_me !== 0,
		sender: row.sender,
		ts: row.ts,
		type: row.type,
		text: row.text,
		media_ref: row.media_ref,
		raw: row.raw
	};
}

/** Idempotent upsert — same `id` replaces the prior row (ingestion-safe). */
export function upsertMessage(db: AppDatabase, message: MessageInput): void {
	db.prepare(
		`INSERT INTO messages (id, chat_jid, channel, from_me, sender, ts, type, text, media_ref, raw)
		 VALUES (@id, @chat_jid, @channel, @from_me, @sender, @ts, @type, @text, @media_ref, @raw)
		 ON CONFLICT(id) DO UPDATE SET
		   chat_jid = excluded.chat_jid,
		   channel = excluded.channel,
		   from_me = excluded.from_me,
		   sender = excluded.sender,
		   ts = excluded.ts,
		   type = excluded.type,
		   text = excluded.text,
		   media_ref = excluded.media_ref,
		   raw = excluded.raw`
	).run({
		id: message.id,
		chat_jid: message.chat_jid,
		channel: message.channel ?? 'whatsapp',
		from_me: message.from_me ? 1 : 0,
		sender: message.sender ?? null,
		ts: message.ts,
		type: message.type ?? 'text',
		text: message.text ?? null,
		media_ref: message.media_ref ?? null,
		raw: message.raw ?? null
	});
}

export function listMessages(db: AppDatabase, chatJid: string): Message[] {
	const rows = db
		.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts ASC, id ASC')
		.all(chatJid) as MessageRow[];
	return rows.map(mapMessage);
}

export type ListMessagesPageOptions = {
	/** Max rows to return (default 50, capped at 200). */
	limit?: number;
	/** Exclusive upper bound: return messages older than this timestamp. */
	beforeTs?: number;
	/** Tie-break when multiple messages share `beforeTs`. */
	beforeId?: string;
};

/**
 * Newest-first page of messages for a chat (client reverses for display).
 * When `beforeTs` is omitted, returns the latest `limit` messages.
 */
export function listMessagesPage(
	db: AppDatabase,
	chatJid: string,
	options: ListMessagesPageOptions = {}
): Message[] {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const beforeTs = options.beforeTs;
	const beforeId = options.beforeId;

	let rows: MessageRow[];
	if (beforeTs !== undefined && beforeId !== undefined) {
		rows = db
			.prepare(
				`SELECT * FROM messages
				 WHERE chat_jid = ?
				   AND (ts < ? OR (ts = ? AND id < ?))
				 ORDER BY ts DESC, id DESC
				 LIMIT ?`
			)
			.all(chatJid, beforeTs, beforeTs, beforeId, limit) as MessageRow[];
	} else if (beforeTs !== undefined) {
		rows = db
			.prepare(
				`SELECT * FROM messages
				 WHERE chat_jid = ? AND ts < ?
				 ORDER BY ts DESC, id DESC
				 LIMIT ?`
			)
			.all(chatJid, beforeTs, limit) as MessageRow[];
	} else {
		rows = db
			.prepare(
				`SELECT * FROM messages
				 WHERE chat_jid = ?
				 ORDER BY ts DESC, id DESC
				 LIMIT ?`
			)
			.all(chatJid, limit) as MessageRow[];
	}
	return rows.map(mapMessage);
}

export function getLastMessage(db: AppDatabase, chatJid: string): Message | undefined {
	const row = db
		.prepare(
			`SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC, id DESC LIMIT 1`
		)
		.get(chatJid) as MessageRow | undefined;
	return row ? mapMessage(row) : undefined;
}

export function getMessage(db: AppDatabase, id: string): Message | undefined {
	const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
	return row ? mapMessage(row) : undefined;
}

export function countMessages(db: AppDatabase): number {
	return (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
}
