-- Incremental message reads by chat and stable (timestamp, id) cursor.
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts_id
  ON messages(chat_jid, ts, id);
