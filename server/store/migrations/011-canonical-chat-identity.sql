-- W4-U13: one contact, one chat row.
--
-- WhatsApp is migrating contacts from phone-number addressing to LID
-- addressing, so the same person started arriving under a second identifier
-- and opened a second conversation: the owner's approved reply landed on the
-- phone chat holding sixteen messages of history, and the answer 100 seconds
-- later created an empty `@lid` chat.
--
-- `contacts` already held the mapping (lid_jid / phone_jid, cross-linked on
-- both rows) — nothing ever acted on it for chats. From now on ingest
-- canonicalises every chat jid through `store/identity.ts`; this migration
-- makes the stored history agree with that rule.
--
-- SCOPE. Larger than "merge the four visible duplicates". Canonicalising on
-- ingest means every mapped LID chat must move, or the next message in one of
-- them opens the duplicate we are removing. At the time of writing that is 29
-- LID chats, all of them mapped: 4 merge into an existing phone chat, 25 are
-- pure renames onto a phone jid with no twin.
--
-- Phone jid wins: it holds the history, it is what the owner recognises, it is
-- what `chat-view.ts` already shows as `display_jid`, and it stays deliverable
-- (Baileys 7 `assertSessions` resolves a PN jid through
-- `lidMapping.getLIDsForPNs` before fetching sessions — "LID if mapped,
-- otherwise original"), so a moved outbox row is not a silent send failure.
--
-- Field resolution mirrors `mergeChats()` in server/store/identity.ts exactly;
-- both are asserted by tests. If you change one, change the other.
--   unread          sum          both counts are genuinely unread
--   last_msg_at     max
--   muted/archived  OR           an owner opt-out must survive the merge
--   name            winner, else loser
--   agent_state     winner, else loser ('skipped'/'quiet' must persist)
--   last_read_msg_id  cursor of the side with the later last_msg_at — the one
--                     ambiguous field; taking the more recently active side
--                     stops the unread boundary jumping back over messages the
--                     owner has already read
--   drafts          newer generated_at wins (PK is chat_jid)
--   reactions       newer updated_at wins (PK includes chat_jid)
--
-- Message ids are globally unique (messages PK is `id` alone), so moving a
-- message can never collide with one already in the winning chat.

CREATE TEMP TABLE lid_chat_merge AS
SELECT c.jid AS lid_jid, MIN(ct.phone_jid) AS phone_jid
FROM chats c
JOIN contacts ct ON (ct.jid = c.jid OR ct.lid_jid = c.jid)
WHERE c.jid LIKE '%@lid'
  AND ct.phone_jid IS NOT NULL
  AND ct.phone_jid LIKE '%@s.whatsapp.net'
  AND ct.phone_jid <> c.jid
-- MIN() so a contradictory pair of contact rows cannot map one LID chat onto
-- two different phone jids and merge it twice.
GROUP BY c.jid;

-- Create or merge the surviving chat FIRST: foreign keys are ON, so children
-- may only be repointed at a row that already exists.
INSERT INTO chats (
	jid, channel, name, kind, last_msg_at, unread, muted, archived, agent_state, last_read_msg_id
)
SELECT
	m.phone_jid, c.channel, c.name, c.kind, c.last_msg_at, c.unread, c.muted, c.archived,
	c.agent_state, c.last_read_msg_id
FROM lid_chat_merge m
JOIN chats c ON c.jid = m.lid_jid
ON CONFLICT(jid) DO UPDATE SET
	name = COALESCE(chats.name, excluded.name),
	last_msg_at = NULLIF(
		MAX(COALESCE(chats.last_msg_at, 0), COALESCE(excluded.last_msg_at, 0)), 0
	),
	unread = chats.unread + excluded.unread,
	muted = MAX(chats.muted, excluded.muted),
	archived = MAX(chats.archived, excluded.archived),
	agent_state = COALESCE(chats.agent_state, excluded.agent_state),
	last_read_msg_id = CASE
		WHEN COALESCE(chats.last_msg_at, 0) >= COALESCE(excluded.last_msg_at, 0)
			THEN COALESCE(chats.last_read_msg_id, excluded.last_read_msg_id)
		ELSE COALESCE(excluded.last_read_msg_id, chats.last_read_msg_id)
	END;

UPDATE messages
SET chat_jid = (SELECT phone_jid FROM lid_chat_merge WHERE lid_jid = messages.chat_jid)
WHERE chat_jid IN (SELECT lid_jid FROM lid_chat_merge);

INSERT INTO message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at)
SELECT m.phone_jid, r.target_msg_id, r.actor, r.emoji, r.updated_at
FROM message_reactions r
JOIN lid_chat_merge m ON m.lid_jid = r.chat_jid
ON CONFLICT(chat_jid, target_msg_id, actor) DO UPDATE SET
	emoji = excluded.emoji,
	updated_at = excluded.updated_at
WHERE excluded.updated_at > message_reactions.updated_at;

DELETE FROM message_reactions WHERE chat_jid IN (SELECT lid_jid FROM lid_chat_merge);

INSERT INTO drafts (
	chat_jid, text, status, generated_at, provider, basis_msg_id, error_code, original_text
)
SELECT
	m.phone_jid, d.text, d.status, d.generated_at, d.provider, d.basis_msg_id, d.error_code,
	d.original_text
FROM drafts d
JOIN lid_chat_merge m ON m.lid_jid = d.chat_jid
ON CONFLICT(chat_jid) DO UPDATE SET
	text = excluded.text,
	status = excluded.status,
	generated_at = excluded.generated_at,
	provider = excluded.provider,
	basis_msg_id = excluded.basis_msg_id,
	error_code = excluded.error_code,
	original_text = excluded.original_text
WHERE excluded.generated_at > drafts.generated_at;

DELETE FROM drafts WHERE chat_jid IN (SELECT lid_jid FROM lid_chat_merge);

-- Surrogate-keyed tables: every row survives, none can collide.
UPDATE outbox
SET chat_jid = (SELECT phone_jid FROM lid_chat_merge WHERE lid_jid = outbox.chat_jid)
WHERE chat_jid IN (SELECT lid_jid FROM lid_chat_merge);

UPDATE draft_feedback
SET chat_jid = (SELECT phone_jid FROM lid_chat_merge WHERE lid_jid = draft_feedback.chat_jid)
WHERE chat_jid IN (SELECT lid_jid FROM lid_chat_merge);

DELETE FROM chats WHERE jid IN (SELECT lid_jid FROM lid_chat_merge);

DROP TABLE lid_chat_merge;
