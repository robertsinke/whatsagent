import type { AppDatabase } from './db.js';

export type DraftFeedback = {
	id: number;
	chat_jid: string;
	kind: 'approved' | 'skipped';
	draft_text: string;
	final_text: string | null;
	basis_msg_id: string | null;
	created_at: number;
};

export function recordDraftFeedback(
	db: AppDatabase,
	feedback: Omit<DraftFeedback, 'id'>
): number {
	const result = db
		.prepare(
			`INSERT INTO draft_feedback (
			   chat_jid, kind, draft_text, final_text, basis_msg_id, created_at
			 ) VALUES (
			   @chat_jid, @kind, @draft_text, @final_text, @basis_msg_id, @created_at
			 )`
		)
		.run(feedback);
	return Number(result.lastInsertRowid);
}

export function listDraftFeedback(db: AppDatabase, chatJid: string): DraftFeedback[] {
	return db
		.prepare(
			`SELECT * FROM draft_feedback WHERE chat_jid = ? ORDER BY created_at ASC, id ASC`
		)
		.all(chatJid) as DraftFeedback[];
}
