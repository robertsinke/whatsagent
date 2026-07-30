import type { AppDatabase } from './db.js';

/**
 * PL-U5 — durable notice that the agent cancelled a message the owner had
 * already approved. Survives reload; dismissed only by the owner.
 */
export type CancellationNotice = {
	id: number;
	chat_jid: string;
	cancelled_text: string;
	created_at: number;
	dismissed_at: number | null;
};

export function insertCancellationNotice(
	db: AppDatabase,
	input: { chatJid: string; cancelledText: string; now: number }
): number {
	const result = db
		.prepare(
			`INSERT INTO agent_cancellation_notices (chat_jid, cancelled_text, created_at)
			 VALUES (?, ?, ?)`
		)
		.run(input.chatJid, input.cancelledText, input.now);
	return Number(result.lastInsertRowid);
}

export function getCancellationNotice(db: AppDatabase, id: number): CancellationNotice | undefined {
	return db.prepare('SELECT * FROM agent_cancellation_notices WHERE id = ?').get(id) as
		| CancellationNotice
		| undefined;
}

/** Undismissed notices, newest first — the shell's inbox after a restart. */
export function listOpenCancellationNotices(
	db: AppDatabase,
	limit = 50
): CancellationNotice[] {
	return db
		.prepare(
			`SELECT * FROM agent_cancellation_notices
			 WHERE dismissed_at IS NULL
			 ORDER BY id DESC LIMIT ?`
		)
		.all(limit) as CancellationNotice[];
}

/** Conditional: only an open row flips. Returns false when already dismissed or missing. */
export function dismissCancellationNotice(
	db: AppDatabase,
	input: { id: number; now: number }
): boolean {
	return (
		db
			.prepare(
				`UPDATE agent_cancellation_notices
				 SET dismissed_at = ?
				 WHERE id = ? AND dismissed_at IS NULL`
			)
			.run(input.now, input.id).changes > 0
	);
}
