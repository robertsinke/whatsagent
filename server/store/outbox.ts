import type { AppDatabase } from './db.js';
import { randomBytes } from 'node:crypto';

export type OutboxSource = 'draft' | 'manual';

/**
 * D2 (Wave 3 U2): the outbox carries two payload kinds. `text` is an ordinary
 * message send; `reaction` is a Baileys `sendMessage(jid, { react })` call — a
 * send under R9, so it rides the same pacer. The reaction columns are NULL on
 * text rows and required on reaction rows.
 */
export type OutboxPayloadKind = 'text' | 'reaction';

export type OutboxRow = {
	id: number;
	chat_jid: string;
	text: string;
	queued_at: number;
	send_after: number;
	sent_at: number | null;
	status: string;
	source: OutboxSource;
	message_id: string | null;
	draft_text: string | null;
	basis_msg_id: string | null;
	reply_to_msg_id: string | null;
	payload_kind: OutboxPayloadKind;
	reaction_emoji: string | null;
	reaction_target_msg_id: string | null;
	/** OUTBOX-1: send attempts that reached the transport. Bounds the retries. */
	attempts: number;
	/** Owner-facing reason on a failed (or retrying) row. */
	last_error: string | null;
	/** When the row gave up. `sent_at` stays NULL on a failed row. */
	failed_at: number | null;
};

export type OutboxInput = {
	chat_jid: string;
	text: string;
	queued_at: number;
	send_after: number;
	sent_at?: number | null;
	status?: string;
	source?: OutboxSource;
	/** Null for reaction rows (a reaction is not a new message). */
	message_id?: string | null;
	draft_text?: string | null;
	basis_msg_id?: string | null;
	reply_to_msg_id?: string | null;
	payload_kind?: OutboxPayloadKind;
	reaction_emoji?: string | null;
	reaction_target_msg_id?: string | null;
};

export function enqueueOutbox(db: AppDatabase, row: OutboxInput): number {
	const payloadKind = row.payload_kind ?? 'text';
	const result = db
		.prepare(
			`INSERT INTO outbox (
			   chat_jid, text, queued_at, send_after, sent_at, status,
			   source, message_id, draft_text, basis_msg_id, reply_to_msg_id,
			   payload_kind, reaction_emoji, reaction_target_msg_id
			 ) VALUES (
			   @chat_jid, @text, @queued_at, @send_after, @sent_at, @status,
			   @source, @message_id, @draft_text, @basis_msg_id, @reply_to_msg_id,
			   @payload_kind, @reaction_emoji, @reaction_target_msg_id
			 )`
		)
		.run({
			chat_jid: row.chat_jid,
			text: row.text,
			queued_at: row.queued_at,
			send_after: row.send_after,
			sent_at: row.sent_at ?? null,
			status: row.status ?? 'pending',
			source: row.source ?? 'manual',
			message_id:
				row.payload_kind === 'reaction'
					? (row.message_id ?? null)
					: (row.message_id ?? newMessageId()),
			draft_text: row.draft_text ?? null,
			basis_msg_id: row.basis_msg_id ?? null,
			reply_to_msg_id: row.reply_to_msg_id ?? null,
			payload_kind: payloadKind,
			reaction_emoji: row.reaction_emoji ?? null,
			reaction_target_msg_id: row.reaction_target_msg_id ?? null
		});
	return Number(result.lastInsertRowid);
}

function newMessageId(): string {
	return randomBytes(10).toString('hex').toUpperCase();
}

export function enqueueManualOutbox(
	db: AppDatabase,
	input: { chatJid: string; text: string; replyToMsgId?: string | null; now: number }
): number {
	return enqueueOutbox(db, {
		chat_jid: input.chatJid,
		text: input.text,
		queued_at: input.now,
		send_after: input.now,
		source: 'manual',
		message_id: newMessageId(),
		reply_to_msg_id: input.replyToMsgId ?? null
	});
}

export function enqueueDraftOutbox(
	db: AppDatabase,
	input: {
		chatJid: string;
		text: string;
		draftText: string;
		basisMsgId: string | null;
		now: number;
		jitterMs: number;
	}
): number {
	const insert = db.transaction(() => {
		const anchor = getGlobalPacingAnchor(db);
		const sendAfter = anchor === null ? input.now : Math.max(input.now, anchor + input.jitterMs);
		return enqueueOutbox(db, {
			chat_jid: input.chatJid,
			text: input.text,
			queued_at: input.now,
			send_after: sendAfter,
			source: 'draft',
			message_id: newMessageId(),
			draft_text: input.draftText,
			basis_msg_id: input.basisMsgId
		});
	});
	return insert();
}

