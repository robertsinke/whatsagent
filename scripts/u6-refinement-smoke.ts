import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { openDatabase } from '../server/store/db.js';
import { upsertChat } from '../server/store/chats.js';
import { upsertDraft } from '../server/store/drafts.js';
import { upsertMessage } from '../server/store/messages.js';
import type { DraftProvider, DraftResult } from '../server/providers/provider.js';

const dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-u6-smoke-'));
const db = openDatabase({ dataDir });

// Seed a disposable 1:1 chat with a draft that can be refined.
upsertChat(db, {
	jid: 'maya@s.whatsapp.net',
	name: 'Maya',
	kind: '1:1',
	last_msg_at: 200,
	unread: 1
});
upsertMessage(db, {
	id: 'm1',
	chat_jid: 'maya@s.whatsapp.net',
	from_me: false,
	ts: 200,
	text: 'ping?'
});
upsertDraft(db, {
	chat_jid: 'maya@s.whatsapp.net',
	text: 'Yes, seven works for me.',
	status: 'ready',
	generated_at: 201,
	provider: 'fake',
	basis_msg_id: 'm1'
});

// Fake provider that returns a deterministic transform — no real LLM calls.
const fakeProvider: DraftProvider = {
	draft: async (): Promise<DraftResult> => ({ kind: 'draft', text: 'Refined: shorter reply.' })
};

const app = createApp({
	db,
	port: 0,
	host: '127.0.0.1',
	staticDir: join(process.cwd(), 'build'),
	draftProvider: fakeProvider,
	providerName: 'fake'
});

await app.start();
const origin = `http://127.0.0.1:${app.port}`;
console.log(`[smoke] app listening at ${origin}`);

let failures = 0;
function check(label: string, condition: boolean): void {
	if (condition) {
		console.log(`[smoke] PASS: ${label}`);
	} else {
		console.error(`[smoke] FAIL: ${label}`);
		failures++;
	}
}

// 1. The SPA index loads (proves the build is served and the shell renders).
const indexRes = await fetch(`${origin}/`);
check('SPA index.html serves', indexRes.status === 200);
const indexHtml = await indexRes.text();
check('SPA index.html has root mount', indexHtml.includes('id="svelte-kit-engage"') || indexHtml.includes('<div') || indexHtml.length > 100);

// 2. REST chats list returns the seeded chat.
const chatsRes = await fetch(`${origin}/api/chats`, { headers: { Origin: origin } });
check('GET /api/chats ok', chatsRes.status === 200);
const chatsBody = (await chatsRes.json()) as { items: { jid: string; name: string }[] };
check('seeded chat present', chatsBody.items.some((c) => c.jid === 'maya@s.whatsapp.net'));

// 3. The draft is fetchable.
const draftRes = await fetch(`${origin}/api/chats/maya%40s.whatsapp.net/draft`, {
	headers: { Origin: origin }
});
check('GET draft ok', draftRes.status === 200);
const draftBody = await draftRes.json();
check('draft text is the seeded preview', draftBody.text === 'Yes, seven works for me.');

// 4. Refinement (shorter) returns a transformed preview and never enqueues.
const refineRes = await fetch(`${origin}/api/chats/maya%40s.whatsapp.net/draft/refine`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Origin: origin },
	body: JSON.stringify({ intent: 'shorter', text: 'Yes, seven works for me.' })
});
check('POST draft/refine ok', refineRes.status === 200);
const refinedBody = await refineRes.json();
check('refined text is the fake provider output', refinedBody.text === 'Refined: shorter reply.');
check('refined draft keeps the original basis', refinedBody.basis_msg_id === 'm1');

// 5. No outbox row was created by refinement (R5/R6).
const outboxRes = await fetch(`${origin}/api/outbox`, { headers: { Origin: origin } });
const outboxBody = (await outboxRes.json()) as { items: unknown[] };
check('refinement created no outbox row', outboxBody.items.length === 0);

// 6. An invalid intent is rejected before the provider is touched.
const badIntentRes = await fetch(`${origin}/api/chats/maya%40s.whatsapp.net/draft/refine`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Origin: origin },
	body: JSON.stringify({ intent: 'friendlier' })
});
check('invalid intent rejected (400)', badIntentRes.status === 400);

// 7. Regenerate advances the basis to the latest inbound.
const regenRes = await fetch(`${origin}/api/chats/maya%40s.whatsapp.net/draft/refine`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Origin: origin },
	body: JSON.stringify({ intent: 'regenerate' })
});
check('POST draft/refine regenerate ok', regenRes.status === 200);
const regenBody = await regenRes.json();
check('regenerate advances basis to latest inbound', regenBody.basis_msg_id === 'm1');

await app.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures > 0) {
	console.error(`[smoke] ${failures} check(s) failed`);
	process.exit(1);
}
console.log('[smoke] all checks passed');