import { getChat, upsertChat } from './chats.js';
import { linkContactIdentity, type ContactIdentity } from './contacts.js';
import type { AppDatabase } from './db.js';

/**
 * W4-U13 — one human, one chat row.
 *
 * WhatsApp is migrating contacts from phone-number addressing
 * (`<number>@s.whatsapp.net`) to LID addressing (`<opaque>@lid`). The same
 * person then arrives under two identifiers, and a store keyed on the raw
 * `remoteJid` grows a second conversation halfway through the first one: the
 * owner's approved reply landed on the phone chat holding all the history, and
 * the answer 100 seconds later opened an empty LID chat.
 *
 * The fix is a canonical identity, not a smarter UI. Every write picks ONE jid
 * for a person before the chat row is touched.
 *
 * ## Why the phone jid wins
 *
 * 1. It is where the history already lives (565 phone-keyed chats vs 29 LID).
 * 2. It is what the owner recognises, and `chat-view.ts` already resolves
 *    `display_jid` to it.
 * 3. It stays deliverable. Baileys 7 `assertSessions`
 *    (`Socket/messages-send.js`) resolves a PN jid through
 *    `lidMapping.getLIDsForPNs` before fetching sessions — "LID if mapped,
 *    otherwise original" — so sending to a phone jid encrypts to the LID
 *    identity anyway. Canonicalising to the phone jid does not put an
 *    undeliverable address in the outbox (R9/R10).
 *
 * A LID chat with no known phone mapping keeps its LID jid; it is not dropped
 * and not stranded — when the mapping later arrives, {@link mergeChats}
 * converges the two rows.
 */

export type ChatMerge = {
	/** The chat jid that no longer exists after the merge. */
	from: string;
	/** The surviving canonical chat jid. */
	to: string;
};

/**
 * The canonical chat jid for `jid`: the phone alias when this is a LID with a
 * known mapping, otherwise `jid` unchanged. Groups (`@g.us`) and phone jids are
 * returned verbatim.
 */
export function canonicalChatJid(db: AppDatabase, jid: string): string {
	if (!jid.endsWith('@lid')) return jid;
	const row = db
		.prepare(
			`SELECT phone_jid FROM contacts
			 WHERE (jid = ? OR lid_jid = ?)
			   AND phone_jid IS NOT NULL
			   AND phone_jid LIKE '%@s.whatsapp.net'
			 LIMIT 1`
		)
		.get(jid, jid) as { phone_jid: string } | undefined;
	return row?.phone_jid ?? jid;
}

/**
 * Move every row that references `from` onto `to`, then drop the `from` chat.
 *
 * Field resolution — the same rules migration 011 applies in bulk. Keep the two
 * in step; `identity.test.ts` and `store.test.ts` assert them against both.
 *
 * | field              | rule                                              |
 * | ------------------ | ------------------------------------------------- |
 * | `unread`           | sum — both counts are genuinely unread             |
 * | `last_msg_at`      | max                                                |
 * | `muted`/`archived` | OR — an owner opt-out must survive a merge         |
 * | `name`             | winner's, else loser's                             |
 * | `agent_state`      | winner's, else loser's ('skipped'/'quiet' persist) |
 * | `last_read_msg_id` | cursor of the side with the later `last_msg_at`    |
 * | drafts             | newer `generated_at` wins (PK is `chat_jid`)       |
 * | reactions          | newer `updated_at` wins (PK includes `chat_jid`)   |
 *
 * `last_read_msg_id` is the one genuinely ambiguous field: the two cursors point
 * into interleaved histories and neither dominates. Taking the more recently
 * active side's cursor keeps the unread boundary from jumping backwards over
 * messages the owner has just read.
 *
 * Returns false when there is nothing to merge (no `from` row, or from === to).
 */
