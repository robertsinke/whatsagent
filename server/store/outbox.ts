import type { AppDatabase } from './db.js';

export type OutboxRow = {
	id: number;
	chat_jid: string;
	text: string;
	queued_at: number;
	send_after: number;
	sent_at: number | null;
	status: string;
};

export type OutboxInput = {
	chat_jid: string;
	text: string;
	queued_at: number;
	send_after: number;
	sent_at?: number | null;
	status?: string;
};

export function enqueueOutbox(db: AppDatabase, row: OutboxInput): number {
	const result = db
		.prepare(
			`INSERT INTO outbox (chat_jid, text, queued_at, send_after, sent_at, status)
			 VALUES (@chat_jid, @text, @queued_at, @send_after, @sent_at, @status)`
		)
		.run({
			chat_jid: row.chat_jid,
			text: row.text,
			queued_at: row.queued_at,
			send_after: row.send_after,
			sent_at: row.sent_at ?? null,
			status: row.status ?? 'pending'
		});
	return Number(result.lastInsertRowid);
}

export function listPendingOutbox(db: AppDatabase): OutboxRow[] {
	return db
		.prepare(
			`SELECT * FROM outbox WHERE status = 'pending' ORDER BY send_after ASC, id ASC`
		)
		.all() as OutboxRow[];
}

/** Recent outbox rows (pending first by send_after, then others by id desc). */
export function listOutbox(db: AppDatabase, limit = 100): OutboxRow[] {
	const capped = Math.min(Math.max(limit, 1), 500);
	return db
		.prepare(
			`SELECT * FROM outbox
			 ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
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

/** Cancel a still-queued row. Returns false if missing or not pending. */
export function cancelOutbox(db: AppDatabase, id: number): boolean {
	const result = db
		.prepare(`UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
		.run(id);
	return result.changes > 0;
}
