import type { AppDatabase } from './db.js';
import { getLastMessage } from './messages.js';

export type ChatKind = '1:1' | 'group';

export type Chat = {
	jid: string;
	channel: string;
	name: string | null;
	kind: ChatKind;
	last_msg_at: number | null;
	unread: number;
	muted: boolean;
	archived: boolean;
	agent_state: string | null;
	/**
	 * U4 — persistent local read cursor. Id of the last message the owner has
	 * read in this chat; `null` until the chat is first opened after migration
	 * 010 (or when the chat has no messages). The unread boundary is derived
	 * from this cursor, not the in-memory latch from W2-U1. This is a LOCAL
	 * cursor only — it never drives WhatsApp read receipts. See the
	 * `emitReadReceiptOnView` seam in `server/api/routes.ts`.
	 */
	last_read_msg_id: string | null;
};

export type ChatInput = {
	jid: string;
	channel?: string;
	name?: string | null;
	kind: ChatKind;
	last_msg_at?: number | null;
	unread?: number;
	muted?: boolean;
	archived?: boolean;
	agent_state?: string | null;
};

type ChatRow = {
	jid: string;
	channel: string;
	name: string | null;
	kind: ChatKind;
	last_msg_at: number | null;
	unread: number;
	muted: number;
	archived: number;
	agent_state: string | null;
	last_read_msg_id: string | null;
};

function mapChat(row: ChatRow): Chat {
	return {
		jid: row.jid,
		channel: row.channel,
		name: row.name,
		kind: row.kind,
		last_msg_at: row.last_msg_at,
		unread: row.unread,
		muted: row.muted !== 0,
		archived: row.archived !== 0,
		agent_state: row.agent_state,
		last_read_msg_id: row.last_read_msg_id
	};
}

export function upsertChat(db: AppDatabase, chat: ChatInput): void {
	db.prepare(
		`INSERT INTO chats (jid, channel, name, kind, last_msg_at, unread, muted, archived, agent_state)
		 VALUES (@jid, @channel, @name, @kind, @last_msg_at, @unread, @muted, @archived, @agent_state)
		 ON CONFLICT(jid) DO UPDATE SET
		   channel = excluded.channel,
		   name = excluded.name,
		   kind = excluded.kind,
		   last_msg_at = excluded.last_msg_at,
		   unread = excluded.unread,
		   muted = excluded.muted,
		   archived = excluded.archived,
		   agent_state = excluded.agent_state`
	).run({
		jid: chat.jid,
		channel: chat.channel ?? 'whatsapp',
		name: chat.name ?? null,
		kind: chat.kind,
		last_msg_at: chat.last_msg_at ?? null,
		unread: chat.unread ?? 0,
		muted: chat.muted ? 1 : 0,
		archived: chat.archived ? 1 : 0,
		agent_state: chat.agent_state ?? null
	});
}

export function getChat(db: AppDatabase, jid: string): Chat | undefined {
	const row = db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as ChatRow | undefined;
	return row ? mapChat(row) : undefined;
}

/** Chat list ordered by most recent activity (nulls last). */
export function listChats(db: AppDatabase): Chat[] {
	const rows = db
		.prepare(
			`SELECT * FROM chats
			 ORDER BY last_msg_at IS NULL, last_msg_at DESC, jid ASC`
		)
		.all() as ChatRow[];
	return rows.map(mapChat);
}

/**
 * U4 — advance the persistent local read cursor for a chat to the given
 * message id and zero the unread count, atomically. Pass the latest message
 * id the owner has just seen; the unread boundary is derived from this
 * cursor. Returns true if any row changed.
 *
 * This is a LOCAL cursor only — it never drives WhatsApp read receipts. See
 * the `emitReadReceiptOnView` seam in `server/api/routes.ts`.
 */
export function markChatRead(db: AppDatabase, jid: string, lastReadMsgId?: string): boolean {
	const cursor = lastReadMsgId ?? getLastMessage(db, jid)?.id ?? null;
	const result = db
		.prepare('UPDATE chats SET unread = 0, last_read_msg_id = ? WHERE jid = ?')
		.run(cursor, jid);
	return result.changes > 0;
}

/** U4 — read the persistent local cursor; `null` until the chat is first opened. */
export function getLastReadMsgId(db: AppDatabase, jid: string): string | null {
	const row = db
		.prepare('SELECT last_read_msg_id AS id FROM chats WHERE jid = ?')
		.get(jid) as { id: string | null } | undefined;
	return row?.id ?? null;
}

export function setChatAgentState(
	db: AppDatabase,
	jid: string,
	agentState: string | null
): boolean {
	const result = db
		.prepare('UPDATE chats SET agent_state = ? WHERE jid = ?')
		.run(agentState, jid);
	return result.changes > 0;
}
