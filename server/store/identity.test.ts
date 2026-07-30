import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getChat, listChats, upsertChat } from './chats.js';
import { linkContactIdentity } from './contacts.js';
import { openDatabase, type AppDatabase } from './db.js';
import { MIGRATIONS } from './migrations.generated.js';
import { getDraft, upsertDraft } from './drafts.js';
import { canonicalChatJid, linkIdentityAndMergeChats, mergeChats } from './identity.js';
import { listMessages, upsertMessage, upsertMessageReaction } from './messages.js';
import { getProposal, insertProposal } from './proposals.js';
import { enqueueOutbox, listOutbox } from './outbox.js';
import {
	FIXTURE_SPLIT_LID_JID,
	FIXTURE_SPLIT_NAME,
	FIXTURE_SPLIT_NAME_SHORT,
	FIXTURE_SPLIT_PHONE_JID
} from '../../shared/test-fixtures.js';

const LID = FIXTURE_SPLIT_LID_JID;
const PHONE = FIXTURE_SPLIT_PHONE_JID;

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-identity-'));
	db = openDatabase({ dataDir });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

function seedMessage(
	database: AppDatabase,
	input: { id: string; chatJid: string; ts: number; fromMe?: boolean; text?: string }
): void {
	upsertMessage(database, {
		id: input.id,
		chat_jid: input.chatJid,
		channel: 'whatsapp',
		from_me: input.fromMe ?? false,
		sender: input.fromMe ? null : input.chatJid,
		ts: input.ts,
		type: 'text',
		text: input.text ?? input.id,
		media_ref: null,
		quote_target_id: null,
		quote_sender: null,
		quote_type: null,
		quote_text: null,
		raw: null
	});
}

describe('canonicalChatJid', () => {
	it('resolves a mapped LID to its phone alias and leaves everything else alone', () => {
		const database = openTempDb();
		linkContactIdentity(database, { lidJid: LID, phoneJid: PHONE });

		expect(canonicalChatJid(database, LID)).toBe(PHONE);
		expect(canonicalChatJid(database, PHONE)).toBe(PHONE);
		expect(canonicalChatJid(database, 'team@g.us')).toBe('team@g.us');
	});

	it('leaves an unmapped LID addressable rather than dropping it', () => {
		const database = openTempDb();
		expect(canonicalChatJid(database, '4242@lid')).toBe('4242@lid');
	});
});

