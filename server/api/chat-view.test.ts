import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getChat, upsertChat } from '../store/chats.js';
import { upsertContact } from '../store/contacts.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getMessage, upsertMessage } from '../store/messages.js';
import { chatNeedsReply, toChatView } from './chat-view.js';
import { toMessageView } from './message-view.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-chat-view-'));
	db = openDatabase({ dataDir });
	return db;
}

describe('toChatView name resolution', () => {
	it('a masked chat name does not outrank a contact name (the headline case)', () => {
		const database = openTempDb();
		const jid = '31612345678@s.whatsapp.net';
		// The chat row carries the WhatsApp privacy mask verbatim.
		upsertChat(database, {
			jid,
			name: '+31 \u2219\u2219\u2219\u2219 85',
			kind: '1:1',
			last_msg_at: 100,
			unread: 0
		});
		upsertContact(database, { jid, name: 'Felix De Groene' });

		const view = toChatView(database, getChat(database, jid)!, () => false);
		expect(view.name).toBe('Felix De Groene');
	});

	it('falls back to the number, not the mask, when no contact name exists', () => {
		const database = openTempDb();
		const jid = '31612345678@s.whatsapp.net';
		upsertChat(database, {
			jid,
			name: '+31 \u2219\u2219\u2219\u2219 85',
			kind: '1:1',
			last_msg_at: 100,
			unread: 0
		});
		// No contact row at all.
		const view = toChatView(database, getChat(database, jid)!, () => false);
		expect(view.name).toBeNull();
		// The client renders the number from display_jid — the mask never wins.
		expect(view.display_jid).toBe(jid);
	});

	it('uses a contact push_name when no chat name and no contact name exist', () => {
		const database = openTempDb();
		const jid = '31612345678@s.whatsapp.net';
		upsertChat(database, { jid, name: null, kind: '1:1', last_msg_at: 100 });
		upsertContact(database, { jid, name: null, push_name: 'Felix' });

		const view = toChatView(database, getChat(database, jid)!, () => false);
		expect(view.name).toBe('Felix');
	});

	it('uses a usable chat.name over a contact name', () => {
		const database = openTempDb();
		const jid = 'alice@s.whatsapp.net';
		upsertChat(database, { jid, name: 'Alice Ramos', kind: '1:1', last_msg_at: 100 });
		upsertContact(database, { jid, name: 'Alice Contact Name' });

		const view = toChatView(database, getChat(database, jid)!, () => false);
		expect(view.name).toBe('Alice Ramos');
	});

	it('chat list and message-bubble labels agree for the same person', () => {
		const database = openTempDb();
		const jid = '31612345678@s.whatsapp.net';
		// Masked chat, but the contact carries the real name.
		upsertChat(database, {
			jid,
			name: '+31 \u2219\u2219\u2219\u2219 85',
			kind: '1:1',
			last_msg_at: 200,
			unread: 1
		});
		upsertContact(database, { jid, name: 'Felix De Groene' });
		upsertMessage(database, {
			id: 'm1',
			chat_jid: jid,
			from_me: false,
			sender: jid,
			ts: 200,
			type: 'text',
			text: 'hi'
		});

		const chatView = toChatView(database, getChat(database, jid)!, () => false);
		const messageView = toMessageView(database, getMessage(database, 'm1')!);

		expect(chatView.name).toBe('Felix De Groene');
		expect(messageView.sender?.name).toBe('Felix De Groene');
		expect(chatNeedsReply(database, getChat(database, jid)!)).toBe(true);
	});
});