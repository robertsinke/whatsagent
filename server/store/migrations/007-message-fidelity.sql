ALTER TABLE messages ADD COLUMN quote_target_id TEXT;
ALTER TABLE messages ADD COLUMN quote_sender TEXT;
ALTER TABLE messages ADD COLUMN quote_type TEXT;
ALTER TABLE messages ADD COLUMN quote_text TEXT;

CREATE TABLE message_reactions (
	chat_jid TEXT NOT NULL REFERENCES chats(jid),
	target_msg_id TEXT NOT NULL,
	actor TEXT NOT NULL,
	emoji TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (chat_jid, target_msg_id, actor)
);

CREATE INDEX idx_message_reactions_target
	ON message_reactions(chat_jid, target_msg_id);
