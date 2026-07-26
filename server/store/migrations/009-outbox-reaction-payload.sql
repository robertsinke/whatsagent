-- D2 (Wave 3 U2): reactions ride the outbox as a new payload kind.
-- `payload_kind` discriminates text vs reaction sends. `reaction_emoji` carries
-- the emoji (empty string removes the reaction). `reaction_target_msg_id` is
-- the message the reaction is applied to. Both reaction columns are NULL for
-- text rows and required for reaction rows.
ALTER TABLE outbox ADD COLUMN payload_kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE outbox ADD COLUMN reaction_emoji TEXT;
ALTER TABLE outbox ADD COLUMN reaction_target_msg_id TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_reaction_target
	ON outbox(reaction_target_msg_id);