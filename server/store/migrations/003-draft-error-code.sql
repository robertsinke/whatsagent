-- D3: a `failed` draft carries the typed ProviderErrorCode so the UI can tell a
-- terminal failure from a retryable one. Before this column, U8 encoded the code
-- in drafts.text, which the composer would have rendered as draft body text.
ALTER TABLE drafts ADD COLUMN error_code TEXT;
