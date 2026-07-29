/**
 * Throwaway fixture seeder for the PL-S1 MCP spike.
 *
 * Creates a temp dataDir with the synthetic preview chats only — never the
 * live account. Prints the absolute path on stdout as the last line so runners
 * can capture it.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/store/db.js';
import { upsertChat } from '../server/store/chats.js';
import { upsertMessage } from '../server/store/messages.js';
import { FIXTURE_SPLIT_LID_JID, FIXTURE_SPLIT_NAME, FIXTURE_SPLIT_PHONE_JID } from '../shared/test-fixtures.js';
import { linkIdentityAndMergeChats } from '../server/store/identity.js';

const dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-spike-'));
mkdirSync(join(dataDir, 'voice'), { recursive: true });
writeFileSync(
	join(dataDir, 'voice', 'global.md'),
	[
		'# Owner voice (global)',
		'',
		'## Tone',
		'- Casual-first, warm, unedited.',
		'- Short and punchy by default.',
		'',
		'## Language',
		'- Multilingual: English with international contacts, Dutch with family.'
	].join('\n'),
	'utf8'
);

const db = openDatabase({ dataDir });

let clock = Math.floor(Date.UTC(2026, 6, 25, 10, 0, 0) / 1000);
const at = () => (clock += 60);

const QUOTE = 'preview-direct@s.whatsapp.net';
const GROUP = 'preview-group@g.us';
const SAM = 'preview-drafting@s.whatsapp.net';
const LEA = 'preview-terminal@s.whatsapp.net';
const NADIA = 'preview-nadia@s.whatsapp.net';
const STICKER = 'preview-sticker@s.whatsapp.net';
const VIDEO = 'preview-video-note@s.whatsapp.net';

upsertChat(db, { jid: QUOTE, name: 'Quote Gallery', kind: '1:1', last_msg_at: at(), unread: 2 });
upsertMessage(db, { id: 'qg-1', chat_jid: QUOTE, from_me: false, ts: at(), type: 'text', text: 'Still on for tomorrow?' });
upsertMessage(db, { id: 'qg-2', chat_jid: QUOTE, from_me: false, ts: at(), type: 'text', text: 'No rush, just checking.' });

upsertChat(db, { jid: GROUP, name: 'Group Sandbox', kind: 'group', last_msg_at: at(), unread: 0 });
upsertMessage(db, {
	id: 'g-1',
	chat_jid: GROUP,
	from_me: false,
	sender: 'ana@s.whatsapp.net',
	ts: at(),
	type: 'text',
	text: 'Anyone else running late?'
});

upsertChat(db, { jid: SAM, name: 'Sam Ortega', kind: '1:1', last_msg_at: at(), unread: 1 });
upsertMessage(db, {
	id: 'sam-1',
	chat_jid: SAM,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Can we push the call to Thursday?'
});

upsertChat(db, { jid: LEA, name: 'Lea Hofman', kind: '1:1', last_msg_at: at(), unread: 0 });
upsertMessage(db, {
	id: 'lea-1',
	chat_jid: LEA,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Thanks for the intro — talk next week?'
});
upsertMessage(db, {
	id: 'lea-2',
	chat_jid: LEA,
	from_me: true,
	ts: at(),
	type: 'text',
	text: 'Absolutely — I will send a couple of slots.'
});

upsertChat(db, { jid: NADIA, name: 'Nadia Bakker', kind: '1:1', last_msg_at: at(), unread: 0, agent_state: 'skipped' });
upsertMessage(db, {
	id: 'nadia-1',
	chat_jid: NADIA,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Heb je de cijfers van vorige maand nog ergens?'
});

upsertChat(db, { jid: STICKER, name: 'Sticker Lab', kind: '1:1', last_msg_at: at(), unread: 0 });
upsertMessage(db, { id: 'st-1', chat_jid: STICKER, from_me: true, ts: at(), type: 'text', text: 'nice sticker' });

upsertChat(db, { jid: VIDEO, name: 'Video Note Lab', kind: '1:1', last_msg_at: at(), unread: 0 });
upsertMessage(db, { id: 'vn-1', chat_jid: VIDEO, from_me: true, ts: at(), type: 'text', text: 'got the note' });

upsertChat(db, { jid: FIXTURE_SPLIT_PHONE_JID, kind: '1:1', last_msg_at: at(), unread: 0 });
upsertMessage(db, {
	id: 'casey-1',
	chat_jid: FIXTURE_SPLIT_PHONE_JID,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Zullen we het zo even doornemen?'
});
upsertChat(db, { jid: FIXTURE_SPLIT_LID_JID, kind: '1:1', last_msg_at: at(), unread: 0 });
linkIdentityAndMergeChats(db, {
	lidJid: FIXTURE_SPLIT_LID_JID,
	phoneJid: FIXTURE_SPLIT_PHONE_JID,
	name: FIXTURE_SPLIT_NAME
});

db.close();

console.log(`SPIKE_DATADIR=${dataDir}`);
console.log(dataDir);
