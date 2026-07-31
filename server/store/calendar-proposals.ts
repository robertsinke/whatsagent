import type { AppDatabase } from './db.js';

/**
 * CAL-2: a calendar event the agent proposed. Inert until the owner confirms
 * through the frontend-only `confirm-calendar-event` action — the sole path
 * that PUTs a VEVENT to Google. Never touches the outbox (R9).
 *
 * Separate from `send_proposals` on purpose: confirm-proposal always enqueues,
 * and send_proposals.chat_jid is NOT NULL. See migration 015.
 */
export type CalendarProposalStatus = 'pending' | 'confirmed' | 'rejected';

export type CalendarProposal = {
	id: number;
	summary: string;
	start: string;
	end: string;
	location: string | null;
	chat_jid: string | null;
	status: CalendarProposalStatus;
	created_at: number;
	decided_at: number | null;
	google_event_id: string | null;
};

export type InsertCalendarProposalInput = {
	summary: string;
	start: string;
	end: string;
	location?: string | null;
	chatJid?: string | null;
	now: number;
};

export function insertCalendarProposal(
	db: AppDatabase,
	input: InsertCalendarProposalInput
): number {
	const result = db
		.prepare(
			`INSERT INTO calendar_proposals
			   (summary, start, "end", location, chat_jid, status, created_at)
			 VALUES
			   (@summary, @start, @end, @location, @chat_jid, 'pending', @created_at)`
		)
		.run({
			summary: input.summary,
			start: input.start,
			end: input.end,
			location: input.location ?? null,
			chat_jid: input.chatJid ?? null,
			created_at: input.now
		});
	return Number(result.lastInsertRowid);
}

export function getCalendarProposal(
	db: AppDatabase,
	id: number
): CalendarProposal | undefined {
	return db.prepare('SELECT * FROM calendar_proposals WHERE id = ?').get(id) as
		| CalendarProposal
		| undefined;
}

export function listPendingCalendarProposals(db: AppDatabase): CalendarProposal[] {
	return db
		.prepare(
			`SELECT * FROM calendar_proposals WHERE status = 'pending' ORDER BY id ASC`
		)
		.all() as CalendarProposal[];
}

export function listPendingCalendarProposalsAll(
	db: AppDatabase,
	limit = 50
): CalendarProposal[] {
	const capped = Math.min(Math.max(limit, 1), 200);
	return db
		.prepare(
			`SELECT * FROM calendar_proposals WHERE status = 'pending' ORDER BY id DESC LIMIT ?`
		)
		.all(capped) as CalendarProposal[];
}

/**
 * Conditional on `status = 'pending'`. Returns false when already decided —
 * the caller turns that into a 409. Used to claim the row before the CalDAV
 * PUT so a double confirm cannot fire two writes.
 */
export function claimCalendarProposal(
	db: AppDatabase,
	input: { id: number; now: number }
): boolean {
	return (
		db
			.prepare(
				`UPDATE calendar_proposals SET status = 'confirmed', decided_at = @decided_at
				 WHERE id = @id AND status = 'pending'`
			)
			.run({ id: input.id, decided_at: input.now }).changes > 0
	);
}

/** After a failed PUT — restore pending so the owner can retry. */
export function revertCalendarProposalClaim(db: AppDatabase, id: number): void {
	db.prepare(
		`UPDATE calendar_proposals SET status = 'pending', decided_at = NULL
		 WHERE id = ? AND status = 'confirmed' AND google_event_id IS NULL`
	).run(id);
}

export function attachCalendarEventId(
	db: AppDatabase,
	id: number,
	googleEventId: string
): void {
	db.prepare('UPDATE calendar_proposals SET google_event_id = ? WHERE id = ?').run(
		googleEventId,
		id
	);
}

export function decideCalendarProposal(
	db: AppDatabase,
	input: {
		id: number;
		status: Exclude<CalendarProposalStatus, 'pending'>;
		now: number;
		googleEventId?: string | null;
	}
): boolean {
	return (
		db
			.prepare(
				`UPDATE calendar_proposals
				 SET status = @status, decided_at = @decided_at, google_event_id = @google_event_id
				 WHERE id = @id AND status = 'pending'`
			)
			.run({
				id: input.id,
				status: input.status,
				decided_at: input.now,
				google_event_id: input.googleEventId ?? null
			}).changes > 0
	);
}
