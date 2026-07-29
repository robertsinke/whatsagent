/**
 * PL-U2 verification helper — starts createApp with MCP enabled against a
 * throwaway fixture dataDir (never the live account). Prints URL / token /
 * dataDir as JSON on stdout; keeps the process alive until SIGINT/SIGTERM.
 *
 * Usage:
 *   npx tsx scripts/mcp-verify-server.ts
 *   # → {"url":"http://127.0.0.1:…","token":"…","dataDir":"…","port":…}
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { openDatabase } from '../server/store/db.js';
import { upsertChat } from '../server/store/chats.js';
import { upsertDraft } from '../server/store/drafts.js';
import { upsertMessage } from '../server/store/messages.js';
import { EventBus } from '../server/api/events.js';

const dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-mcp-u2-'));
if (dataDir.includes('Application Support') || dataDir.includes('whatsagent-desktop')) {
	throw new Error(`Refusing dataDir that looks live: ${dataDir}`);
}

mkdirSync(join(dataDir, 'voice'), { recursive: true });
writeFileSync(
	join(dataDir, 'voice', 'global.md'),
	['# Owner voice (global)', '', '## Tone', '- Casual-first.', ''].join('\n'),
	'utf8'
);

const db = openDatabase({ dataDir });
const now = Date.now();

upsertChat(db, {
	jid: 'preview-direct@s.whatsapp.net',
	name: 'Quote Gallery',
	kind: '1:1',
	last_msg_at: now,
	unread: 2
});
upsertMessage(db, {
	id: 'qg-1',
	chat_jid: 'preview-direct@s.whatsapp.net',
	from_me: false,
	ts: now - 60_000,
	type: 'text',
	text: 'Still on for tomorrow?'
});
upsertMessage(db, {
	id: 'qg-2',
	chat_jid: 'preview-direct@s.whatsapp.net',
	from_me: false,
	ts: now,
	type: 'text',
	text: 'No rush, just checking.'
});

upsertChat(db, {
	jid: 'preview-drafting@s.whatsapp.net',
	name: 'Sam Ortega',
	kind: '1:1',
	last_msg_at: now,
	unread: 1
});
upsertMessage(db, {
	id: 'sam-1',
	chat_jid: 'preview-drafting@s.whatsapp.net',
	from_me: false,
	ts: now,
	type: 'text',
	text: 'Can we push the call to Thursday?'
});
upsertDraft(db, {
	chat_jid: 'preview-drafting@s.whatsapp.net',
	text: 'Thursday works for me.',
	original_text: 'Thursday works for me.',
	status: 'ready',
	basis_msg_id: 'sam-1',
	generated_at: now
});

const app = createApp({
	db,
	dataDir,
	events: new EventBus(),
	port: 0,
	host: '127.0.0.1',
	staticDir: null,
	mcp: true
});

await app.start();

if (!app.mcp) {
	throw new Error('MCP failed to enable');
}

const info = {
	url: app.url,
	mcpUrl: `${app.url}/mcp`,
	token: app.mcp.token,
	tokenPath: app.mcp.tokenPath,
	dataDir,
	port: app.port
};

console.log(JSON.stringify(info));
console.error(`[mcp-verify] listening on ${app.url}/mcp (fixture dataDir only)`);

async function shutdown(): Promise<void> {
	await app.close();
	process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