export function mergeChats(db: AppDatabase, from: string, to: string): boolean {
	if (from === to) return false;
	const loser = getChat(db, from);
	if (!loser) return false;
	const winner = getChat(db, to);

	const apply = db.transaction(() => {
		// FK order: the surviving chat row must exist before children point at it.
		upsertChat(db, {
			jid: to,
			channel: winner?.channel ?? loser.channel,
			name: winner?.name ?? loser.name,
			kind: winner?.kind ?? loser.kind,
			last_msg_at: Math.max(winner?.last_msg_at ?? 0, loser.last_msg_at ?? 0) || null,
			unread: (winner?.unread ?? 0) + loser.unread,
			muted: Boolean(winner?.muted) || loser.muted,
			archived: Boolean(winner?.archived) || loser.archived,
			agent_state: winner?.agent_state ?? loser.agent_state
		});

		const winnerNewer = (winner?.last_msg_at ?? 0) >= (loser.last_msg_at ?? 0);
		const cursor = winnerNewer
			? (winner?.last_read_msg_id ?? loser.last_read_msg_id)
			: (loser.last_read_msg_id ?? winner?.last_read_msg_id ?? null);
		db.prepare('UPDATE chats SET last_read_msg_id = ? WHERE jid = ?').run(cursor, to);

		// Message ids are globally unique (PK is `id` alone), so this can never
		// collide — the row moves, it is never duplicated or dropped.
		db.prepare('UPDATE messages SET chat_jid = ? WHERE chat_jid = ?').run(to, from);

		// PK (chat_jid, target_msg_id, actor): the same actor may have reacted to
		// the same message under both identities. Newer wins.
		db.prepare(
			`INSERT INTO message_reactions (chat_jid, target_msg_id, actor, emoji, updated_at)
			 SELECT ?, target_msg_id, actor, emoji, updated_at
			   FROM message_reactions WHERE chat_jid = ?
			 ON CONFLICT(chat_jid, target_msg_id, actor) DO UPDATE SET
			   emoji = excluded.emoji,
			   updated_at = excluded.updated_at
			 WHERE excluded.updated_at > message_reactions.updated_at`
		).run(to, from);
		db.prepare('DELETE FROM message_reactions WHERE chat_jid = ?').run(from);

		// PK chat_jid: at most one draft survives. The newer generation wins —
		// an older draft was written against an earlier basis message.
		db.prepare(
			`INSERT INTO drafts (
			   chat_jid, text, status, generated_at, provider, basis_msg_id, error_code, original_text
			 )
			 SELECT ?, text, status, generated_at, provider, basis_msg_id, error_code, original_text
			   FROM drafts WHERE chat_jid = ?
			 ON CONFLICT(chat_jid) DO UPDATE SET
			   text = excluded.text,
			   status = excluded.status,
			   generated_at = excluded.generated_at,
			   provider = excluded.provider,
			   basis_msg_id = excluded.basis_msg_id,
			   error_code = excluded.error_code,
			   original_text = excluded.original_text
			 WHERE excluded.generated_at > drafts.generated_at`
		).run(to, from);
		db.prepare('DELETE FROM drafts WHERE chat_jid = ?').run(from);

		// Surrogate-keyed: every row survives. A pending outbox row moves onto a
		// jid WhatsApp still accepts (see the header note), so nothing queued for
		// the owner is silently lost or made undeliverable.
		db.prepare('UPDATE outbox SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
		db.prepare('UPDATE draft_feedback SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
		// PL-U3: same treatment, and it is not optional — `send_proposals.chat_jid`
		// references `chats(jid)` and foreign keys are ON, so leaving rows behind
		// would make the `DELETE FROM chats` below throw and abort the whole merge.
		// Moving is also the honest answer: the two jids are one person, the basis
		// message moved with `messages` above, and the proposal still cannot send
		// without a click.
		db.prepare('UPDATE send_proposals SET chat_jid = ? WHERE chat_jid = ?').run(to, from);
		// PL-U5: same FK treatment for open/dismissed cancellation notices.
		db.prepare('UPDATE agent_cancellation_notices SET chat_jid = ? WHERE chat_jid = ?').run(
			to,
			from
		);

		db.prepare('DELETE FROM chats WHERE jid = ?').run(from);
	});
	apply();
	return true;
}

/**
 * Link a LID/phone pair on the contact, then converge the chats behind it.
 *
 * The single entry point for "we just learned these two identifiers are the
 * same person" — a `lid-mapping.update` event, a contact carrying both aliases,
 * or a message whose key carries `remoteJid` and `remoteJidAlt`. Linking the
 * contact without merging the chats is what produced the duplicate in the first
 * place: the mapping was already correct in `contacts`, and nothing acted on it.
 */
export function linkIdentityAndMergeChats(
	db: AppDatabase,
	identity: ContactIdentity
): ChatMerge | null {
	linkContactIdentity(db, identity);
	return mergeChats(db, identity.lidJid, identity.phoneJid)
		? { from: identity.lidJid, to: identity.phoneJid }
		: null;
}
