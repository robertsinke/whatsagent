import type { DraftTextSource } from '../../shared/approval-hash.js';
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
	/** PL-U3: who last wrote `text` — drives the re-confirmation copy. */
	text_source: DraftTextSource;
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
	/**
	 * PL-U3. Omitting it means *the system wrote this text* — that is the
	 * fallback rather than "keep whatever was there" on purpose: a writer that
	 * did not say who it is has produced text nobody reviewed, and inheriting an
	 * older `owner` would let an unreviewed rewrite masquerade as reviewed.
	 * Callers that spread an existing `Draft` carry the value through untouched.
	 */
	text_source?: DraftTextSource | null;
};

/** Upsert the single active draft for a chat (PK = chat_jid). */
export function upsertDraft(db: AppDatabase, draft: DraftInput): void {
	db.prepare(
		`INSERT INTO drafts (
		   chat_jid, text, status, generated_at, provider, basis_msg_id, error_code, original_text,
		   text_source
		 ) VALUES (
		   @chat_jid, @text, @status, @generated_at, @provider, @basis_msg_id, @error_code,
		   COALESCE(@original_text, @text), COALESCE(@text_source, 'system')
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
		   ),
		   text_source = excluded.text_source`
	).run({
		chat_jid: draft.chat_jid,
		text: draft.text,
		status: draft.status,
		generated_at: draft.generated_at,
		provider: draft.provider ?? null,
		basis_msg_id: draft.basis_msg_id ?? null,
		error_code: draft.error_code ?? null,
		original_text: draft.original_text ?? null,
		text_source: draft.text_source ?? null
	});
}

export function getDraft(db: AppDatabase, chatJid: string): Draft | undefined {
	return db.prepare('SELECT * FROM drafts WHERE chat_jid = ?').get(chatJid) as Draft | undefined;
}

export function deleteDraft(db: AppDatabase, chatJid: string): void {
	db.prepare('DELETE FROM drafts WHERE chat_jid = ?').run(chatJid);
}
