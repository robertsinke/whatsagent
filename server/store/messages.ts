import type { AppDatabase } from './db.js';

/** D2 — persisted media viewer state; the UI never infers it. */
export type MediaState = 'placeholder' | 'downloading' | 'ready' | 'failed';

/**
 * D2 — why a media fetch failed.
 * `unavailable` is terminal (WhatsApp-side expiry / reupload refused): no retry.
 * `transient` is network/decrypt/IO: retry affordance shown.
 */
export type MediaFailureReason = 'unavailable' | 'transient';

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
	media_state: MediaState;
	media_error: MediaFailureReason | null;
	quote_target_id: string | null;
	quote_sender: string | null;
	quote_type: string | null;
	quote_text: string | null;
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
	quote_target_id?: string | null;
	quote_sender?: string | null;
	quote_type?: string | null;
	quote_text?: string | null;
	raw?: string | null;
};

export type MessageReaction = {
	chat_jid: string;
	target_msg_id: string;
	actor: string;
	emoji: string;
	updated_at: number;
};

export type MessageReactionInput = Omit<MessageReaction, 'emoji'> & {
	emoji: string | null;
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
	media_state: MediaState;
	media_error: MediaFailureReason | null;
	quote_target_id: string | null;
	quote_sender: string | null;
	quote_type: string | null;
	quote_text: string | null;
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
		media_state: row.media_state,
		media_error: row.media_error,
		quote_target_id: row.quote_target_id,
		quote_sender: row.quote_sender,
		quote_type: row.quote_type,
		quote_text: row.quote_text,
		raw: row.raw
	};
}

/**
 * D2 — the four persisted media states. Written only by `setMediaState`, never
 * by `upsertMessage`: a history re-ingest of an already-downloaded message must
 * not reset the owner's cached media back to tap-to-load.
 */
export function setMediaState(
	db: AppDatabase,
	id: string,
	state: MediaState,
	error: MediaFailureReason | null = null
): void {
	db.prepare('UPDATE messages SET media_state = ?, media_error = ? WHERE id = ?').run(
		state,
		state === 'failed' ? error : null,
		id
	);
}

/** Records a successful download: cached path + `ready`, in one statement. */
export function setMediaRef(db: AppDatabase, id: string, mediaRef: string): void {
	db.prepare(
		`UPDATE messages SET media_ref = ?, media_state = 'ready', media_error = NULL WHERE id = ?`
	).run(mediaRef, id);
}

/**
 * Idempotent upsert — same `id` replaces the prior row (ingestion-safe).
 * `media_ref` is preserved on conflict and `media_state`/`media_error` are not
 * touched at all: a re-ingested history batch must never discard cached media.
 */
