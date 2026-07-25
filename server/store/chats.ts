import type { AppDatabase } from './db.js';

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
		agent_state: row.agent_state
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

export function markChatRead(db: AppDatabase, jid: string): boolean {
	const result = db.prepare('UPDATE chats SET unread = 0 WHERE jid = ?').run(jid);
	return result.changes > 0;
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
