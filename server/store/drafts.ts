import type { AppDatabase } from './db.js';

export type Draft = {
	chat_jid: string;
	text: string;
	status: string;
	generated_at: number;
	provider: string | null;
	basis_msg_id: string | null;
};

export type DraftInput = {
	chat_jid: string;
	text: string;
	status: string;
	generated_at: number;
	provider?: string | null;
	basis_msg_id?: string | null;
};

/** Upsert the single active draft for a chat (PK = chat_jid). */
export function upsertDraft(db: AppDatabase, draft: DraftInput): void {
	db.prepare(
		`INSERT INTO drafts (chat_jid, text, status, generated_at, provider, basis_msg_id)
		 VALUES (@chat_jid, @text, @status, @generated_at, @provider, @basis_msg_id)
		 ON CONFLICT(chat_jid) DO UPDATE SET
		   text = excluded.text,
		   status = excluded.status,
		   generated_at = excluded.generated_at,
		   provider = excluded.provider,
		   basis_msg_id = excluded.basis_msg_id`
	).run({
		chat_jid: draft.chat_jid,
		text: draft.text,
		status: draft.status,
		generated_at: draft.generated_at,
		provider: draft.provider ?? null,
		basis_msg_id: draft.basis_msg_id ?? null
	});
}

export function getDraft(db: AppDatabase, chatJid: string): Draft | undefined {
	return db.prepare('SELECT * FROM drafts WHERE chat_jid = ?').get(chatJid) as Draft | undefined;
}

export function deleteDraft(db: AppDatabase, chatJid: string): void {
	db.prepare('DELETE FROM drafts WHERE chat_jid = ?').run(chatJid);
}