/**
 * D2 (Wave 3 U2): enqueue an owner-authored reaction (or removal) as an outbox
 * row. A reaction is a Baileys `sendMessage(jid, { react: { text, key } })`
 * call — a send under R9 — so it rides the pacer like every other send. An
 * empty `emoji` string removes a prior reaction.
 *
 * `message_id` is null: a reaction is not a new message, so there is no stable
 * outgoing id to invent. The pacer reconstructs the target key from
 * `reaction_target_msg_id` after claiming the row.
 */
export function enqueueReactionOutbox(
	db: AppDatabase,
	input: {
		chatJid: string;
		targetMsgId: string;
		emoji: string;
		now: number;
	}
): number {
	return enqueueOutbox(db, {
		chat_jid: input.chatJid,
		text: '',
		queued_at: input.now,
		send_after: input.now,
		source: 'manual',
		message_id: null,
		payload_kind: 'reaction',
		reaction_emoji: input.emoji,
		reaction_target_msg_id: input.targetMsgId
	});
}

export function listPendingOutbox(db: AppDatabase): OutboxRow[] {
	return db
		.prepare(
			`SELECT * FROM outbox WHERE status = 'pending'
			 ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, send_after ASC, id ASC`
		)
		.all() as OutboxRow[];
}

/**
 * Recent outbox rows (pending first by send_after, then others by id desc).
 * OUTBOX-1: `failed` sorts with `pending` — a row that needs the owner's
 * attention must not sink into the historical bucket below the sent rows.
 */
export function listOutbox(db: AppDatabase, limit = 100): OutboxRow[] {
	const capped = Math.min(Math.max(limit, 1), 500);
	return db
		.prepare(
			`SELECT * FROM outbox
			 ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
			          send_after ASC,
			          id DESC
			 LIMIT ?`
		)
		.all(capped) as OutboxRow[];
}

export function getOutbox(db: AppDatabase, id: number): OutboxRow | undefined {
	return db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined;
}

export function markOutboxSent(db: AppDatabase, id: number, sentAt: number): void {
	db.prepare(
		`UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?`
	).run(sentAt, id);
}

/** Atomically claim a due row so one pacer invocation owns the send. */
export function markOutboxSending(db: AppDatabase, id: number): boolean {
	return db
		.prepare(`UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'pending'`)
		.run(id).changes > 0;
}

/**
 * OUTBOX-1: re-arm a row after a retryable failure, recording the attempt and
 * the reason. `attempts` is passed in rather than incremented here because the
 * pacer decides whether an attempt counts at all — a send that never left the
 * process (no socket) must not consume the row's budget.
 */
export function markOutboxRetry(
	db: AppDatabase,
	id: number,
	input: { sendAfter: number; attempts: number; error: string }
): void {
	db.prepare(
		`UPDATE outbox
		 SET status = 'pending', send_after = ?, attempts = ?, last_error = ?
		 WHERE id = ?`
	).run(input.sendAfter, input.attempts, input.error, id);
}

/**
 * OUTBOX-1: terminal state. The row stops consuming retries, stops touching
 * WhatsApp, and becomes owner-visible as failed. Only the pacer writes this.
 */
export function markOutboxFailed(
	db: AppDatabase,
	id: number,
	input: { attempts: number; error: string; failedAt: number }
): void {
	db.prepare(
		`UPDATE outbox
		 SET status = 'failed', attempts = ?, last_error = ?, failed_at = ?
		 WHERE id = ?`
	).run(input.attempts, input.error, input.failedAt, id);
}

/**
 * OUTBOX-1: the owner re-arms a failed row. Attempts reset to zero — the owner
 * has looked at the failure and decided the cause is gone, so the row gets a
 * fresh budget rather than one last attempt. `send_after = now` matches
 * `enqueueManualOutbox`: one deliberate click is not a burst under R10, and the
 * row still queues behind the pacer's global spacing like any other.
 *
 * Returns false when the row is missing or is not failed.
 */
export function retryFailedOutbox(db: AppDatabase, id: number, now: number): boolean {
	return (
		db
			.prepare(
				`UPDATE outbox
				 SET status = 'pending', send_after = ?, attempts = 0,
				     last_error = NULL, failed_at = NULL
				 WHERE id = ? AND status = 'failed'`
			)
			.run(now, id).changes > 0
	);
}

