-- PL-U3: the permission channel.
--
-- `send_proposals` is the agent's only route toward a send. A tool caller may
-- INSERT a row here (via the `propose-send` action) and nothing else: the row
-- is inert until the owner clicks, and the click runs `confirm-proposal`, a
-- frontend-only action, which is what creates the outbox row. R9 therefore
-- still holds structurally — no tool-caller path reaches the outbox, let alone
-- WhatsApp `sendMessage`.
--
-- `basis_msg_id` is the last inbound message at proposal time, so confirming
-- can apply the same staleness rule `approve-draft` applies to drafts: a
-- proposal written against a conversation that has since moved on is stale and
-- needs an explicit second owner confirmation.
--
-- `outbox_id` is written when the owner confirms. It is the audit link between
-- what the agent asked for and what actually got queued; without it the panel
-- trace cannot honestly say a proposal turned into a send.
CREATE TABLE IF NOT EXISTS send_proposals (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_jid TEXT NOT NULL REFERENCES chats(jid),
	text TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'confirmed', 'rejected')),
	created_at INTEGER NOT NULL,
	basis_msg_id TEXT,
	decided_at INTEGER,
	outbox_id INTEGER REFERENCES outbox(id)
);

CREATE INDEX IF NOT EXISTS idx_send_proposals_chat_status
	ON send_proposals (chat_jid, status);

-- PL-U3 Half B: who last mutated `drafts.text`.
--
-- 'system' = the provider wrote it (generation/refinement), 'agent' = a tool
-- caller edited it, 'owner' = the owner typed or approved it. The re-confirm
-- prompt raised by a text-hash mismatch reads this so it can say *the agent
-- changed this draft* rather than something generic — the same reason the
-- panel trace has to be specific to be honest.
--
-- Existing rows default to 'system': every draft that predates this migration
-- was provider-written, since agent edits did not exist before PL-U2.
ALTER TABLE drafts ADD COLUMN text_source TEXT NOT NULL DEFAULT 'system';
