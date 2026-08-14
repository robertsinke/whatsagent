/**
 * NEWCHAT-1 — start a 1:1 chat with a number that has never messaged the owner.
 *
 * Load-bearing assertions:
 * - a person already known under an `@lid` jid returns the EXISTING chat
 * - the new chat sorts FIRST in `listChats` (null `last_msg_at` sorts last)
 * - R9: the outbox is empty afterwards — this action never reaches it
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actionRegistry, dispatch } from './index.js';
import { MAX_AGENT_EMPTY_CHATS } from './start-chat.js';
import type { ActionCaller } from './types.js';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';
import { listChats, upsertChat } from '../store/chats.js';
import { linkContactIdentity, upsertContact } from '../store/contacts.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertMessage } from '../store/messages.js';
import { listOutbox } from '../store/outbox.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-newchat1-'));
	db = openDatabase({ dataDir });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

const PHONE = '+31 6 1234 5678';
const PHONE_JID = '31612345678@s.whatsapp.net';

function makeDeps(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	return {
		db: db!,
		events: new EventBus(),
		port: 8799,
		getConnectionStatus: () => ({ state: 'connected', qr: null }),
		checkRegistered: async (jid: string) => ({ registered: true, jid }),
		...overrides
	};
}

function startChat(
	deps: RoutesDeps,
	phone: string = PHONE,
	caller: ActionCaller = 'frontend'
) {
	return dispatch(actionRegistry, 'start-chat', { phone }, { caller, deps });
}

describe('start-chat', () => {
	it('creates a 1:1 chat that sorts first in the chat list', async () => {
		const database = openTempDb();
		// An older chat with real activity — the new one must still outrank it.
		upsertChat(database, { jid: 'old@s.whatsapp.net', kind: '1:1', last_msg_at: 1_000 });

		const events: unknown[] = [];
		const bus = new EventBus();
		bus.subscribe((event) => events.push(event));
		const result = await startChat(makeDeps({ events: bus }));

		expect(result.kind).toBe('json');
		expect(result).toMatchObject({ status: 201, body: { created: true } });
		const chats = listChats(database);
		expect(chats[0]?.jid).toBe(PHONE_JID);
		expect(chats[0]?.last_msg_at).toBeGreaterThan(0);
		expect(chats).toHaveLength(2);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'chat-updated' })
		);
	});

	it('returns the existing phone chat instead of a second row', async () => {
		const database = openTempDb();
		upsertChat(database, { jid: PHONE_JID, kind: '1:1', name: 'Alice', last_msg_at: 5_000 });

		const result = await startChat(makeDeps());

		expect(result).toMatchObject({
			status: 200,
			body: { created: false, chat: expect.objectContaining({ jid: PHONE_JID }) }
		});
		expect(listChats(database)).toHaveLength(1);
	});

	it('returns the existing LID chat for a person with a recorded phone mapping', async () => {
		// The load-bearing case: W4-U13's double-conversation bug. This person is
		// stored under an opaque `@lid` jid; inserting the phone jid would grow a
		// second conversation for the same human.
		const database = openTempDb();
		const LID_JID = '99887766554433@lid';
		linkContactIdentity(database, {
			lidJid: LID_JID,
			phoneJid: PHONE_JID,
			name: 'Alice'
		});
		upsertChat(database, { jid: LID_JID, kind: '1:1', name: 'Alice', last_msg_at: 5_000 });

		const result = await startChat(makeDeps());

		expect(result).toMatchObject({
			status: 200,
			body: { created: false, chat: expect.objectContaining({ jid: LID_JID }) }
		});
		expect(listChats(database).map((c) => c.jid)).toEqual([LID_JID]);
	});

	it('rejects a number that is not on WhatsApp without creating a row', async () => {
		const database = openTempDb();
		const result = await startChat(
			makeDeps({ checkRegistered: async () => ({ registered: false, jid: null }) })
		);

		expect(result).toMatchObject({ kind: 'error', status: 404 });
		expect(listChats(database)).toHaveLength(0);
	});

	it('reports the app-must-be-open case when the dep is absent', async () => {
		const database = openTempDb();
		const deps = makeDeps();
		delete deps.checkRegistered;

		const result = await startChat(deps);

		expect(result).toMatchObject({ kind: 'error', status: 503 });
		expect((result as { error: string }).error).toContain('WhatsAgent app to be open');
		expect(listChats(database)).toHaveLength(0);
	});

	it('rejects a bare national number rather than guessing a country', async () => {
		const database = openTempDb();
		const result = await startChat(makeDeps(), '06 1234 5678');

		expect(result).toMatchObject({ kind: 'error', status: 400 });
		expect(listChats(database)).toHaveLength(0);
	});

	it('adopts the jid WhatsApp reports rather than the one derived from the number', async () => {
		const database = openTempDb();
		const REPORTED = '55443322110099@lid';
		const result = await startChat(
			makeDeps({ checkRegistered: async () => ({ registered: true, jid: REPORTED }) })
		);

		expect(result).toMatchObject({ status: 201 });
		expect(listChats(database).map((c) => c.jid)).toEqual([REPORTED]);
	});

	it('names the new chat from an existing contact when there is one', async () => {
		const database = openTempDb();
		upsertContact(database, { jid: PHONE_JID, name: 'Alice Doe' });

		await startChat(makeDeps());

		expect(listChats(database)[0]?.name).toBe('Alice Doe');
	});

	it('caps the tool caller at the empty-chat limit but not the frontend', async () => {
		const database = openTempDb();
		for (let i = 0; i < MAX_AGENT_EMPTY_CHATS; i += 1) {
			upsertChat(database, { jid: `empty-${i}@s.whatsapp.net`, kind: '1:1', last_msg_at: 1 });
		}
		// A chat that HAS a message must not count toward the cap.
		upsertChat(database, { jid: 'busy@s.whatsapp.net', kind: '1:1', last_msg_at: 2 });
		upsertMessage(database, {
			id: 'busy-1',
			chat_jid: 'busy@s.whatsapp.net',
			from_me: false,
			ts: 2,
			type: 'text',
			text: 'hi'
		});

		const refused = await startChat(makeDeps(), PHONE, 'tool');
		expect(refused).toMatchObject({ kind: 'error', status: 409 });
		expect(listChats(database)).toHaveLength(6);

		const allowed = await startChat(makeDeps(), PHONE, 'frontend');
		expect(allowed).toMatchObject({ status: 201 });
		expect(listChats(database)).toHaveLength(7);
	});

	it('is reachable by both callers', () => {
		const action = actionRegistry.get('start-chat');
		expect(action).toBeDefined();
		expect([...action!.callers].sort()).toEqual(['frontend', 'tool']);
	});

	it('R9: the outbox is empty after starting a chat', async () => {
		const database = openTempDb();
		await startChat(makeDeps(), PHONE, 'tool');

		// The point of this assertion: start-chat writes a chat row and nothing
		// else. No path from it reaches the outbox, so the agent gains a chat it
		// still cannot send into without the owner confirming a proposal.
		expect(listOutbox(database)).toEqual([]);
	});
});
