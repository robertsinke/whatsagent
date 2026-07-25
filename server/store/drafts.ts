import type { AppDatabase } from './db.js';

export type Draft = {
	chat_jid: string;
	text: string;
	status: string;
	generated_at: number;
	provider: string | null;
	basis_msg_id: string | null;
	/** Typed ProviderErrorCode when status === 'failed'; null otherwise (D3). */
	error_code: string | null;
	/** Provider text before any owner edit; retained for U10 learning. */
	original_text: string;
};

export type DraftInput = {
	chat_jid: string;
	text: string;
	status: string;
	generated_at: number;
	provider?: string | null;
	basis_msg_id?: string | null;
	error_code?: string | null;
	original_text?: string | null;
};

/** Upsert the single active draft for a chat (PK = chat_jid). */
export function upsertDraft(db: AppDatabase, draft: DraftInput): void {
	db.prepare(
		`INSERT INTO drafts (
		   chat_jid, text, status, generated_at, provider, basis_msg_id, error_code, original_text
		 ) VALUES (
		   @chat_jid, @text, @status, @generated_at, @provider, @basis_msg_id, @error_code,
		   COALESCE(@original_text, @text)
		 )
		 ON CONFLICT(chat_jid) DO UPDATE SET
		   text = excluded.text,
		   status = excluded.status,
		   generated_at = excluded.generated_at,
		   provider = excluded.provider,
		   basis_msg_id = excluded.basis_msg_id,
		   error_code = excluded.error_code,
		   original_text = COALESCE(
		     excluded.original_text,
		     CASE WHEN excluded.status = 'ready' THEN excluded.text ELSE drafts.original_text END
		   )`
	).run({
		chat_jid: draft.chat_jid,
		text: draft.text,
		status: draft.status,
		generated_at: draft.generated_at,
		provider: draft.provider ?? null,
		basis_msg_id: draft.basis_msg_id ?? null,
		error_code: draft.error_code ?? null,
		original_text: draft.original_text ?? null
	});
}

export function getDraft(db: AppDatabase, chatJid: string): Draft | undefined {
	return db.prepare('SELECT * FROM drafts WHERE chat_jid = ?').get(chatJid) as Draft | undefined;
}

export function deleteDraft(db: AppDatabase, chatJid: string): void {
	db.prepare('DELETE FROM drafts WHERE chat_jid = ?').run(chatJid);
}
