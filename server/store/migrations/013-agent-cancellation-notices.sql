-- PL-U5 Decision 3: the agent may cancel an approved draft, but the owner
-- must be told.
--
-- `skip-draft` stays tool-permitted. When a TOOL caller skips a draft whose
-- outbox row was already approved/queued, that silently undoes an owner yes —
-- the tray row disappears and nothing says the agent did it. This table is the
-- durable notice that survives not looking at the screen: a toast that has
-- already faded is not a warning.
--
-- An OWNER skip of their own approved draft does not write a row. Attribution
-- comes from `ctx.caller` at the skip site, the same mechanism PL-U3 used for
-- `drafts.text_source`.
--
-- `dismissed_at` is null while the notice is still waiting to be seen. The
-- owner dismisses; the agent cannot.
CREATE TABLE IF NOT EXISTS agent_cancellation_notices (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_jid TEXT NOT NULL REFERENCES chats(jid),
	cancelled_text TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	dismissed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_cancellation_notices_open
	ON agent_cancellation_notices (dismissed_at, id DESC);
