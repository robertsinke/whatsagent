ALTER TABLE outbox ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
	CHECK (source IN ('draft', 'manual'));
ALTER TABLE outbox ADD COLUMN message_id TEXT;
ALTER TABLE outbox ADD COLUMN draft_text TEXT;
ALTER TABLE outbox ADD COLUMN basis_msg_id TEXT;

ALTER TABLE drafts ADD COLUMN original_text TEXT;
UPDATE drafts SET original_text = text WHERE original_text IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_message_id ON outbox(message_id);

CREATE TABLE IF NOT EXISTS draft_feedback (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_jid TEXT NOT NULL REFERENCES chats(jid),
	kind TEXT NOT NULL CHECK (kind IN ('approved', 'skipped')),
	draft_text TEXT NOT NULL,
	final_text TEXT,
	basis_msg_id TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_draft_feedback_chat_created
	ON draft_feedback(chat_jid, created_at);
