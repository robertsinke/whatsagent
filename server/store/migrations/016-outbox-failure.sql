-- OUTBOX-1: give the outbox a terminal failure state.
--
-- Before this, every send error re-armed the row as `pending` five seconds
-- later, forever: no attempt counter, no cap, no `failed` status. An
-- undeliverable row therefore became an unbounded 5s retry loop against
-- WhatsApp — the traffic shape that gets an account flagged — and the owner
-- never learned the message had not gone.
--
-- `attempts` counts send attempts that actually reached the transport, so the
-- pacer can back off and then give up. `last_error` is the owner-facing reason
-- on a failed row. `failed_at` is when it gave up (`sent_at` stays NULL).
--
-- No CHECK constraint on `outbox.status` exists, so 'failed' joins the
-- vocabulary ('pending' | 'sending' | 'sent' | 'cancelled') without a rewrite.
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_error TEXT;
ALTER TABLE outbox ADD COLUMN failed_at INTEGER;
