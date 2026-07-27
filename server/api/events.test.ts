import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getChat, upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertMessage } from '../store/messages.js';
import { EventBus, createIngestEventHooks, type ServerEvent } from './events.js';
import { FIXTURE_EVENTS_PHONE } from '../../shared/test-fixtures.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-events-'));
	db = openDatabase({ dataDir });
	return db;
}

describe('chat-updated events', () => {
	/**
	 * Regression: ingest used to publish the raw store row. The SPA consumes a
	 * ChatView and dereferences `display_jid` while rendering, so a partial
	 * payload threw inside Svelte's effect flush and froze the whole chat list —
	 * rows kept a stale `selected` state and reopening a chat did nothing.
	 */
	it('carry the full client-facing view, never the raw store row', () => {
		const database = openTempDb();
		const jid = `${FIXTURE_EVENTS_PHONE}@s.whatsapp.net`;
		upsertChat(database, {
			jid,
			name: null,
			kind: '1:1',
			last_msg_at: 1_700_000_000
		});
		upsertMessage(database, {
			id: 'inbound-1',
			chat_jid: jid,
			from_me: false,
			ts: 1_700_000_000,
			text: 'hoi'
		});

		const events: ServerEvent[] = [];
		const bus = new EventBus();
		bus.subscribe((event) => events.push(event));

		createIngestEventHooks(bus, database).onChatUpdated(getChat(database, jid)!);

		expect(events).toHaveLength(1);
		const event = events[0]!;
		expect(event.type).toBe('chat-updated');
		if (event.type !== 'chat-updated') throw new Error('unreachable');
		// Every field the chat list renders must be present.
		expect(event.chat.display_jid).toBe(jid);
		expect(event.chat.preview).toBe('hoi');
		expect(event.chat.preview_from_me).toBe(false);
		expect(event.chat.needs_reply).toBe(true);
		expect(event.chat.draft_status).toBeNull();
	});
});
