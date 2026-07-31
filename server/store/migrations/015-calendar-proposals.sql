-- CAL-2: confirm-gated calendar event creation.
--
-- Deliberate duplication of the send_proposals pattern — NOT an oversight.
-- confirm-proposal.ts documents itself as the action that creates the outbox
-- row, and both its branches enqueue. A calendar branch that never touches the
-- outbox would break that invariant's readability.
--
-- send_proposals.chat_jid is NOT NULL REFERENCES chats(jid), which would force
-- chat-scoping onto "add lunch tomorrow". So: separate table, separate confirm
-- action (confirm-calendar-event). chat_jid here is optional provenance only.
--
-- A proposal is inert until the owner clicks. confirm-calendar-event is the
-- ONLY writer to Google (CalDAV PUT). A non-2xx PUT surfaces as failure — never
-- a silent local success (the Odysseus write bug).
CREATE TABLE IF NOT EXISTS calendar_proposals (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	summary TEXT NOT NULL,
	start TEXT NOT NULL,
	"end" TEXT NOT NULL,
	location TEXT,
	chat_jid TEXT REFERENCES chats(jid),
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'confirmed', 'rejected')),
	created_at INTEGER NOT NULL,
	decided_at INTEGER,
	google_event_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_proposals_status
	ON calendar_proposals (status);