export function upsertMessage(db: AppDatabase, message: MessageInput): void {
	db.prepare(
		`INSERT INTO messages (
		   id, chat_jid, channel, from_me, sender, ts, type, text, media_ref,
		   quote_target_id, quote_sender, quote_type, quote_text, raw
		 ) VALUES (
		   @id, @chat_jid, @channel, @from_me, @sender, @ts, @type, @text, @media_ref,
		   @quote_target_id, @quote_sender, @quote_type, @quote_text, @raw
		 )
		 ON CONFLICT(id) DO UPDATE SET
		   chat_jid = excluded.chat_jid,
		   channel = excluded.channel,
		   from_me = excluded.from_me,
		   sender = excluded.sender,
		   ts = excluded.ts,
		   type = excluded.type,
		   text = excluded.text,
		   media_ref = COALESCE(excluded.media_ref, messages.media_ref),
		   quote_target_id = excluded.quote_target_id,
		   quote_sender = excluded.quote_sender,
		   quote_type = excluded.quote_type,
		   quote_text = excluded.quote_text,
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
		quote_target_id: message.quote_target_id ?? null,
		quote_sender: message.quote_sender ?? null,
		quote_type: message.quote_type ?? null,
		quote_text: message.quote_text ?? null,
		raw: message.raw ?? null
	});
}

/** One actor has at most one reaction per target. Falsey text removes it. */
export function upsertMessageReaction(db: AppDatabase, reaction: MessageReactionInput): void {
	const emoji = reaction.emoji?.trim();
	if (!emoji) {
		db.prepare(
			'DELETE FROM message_reactions WHERE chat_jid = ? AND target_msg_id = ? AND actor = ?'
		).run(reaction.chat_jid, reaction.target_msg_id, reaction.actor);
		return;
	}

	db.prepare(
		`INSERT INTO message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at)
		 VALUES (@chat_jid, @target_msg_id, @actor, @emoji, @updated_at)
		 ON CONFLICT(chat_jid, target_msg_id, actor) DO UPDATE SET
		   emoji = excluded.emoji,
		   updated_at = excluded.updated_at`
	).run({ ...reaction, emoji });
}

export function listMessageReactions(
	db: AppDatabase,
	chatJid: string,
	targetMsgId: string
): MessageReaction[] {
	return db
		.prepare(
			`SELECT * FROM message_reactions
			 WHERE chat_jid = ? AND target_msg_id = ?
			 ORDER BY updated_at ASC, actor ASC`
		)
		.all(chatJid, targetMsgId) as MessageReaction[];
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
	/**
	 * U5 — load a page *centered* on this message id, so an off-page
	 * jump-to-quote can fetch around its target. Mutually exclusive with
	 * `beforeTs`/`beforeId`. When the target does not exist in this chat the
	 * result is empty — the caller must degrade gracefully (the quote inset
	 * already renders an "original not loaded" state, and a missing target is
	 * not a crash). The target row is always included and sits near the middle
	 * of the returned page (older rows before it, newer rows after it, ordered
	 * oldest-first to match the rest of this module's contract).
	 */
	focusMsgId?: string;
};

/**
 * Newest-first page of messages for a chat (client reverses for display).
 * When `beforeTs` is omitted, returns the latest `limit` messages.
 *
 * U5: when `focusMsgId` is set, returns up to `limit` rows centered on the
 * target — roughly half older, half newer. The target is always included when
 * it exists in this chat. Same paging mechanism (same table, same ts/id
 * ordering), not a second one.
 *
 * ⚠️ **The two modes return opposite orderings.** The cursor modes above are
 * newest-first; the focused mode is oldest-first. Every current consumer feeds
 * the result through `mergeMessages`, which sorts by `ts` then `id`, so no
 * caller depends on either order today — but do not assume a single ordering
 * if you add a consumer that skips that sort.
 */
export function listMessagesPage(
	db: AppDatabase,
	chatJid: string,
	options: ListMessagesPageOptions = {}
): Message[] {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const beforeTs = options.beforeTs;
	const beforeId = options.beforeId;
	const focusMsgId = options.focusMsgId;

	if (focusMsgId !== undefined) {
		// A focused page is the union of three slices: the target row, up to
		// half the page of older rows, and up to half the page of newer rows.
		// Older/newer split is rounded so the target lands near the middle; the
		// exact balance is irrelevant to the client, which only needs the target
		// on screen with context on both sides.
		const target = db
			.prepare('SELECT * FROM messages WHERE id = ?')
			.get(focusMsgId) as MessageRow | undefined;
		// Unknown target, or a target that belongs to a different chat — the
		// caller must degrade gracefully. Returning an empty page (rather than
		// throwing) keeps the off-page jump a no-op instead of a crash, and the
		// quote inset already renders an "original not loaded" state.
		if (!target || target.chat_jid !== chatJid) return [];
		const half = Math.floor(limit / 2);
		const older = db
			.prepare(
				`SELECT * FROM messages
				 WHERE chat_jid = ?
				   AND (ts < ? OR (ts = ? AND id < ?))
				 ORDER BY ts DESC, id DESC
				 LIMIT ?`
			)
			.all(chatJid, target.ts, target.ts, target.id, half) as MessageRow[];
		const newer = db
			.prepare(
				`SELECT * FROM messages
				 WHERE chat_jid = ?
				   AND (ts > ? OR (ts = ? AND id > ?))
				 ORDER BY ts ASC, id ASC
				 LIMIT ?`
			)
			.all(chatJid, target.ts, target.ts, target.id, half) as MessageRow[];
		// Oldest-first — deliberately the opposite of the cursor modes below.
		// Callers normalize via `mergeMessages`; see the ordering warning above.
		return [...older.reverse().map(mapMessage), mapMessage(target), ...newer.map(mapMessage)];
	}

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

export function getLastInboundMessage(db: AppDatabase, chatJid: string): Message | undefined {
	const row = db
		.prepare(
			`SELECT * FROM messages
			 WHERE chat_jid = ? AND from_me = 0
			 ORDER BY ts DESC, id DESC
			 LIMIT 1`
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