describe('mergeChats', () => {
	it('moves every referencing row and resolves the chat fields', () => {
		const database = openTempDb();
		upsertChat(database, {
			jid: PHONE,
			kind: '1:1',
			name: FIXTURE_SPLIT_NAME,
			last_msg_at: 3_000,
			unread: 1,
			archived: false,
			agent_state: null
		});
		upsertChat(database, {
			jid: LID,
			kind: '1:1',
			name: null,
			last_msg_at: 2_000,
			unread: 2,
			muted: true,
			agent_state: 'skipped'
		});
		database.prepare('UPDATE chats SET last_read_msg_id = ? WHERE jid = ?').run('phone-1', PHONE);
		database.prepare('UPDATE chats SET last_read_msg_id = ? WHERE jid = ?').run('lid-1', LID);

		seedMessage(database, { id: 'phone-1', chatJid: PHONE, ts: 3_000 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 2_000 });
		upsertMessageReaction(database, {
			chat_jid: LID,
			target_msg_id: 'lid-1',
			actor: 'me',
			emoji: '👍',
			updated_at: 2_500
		});
		upsertDraft(database, {
			chat_jid: LID,
			text: 'from the lid chat',
			status: 'ready',
			generated_at: 5_000
		});
		const outboxId = enqueueOutbox(database, {
			chat_jid: LID,
			text: 'queued under the LID',
			queued_at: 1_000,
			send_after: 9_000
		});
		database
			.prepare(
				`INSERT INTO draft_feedback (chat_jid, kind, draft_text, final_text, created_at)
				 VALUES (?, 'approved', ?, ?, ?)`
			)
			.run(LID, 'a', 'b', 1_000);

		expect(mergeChats(database, LID, PHONE)).toBe(true);

		expect(getChat(database, LID)).toBeUndefined();
		expect(getChat(database, PHONE)).toMatchObject({
			name: FIXTURE_SPLIT_NAME,
			kind: '1:1',
			last_msg_at: 3_000,
			// Both counts are genuinely unread.
			unread: 3,
			// An owner opt-out must survive the merge, from either side.
			muted: true,
			agent_state: 'skipped',
			// Cursor of the side with the later last_msg_at.
			last_read_msg_id: 'phone-1'
		});

		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['lid-1', 'phone-1']);
		expect(getDraft(database, PHONE)?.text).toBe('from the lid chat');
		expect(listOutbox(database).find((row) => row.id === outboxId)?.chat_jid).toBe(PHONE);
		expect(
			database
				.prepare('SELECT chat_jid FROM message_reactions WHERE target_msg_id = ?')
				.all('lid-1')
		).toEqual([{ chat_jid: PHONE }]);
		expect(
			database.prepare('SELECT COUNT(*) AS n FROM draft_feedback WHERE chat_jid = ?').get(PHONE)
		).toEqual({ n: 1 });
	});

	it('keeps the newer draft when both sides have one', () => {
		const database = openTempDb();
		for (const jid of [PHONE, LID]) upsertChat(database, { jid, kind: '1:1' });
		upsertDraft(database, { chat_jid: PHONE, text: 'newer', status: 'ready', generated_at: 90 });
		upsertDraft(database, { chat_jid: LID, text: 'older', status: 'ready', generated_at: 10 });

		mergeChats(database, LID, PHONE);

		expect(getDraft(database, PHONE)?.text).toBe('newer');
		expect(getDraft(database, LID)).toBeUndefined();
	});

	it('is a no-op when there is nothing to merge', () => {
		const database = openTempDb();
		upsertChat(database, { jid: PHONE, kind: '1:1' });
		expect(mergeChats(database, LID, PHONE)).toBe(false);
		expect(mergeChats(database, PHONE, PHONE)).toBe(false);
		expect(listChats(database)).toHaveLength(1);
	});

	it('renames a LID chat that has no phone twin', () => {
		const database = openTempDb();
		upsertChat(database, { jid: LID, kind: '1:1', name: FIXTURE_SPLIT_NAME_SHORT, last_msg_at: 7, unread: 4 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 7 });

		mergeChats(database, LID, PHONE);

		expect(listChats(database).map((c) => c.jid)).toEqual([PHONE]);
		expect(getChat(database, PHONE)).toMatchObject({ name: FIXTURE_SPLIT_NAME_SHORT, unread: 4, kind: '1:1' });
		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['lid-1']);
	});
});

describe('linkIdentityAndMergeChats', () => {
	it('converges two chats when the mapping arrives after both already exist', () => {
		const database = openTempDb();
		upsertChat(database, { jid: PHONE, kind: '1:1', last_msg_at: 1_000, unread: 0 });
		seedMessage(database, { id: 'phone-1', chatJid: PHONE, ts: 1_000, fromMe: true });
		upsertChat(database, { jid: LID, kind: '1:1', last_msg_at: 2_000, unread: 2 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 2_000 });

		expect(linkIdentityAndMergeChats(database, { lidJid: LID, phoneJid: PHONE })).toEqual({
			from: LID,
			to: PHONE
		});

		expect(listChats(database).map((c) => c.jid)).toEqual([PHONE]);
		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['phone-1', 'lid-1']);
		// Now that the mapping is known, later traffic under either alias agrees.
		expect(canonicalChatJid(database, LID)).toBe(PHONE);
	});

	it('reports no merge when only the contact aliases were learned', () => {
		const database = openTempDb();
		expect(linkIdentityAndMergeChats(database, { lidJid: LID, phoneJid: PHONE })).toBeNull();
	});
});