export function cancelClaimedOutbox(db: AppDatabase, id: number): boolean {
	return db
		.prepare(`UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'sending'`)
		.run(id).changes > 0;
}

export function cancelPendingDraftOutbox(
	db: AppDatabase,
	chatJid: string,
	basisMsgId?: string | null
): OutboxRow[] {
	const rows = db
		.prepare(
			`SELECT * FROM outbox
			 WHERE chat_jid = ? AND source = 'draft' AND status = 'pending'
			   AND (? IS NULL OR basis_msg_id = ?)`
		)
		.all(chatJid, basisMsgId ?? null, basisMsgId ?? null) as OutboxRow[];
	if (rows.length === 0) return rows;
	const ids = rows.map((row) => row.id);
	const placeholders = ids.map(() => '?').join(', ');
	db.prepare(`UPDATE outbox SET status = 'cancelled' WHERE id IN (${placeholders})`).run(...ids);
	return rows.map((row) => ({ ...row, status: 'cancelled' }));
}

/** New inbound invalidates owner approval that has not reached WhatsApp yet. */
export function cancelStaleDraftOutbox(
	db: AppDatabase,
	chatJid: string,
	latestBasisMsgId: string
): OutboxRow[] {
	const rows = db
		.prepare(
			`SELECT * FROM outbox
			 WHERE chat_jid = ? AND source = 'draft' AND status IN ('pending', 'sending')
			   AND (basis_msg_id IS NULL OR basis_msg_id != ?)`
		)
		.all(chatJid, latestBasisMsgId) as OutboxRow[];
	if (rows.length === 0) return rows;
	const ids = rows.map((row) => row.id);
	const placeholders = ids.map(() => '?').join(', ');
	db.prepare(`UPDATE outbox SET status = 'cancelled' WHERE id IN (${placeholders})`).run(...ids);
	return rows.map((row) => ({ ...row, status: 'cancelled' }));
}

/** Stable message IDs make a retry after a process crash idempotent at WhatsApp. */
export function recoverSendingOutbox(db: AppDatabase): void {
	db.prepare(`UPDATE outbox SET status = 'pending' WHERE status = 'sending'`).run();
}

export function getNextPendingOutbox(
	db: AppDatabase,
	options: { includeDrafts?: boolean } = {}
): OutboxRow | undefined {
	return db
		.prepare(
			`SELECT * FROM outbox WHERE status = 'pending'
			   AND (? = 1 OR source = 'manual')
			 ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, send_after ASC, id ASC LIMIT 1`
		)
		.get(options.includeDrafts === false ? 0 : 1) as OutboxRow | undefined;
}

export function getGlobalPacingAnchor(db: AppDatabase): number | null {
	const row = db
		.prepare(
			`SELECT MAX(anchor) AS anchor FROM (
			   SELECT sent_at AS anchor FROM outbox WHERE status = 'sent'
			   UNION ALL
			   SELECT send_after AS anchor FROM outbox
			    WHERE status IN ('pending', 'sending') AND source = 'draft'
			 )`
		)
		.get() as { anchor: number | null };
	return row.anchor;
}

/**
 * Move the whole pending draft schedule together, preserving its existing gaps.
 * Manual sends use this to jump the queue without causing drafts to burst behind them.
 */
export function deferPendingDrafts(db: AppDatabase, earliestSendAt: number): void {
	const first = db
		.prepare(
			`SELECT MIN(send_after) AS send_after FROM outbox
			 WHERE status = 'pending' AND source = 'draft'`
		)
		.get() as { send_after: number | null };
	if (first.send_after === null || first.send_after >= earliestSendAt) return;
	db.prepare(
		`UPDATE outbox SET send_after = send_after + ?
		 WHERE status = 'pending' AND source = 'draft'`
	).run(earliestSendAt - first.send_after);
}

/**
 * Cancel a still-queued row. Returns false if missing, or already sent,
 * cancelled, or mid-send. OUTBOX-1: a `failed` row is cancellable too — that is
 * how the owner dismisses a send they have decided not to chase. Cancelling
 * only ever reduces sending, so this stays reachable by both callers.
 */
export function cancelOutbox(db: AppDatabase, id: number): boolean {
	const result = db
		.prepare(
			`UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'failed')`
		)
		.run(id);
	return result.changes > 0;
}
