import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upsertChat, type ChatInput } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertMessage } from '../store/messages.js';
import { classifyNeedsReply, listNeedsReplyCandidates } from './classifier.js';

let db: AppDatabase | undefined;
let dataDir: string | undefined;

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-classifier-'));
	db = openDatabase({ dataDir });
	return db;
}

function chat(database: AppDatabase, overrides: Partial<ChatInput> = {}): ChatInput {
	const input: ChatInput = {
		jid: 'alice@s.whatsapp.net',
		kind: '1:1',
		last_msg_at: 100,
		muted: false,
		archived: false,
		...overrides
	};
	upsertChat(database, input);
	return input;
}

function message(database: AppDatabase, chatJid: string, fromMe = false, ts = 100): void {
	upsertMessage(database, {
		id: `${chatJid}-${ts}`,
		chat_jid: chatJid,
		from_me: fromMe,
		ts,
		text: 'Are we still meeting?',
		type: 'text'
	});
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('classifyNeedsReply', () => {
	it('classifies an unanswered inbound 1:1 chat', () => {
		const database = setup();
		chat(database);
		message(database, 'alice@s.whatsapp.net');

		expect(classifyNeedsReply(database, listNeedsReplyCandidates(database)[0]!.chat)?.lastInbound.id)
			.toBe('alice@s.whatsapp.net-100');
	});

	it.each([
		['group', { jid: 'team@g.us', kind: 'group' as const }],
		['muted', { muted: true }],
		['archived', { archived: true }],
		['skipped', { agent_state: 'skipped' }],
		['quiet', { agent_state: 'quiet' }]
	])('excludes %s chats', (_label, overrides) => {
		const database = setup();
		const input = chat(database, overrides);
		message(database, input.jid);

		expect(listNeedsReplyCandidates(database)).toEqual([]);
	});

	it('excludes a chat whose latest message is outbound', () => {
		const database = setup();
		chat(database);
		message(database, 'alice@s.whatsapp.net', false, 100);
		message(database, 'alice@s.whatsapp.net', true, 101);

		expect(listNeedsReplyCandidates(database)).toEqual([]);
	});

	it('allows only one exact outbound message under the development override', () => {
		const database = setup();
		chat(database);
		message(database, 'alice@s.whatsapp.net', true, 101);

		expect(
			listNeedsReplyCandidates(database, {
				devDraftFromMeMessageId: 'different-message'
			})
		).toEqual([]);
		expect(
			listNeedsReplyCandidates(database, {
				devDraftFromMeMessageId: 'alice@s.whatsapp.net-101'
			}).map(({ lastInbound }) => lastInbound.id)
		).toEqual(['alice@s.whatsapp.net-101']);
	});

	it('prioritizes the exact development message ahead of the normal backlog', () => {
		const database = setup();
		chat(database, { jid: 'old@s.whatsapp.net', last_msg_at: 100 });
		message(database, 'old@s.whatsapp.net', false, 100);
		chat(database, { jid: 'self@s.whatsapp.net', last_msg_at: 300 });
		message(database, 'self@s.whatsapp.net', true, 300);

		expect(
			listNeedsReplyCandidates(database, {
				devDraftFromMeMessageId: 'self@s.whatsapp.net-300'
			}).map(({ chat }) => chat.jid)
		).toEqual(['self@s.whatsapp.net', 'old@s.whatsapp.net']);
	});

	it('orders a backlog oldest-first', () => {
		const database = setup();
		for (const [jid, ts] of [
			['new@s.whatsapp.net', 300],
			['old@s.whatsapp.net', 100],
			['middle@s.whatsapp.net', 200]
		] as const) {
			chat(database, { jid, last_msg_at: ts });
			message(database, jid, false, ts);
		}

		expect(listNeedsReplyCandidates(database).map(({ chat }) => chat.jid)).toEqual([
			'old@s.whatsapp.net',
			'middle@s.whatsapp.net',
			'new@s.whatsapp.net'
		]);
	});
});
