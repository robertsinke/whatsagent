CREATE TABLE IF NOT EXISTS chats (
	jid TEXT PRIMARY KEY NOT NULL,
	channel TEXT NOT NULL DEFAULT 'whatsapp',
	name TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('1:1', 'group')),
	last_msg_at INTEGER,
	unread INTEGER NOT NULL DEFAULT 0,
	muted INTEGER NOT NULL DEFAULT 0,
	archived INTEGER NOT NULL DEFAULT 0,
	agent_state TEXT
);

CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY NOT NULL,
	chat_jid TEXT NOT NULL REFERENCES chats(jid),
	channel TEXT NOT NULL DEFAULT 'whatsapp',
	from_me INTEGER NOT NULL DEFAULT 0,
	sender TEXT,
	ts INTEGER NOT NULL,
	type TEXT NOT NULL DEFAULT 'text',
	text TEXT,
	media_ref TEXT,
	raw TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts);

CREATE TABLE IF NOT EXISTS contacts (
	jid TEXT PRIMARY KEY NOT NULL,
	channel TEXT NOT NULL DEFAULT 'whatsapp',
	name TEXT,
	push_name TEXT
);

CREATE TABLE IF NOT EXISTS drafts (
	chat_jid TEXT PRIMARY KEY NOT NULL REFERENCES chats(jid),
	text TEXT NOT NULL,
	status TEXT NOT NULL,
	generated_at INTEGER NOT NULL,
	provider TEXT,
	basis_msg_id TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_jid TEXT NOT NULL REFERENCES chats(jid),
	text TEXT NOT NULL,
	queued_at INTEGER NOT NULL,
	send_after INTEGER NOT NULL,
	sent_at INTEGER,
	status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_send_after ON outbox(status, send_after);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL
);
