-- PANEL-S6: proposals are no longer send-shaped.
--
-- `send_proposals` was the agent's only route toward a *send*. Outbound actions
-- in general now share the same permission channel: the agent inserts an inert
-- proposal of a given `kind`, and only the owner's frontend-only
-- `confirm-proposal` may turn it into an outbox row. `kind = 'send'` is the
-- historical shape (text + basis_msg_id); `kind = 'reaction'` carries the
-- emoji and the target message id instead.
--
-- Existing rows default to `kind = 'send'` and keep their text — no rewrite.
-- Reaction rows store `text = ''` so the NOT NULL column stays valid without a
-- table rebuild. Approval binding for a reaction is the target message id
-- (immutable on the row) plus a hash of the emoji+target payload the owner
-- reviewed; see `proposalApprovalText` in shared/approval-hash.ts.
ALTER TABLE send_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'send';
ALTER TABLE send_proposals ADD COLUMN reaction_emoji TEXT;
ALTER TABLE send_proposals ADD COLUMN reaction_target_msg_id TEXT;
