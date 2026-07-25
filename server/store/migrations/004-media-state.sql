-- D2: media viewer states are persisted, never guessed by the UI.
-- 'placeholder' (never fetched) | 'downloading' | 'ready' | 'failed'.
ALTER TABLE messages ADD COLUMN media_state TEXT NOT NULL DEFAULT 'placeholder';

-- Failure sub-reason, only meaningful when media_state = 'failed':
-- 'unavailable' (WhatsApp-side expiry / reupload refused — TERMINAL, no retry)
-- 'transient'   (network / decrypt / IO — retry affordance shown)
ALTER TABLE messages ADD COLUMN media_error TEXT;

-- Rows that already have cached bytes are 'ready' (media_ref written pre-003).
UPDATE messages SET media_state = 'ready' WHERE media_ref IS NOT NULL;
