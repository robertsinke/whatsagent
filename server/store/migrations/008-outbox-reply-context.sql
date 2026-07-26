ALTER TABLE outbox ADD COLUMN reply_to_msg_id TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_reply_target
	ON outbox(reply_to_msg_id);