describe('migration 011', () => {
	/**
	 * Re-runs the real 011 SQL — the file itself, from the generated bundle —
	 * over seeded duplicate rows. Asserting the SQL matters: it repairs the
	 * owner's live database exactly once.
	 *
	 * It replays that one migration rather than rolling the high-water mark back
	 * to 10 and calling `migrate()`, because the runner would then also replay
	 * everything above it, and later migrations are not written to run twice
	 * (012's `ALTER TABLE drafts ADD COLUMN` fails outright on a second pass).
	 * Replaying one file is also the more honest test of one file's SQL.
	 */
	function replayMigration011(database: AppDatabase): void {
		const migration = MIGRATIONS.find((m) => m.version === 11);
		if (!migration) throw new Error('migration 011 is missing from the generated bundle');
		database.exec(migration.sql);
	}

	it('merges a duplicated pair carrying drafts and outbox rows, losing nothing', () => {
		const database = openTempDb();
		linkContactIdentity(database, { lidJid: LID, phoneJid: PHONE, name: FIXTURE_SPLIT_NAME });

		upsertChat(database, { jid: PHONE, kind: '1:1', last_msg_at: 3_000, unread: 1 });
		upsertChat(database, { jid: LID, kind: '1:1', last_msg_at: 4_000, unread: 2, archived: true });
		database.prepare('UPDATE chats SET last_read_msg_id = ? WHERE jid = ?').run('lid-1', LID);
		seedMessage(database, { id: 'phone-1', chatJid: PHONE, ts: 3_000 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 4_000 });
		upsertDraft(database, { chat_jid: LID, text: 'unsent reply', status: 'ready', generated_at: 9 });
		const pending = enqueueOutbox(database, {
			chat_jid: LID,
			text: 'still queued',
			queued_at: 1,
			send_after: 2
		});
		upsertMessageReaction(database, {
			chat_jid: LID,
			target_msg_id: 'lid-1',
			actor: 'me',
			emoji: '🎉',
			updated_at: 5
		});

		const messagesBefore = database.prepare('SELECT COUNT(*) AS n FROM messages').get();

		replayMigration011(database);

		expect(listChats(database).map((c) => c.jid)).toEqual([PHONE]);
		expect(getChat(database, PHONE)).toMatchObject({
			last_msg_at: 4_000,
			unread: 3,
			archived: true,
			last_read_msg_id: 'lid-1'
		});
		// Message ids are globally unique — the merge moves rows, never duplicates
		// or drops them.
		expect(database.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual(messagesBefore);
		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['phone-1', 'lid-1']);
		expect(getDraft(database, PHONE)?.text).toBe('unsent reply');

		// R9/R10: the queued row still points at a jid WhatsApp accepts.
		const moved = listOutbox(database).find((row) => row.id === pending);
		expect(moved).toMatchObject({ chat_jid: PHONE, text: 'still queued', status: 'pending' });
		expect(
			database.prepare('SELECT chat_jid FROM message_reactions').all()
		).toEqual([{ chat_jid: PHONE }]);
	});

	it('carries a pending proposal onto the survivor instead of aborting the merge', () => {
		// `send_proposals.chat_jid` references `chats(jid)` and foreign keys are
		// ON, so a proposal left on the losing jid would make the merge's
		// `DELETE FROM chats` throw — a live path that has already bitten the
		// owner once.
		const database = openTempDb();
		linkContactIdentity(database, { lidJid: LID, phoneJid: PHONE, name: FIXTURE_SPLIT_NAME });
		upsertChat(database, { jid: PHONE, kind: '1:1', last_msg_at: 3_000 });
		upsertChat(database, { jid: LID, kind: '1:1', last_msg_at: 4_000 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 4_000 });
		const id = insertProposal(database, {
			chatJid: LID,
			text: 'Yes — seven works.',
			basisMsgId: 'lid-1',
			now: 4_100
		});

		expect(mergeChats(database, LID, PHONE)).toBe(true);

		expect(listChats(database).map((c) => c.jid)).toEqual([PHONE]);
		expect(getProposal(database, id)).toMatchObject({
			chat_jid: PHONE,
			status: 'pending',
			basis_msg_id: 'lid-1'
		});
	});

	it('renames mapped LID chats that have no phone twin, and leaves unmapped ones alone', () => {
		const database = openTempDb();
		linkContactIdentity(database, { lidJid: LID, phoneJid: PHONE });
		upsertChat(database, { jid: LID, kind: '1:1', last_msg_at: 10, unread: 1 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 10 });
		upsertChat(database, { jid: '4242@lid', kind: '1:1', last_msg_at: 11 });
		upsertChat(database, { jid: 'team@g.us', kind: 'group', last_msg_at: 12 });

		replayMigration011(database);

		expect(listChats(database).map((c) => c.jid).sort()).toEqual(
			[PHONE, '4242@lid', 'team@g.us'].sort()
		);
		expect(listMessages(database, PHONE).map((m) => m.id)).toEqual(['lid-1']);
	});

	it('is idempotent — a second run finds nothing left to move', () => {
		const database = openTempDb();
		linkContactIdentity(database, { lidJid: LID, phoneJid: PHONE });
		upsertChat(database, { jid: LID, kind: '1:1', last_msg_at: 10, unread: 3 });
		seedMessage(database, { id: 'lid-1', chatJid: LID, ts: 10 });

		replayMigration011(database);
		replayMigration011(database);

		expect(listChats(database).map((c) => c.jid)).toEqual([PHONE]);
		expect(getChat(database, PHONE)?.unread).toBe(3);
		expect(listMessages(database, PHONE)).toHaveLength(1);
	});
});
