import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../index.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertChat } from '../store/chats.js';
import { upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import { getOutbox } from '../store/outbox.js';
import { EventBus } from './events.js';

let dataDir: string | undefined;
let app: App | undefined;
let db: AppDatabase | undefined;

async function startTestApp(events = new EventBus()): Promise<App> {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-api-'));
	db = openDatabase({ dataDir });
	app = createApp({
		db,
		events,
		port: 0,
		host: '127.0.0.1',
		staticDir: null
	});
	await app.start();
	return app;
}

function baseUrl(): string {
	return app!.url;
}

function originForApp(): string {
	return `http://127.0.0.1:${app!.port}`;
}

async function api(
	path: string,
	init: RequestInit & { origin?: string | null } = {}
): Promise<Response> {
	const { origin, headers: initHeaders, ...rest } = init;
	const headers = new Headers(initHeaders);
	if (origin !== null) {
		headers.set('Origin', origin ?? originForApp());
	}
	return fetch(`${baseUrl()}${path}`, { ...rest, headers });
}

function seedNeedsReplyFixture(database: AppDatabase): void {
	upsertChat(database, {
		jid: 'alice@s.whatsapp.net',
		name: 'Alice',
		kind: '1:1',
		last_msg_at: 200,
		unread: 1
	});
	upsertChat(database, {
		jid: 'bob@s.whatsapp.net',
		name: 'Bob',
		kind: '1:1',
		last_msg_at: 150,
		unread: 0
	});
	upsertChat(database, {
		jid: 'team@g.us',
		name: 'Team',
		kind: 'group',
		last_msg_at: 180,
		unread: 3
	});
	upsertChat(database, {
		jid: 'muted@s.whatsapp.net',
		name: 'Muted',
		kind: '1:1',
		last_msg_at: 190,
		unread: 1,
		muted: true
	});

	upsertMessage(database, {
		id: 'a1',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: false,
		ts: 200,
		text: 'ping?'
	});
	upsertMessage(database, {
		id: 'b1',
		chat_jid: 'bob@s.whatsapp.net',
		from_me: true,
		ts: 150,
		text: 'already replied'
	});
	upsertMessage(database, {
		id: 'g1',
		chat_jid: 'team@g.us',
		from_me: false,
		ts: 180,
		text: '@owner hi'
	});
	upsertMessage(database, {
		id: 'm1',
		chat_jid: 'muted@s.whatsapp.net',
		from_me: false,
		ts: 190,
		text: 'muted inbound'
	});
}

afterEach(async () => {
	if (app) {
		// close() also closes db — clear our handle first so we don't double-close.
		const current = app;
		app = undefined;
		db = undefined;
		await current.close();
	} else {
		db?.close();
		db = undefined;
	}
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('GET /api/chats', () => {
	it('returns needs-reply subset when filtered', async () => {
		await startTestApp();
		seedNeedsReplyFixture(db!);

		const all = await api('/api/chats');
		expect(all.status).toBe(200);
		const allBody = (await all.json()) as { items: { jid: string }[] };
		expect(allBody.items.map((c) => c.jid)).toEqual([
			'alice@s.whatsapp.net',
			'muted@s.whatsapp.net',
			'team@g.us',
			'bob@s.whatsapp.net'
		]);

		const filtered = await api('/api/chats?filter=needs-reply');
		expect(filtered.status).toBe(200);
		const body = (await filtered.json()) as { items: { jid: string }[] };
		expect(body.items.map((c) => c.jid)).toEqual(['alice@s.whatsapp.net']);
	});
});

describe('POST /api/chats/:jid/messages (send → outbox)', () => {
	it('enqueues an outbox row and never requires a WhatsApp send path', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			name: 'Alice',
			last_msg_at: 1
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'hello from owner' })
		});
		expect(res.status).toBe(202);
		const row = (await res.json()) as {
			id: number;
			chat_jid: string;
			text: string;
			status: string;
		};
		expect(row.chat_jid).toBe('alice@s.whatsapp.net');
		expect(row.text).toBe('hello from owner');
		expect(row.status).toBe('pending');
		expect(getOutbox(db!, row.id)?.text).toBe('hello from owner');
	});

	it('returns 404-shaped error for unknown chat jid', async () => {
		await startTestApp();
		const res = await api('/api/chats/missing%40s.whatsapp.net/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'nope' })
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; jid: string };
		expect(body.error).toBe('Chat not found');
		expect(body.jid).toBe('missing@s.whatsapp.net');
	});
});

describe('Origin/Host CSRF defense', () => {
	it('rejects mutating REST with a foreign Origin', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 1
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/messages', {
			method: 'POST',
			origin: 'https://evil.example',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'csrf' })
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { reason: string };
		expect(body.reason).toBe('Origin not allowed');
		expect(getOutbox(db!, 1)).toBeUndefined();
	});

	it('accepts the same mutating request from the app origin', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 1
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/read', {
			method: 'POST',
			origin: originForApp(),
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
		expect(res.status).toBe(200);
	});

	it('rejects WS upgrade with a foreign Origin', async () => {
		await startTestApp();

		await expect(
			new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/ws`, {
					headers: {
						Origin: 'https://evil.example',
						Host: `127.0.0.1:${app!.port}`
					}
				});
				ws.once('open', () => {
					ws.close();
					reject(new Error('upgrade should have been rejected'));
				});
				ws.once('unexpected-response', (_req, res) => {
					expect(res.statusCode).toBe(403);
					resolve();
				});
				ws.once('error', () => {
					// Some stacks surface rejection as error after unexpected-response.
				});
			})
		).resolves.toBeUndefined();
	});

	it('accepts WS upgrade from the app origin', async () => {
		await startTestApp();
		const origin = originForApp();

		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/ws`, {
				headers: { Origin: origin, Host: `127.0.0.1:${app!.port}` }
			});
			ws.once('open', () => {
				ws.close();
				resolve();
			});
			ws.once('unexpected-response', (_req, res) => {
				reject(new Error(`unexpected status ${res.statusCode}`));
			});
			ws.once('error', reject);
		});
	});
});

describe('store write → WS event', () => {
	it('emits outbox-updated to a connected client when send enqueues', async () => {
		const events = new EventBus();
		await startTestApp(events);
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 1
		});

		const origin = originForApp();

		const received = new Promise<unknown>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/ws`, {
				headers: { Origin: origin, Host: `127.0.0.1:${app!.port}` }
			});
			ws.on('message', (data) => {
				const event = JSON.parse(String(data)) as { type: string };
				if (event.type === 'outbox-updated') {
					ws.close();
					resolve(event);
				}
			});
			ws.once('open', () => {
				void api('/api/chats/alice%40s.whatsapp.net/messages', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ text: 'via ws' })
				}).then((res) => {
					if (!res.ok) reject(new Error(`send failed: ${res.status}`));
				}, reject);
			});
			ws.once('error', reject);
		});

		await expect(received).resolves.toMatchObject({
			type: 'outbox-updated',
			outbox: { text: 'via ws', status: 'pending' }
		});
	});

	it('ingest hooks fan message-new through the same bus', async () => {
		const events = new EventBus();
		await startTestApp(events);
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 1
		});

		const origin = originForApp();

		const received = new Promise<unknown>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/ws`, {
				headers: { Origin: origin, Host: `127.0.0.1:${app!.port}` }
			});
			ws.on('message', (data) => {
				const event = JSON.parse(String(data)) as { type: string };
				if (event.type === 'message-new') {
					ws.close();
					resolve(event);
				}
			});
			ws.once('open', () => {
				app!.ingestHooks.onMessageIngested({
					id: 'in1',
					chat_jid: 'alice@s.whatsapp.net',
					channel: 'whatsapp',
					from_me: false,
					sender: null,
					ts: 99,
					type: 'text',
					text: 'inbound',
					media_ref: null,
					media_state: 'placeholder',
					media_error: null,
					raw: null
				});
			});
			ws.once('error', reject);
		});

		await expect(received).resolves.toMatchObject({
			type: 'message-new',
			message: { id: 'in1', text: 'inbound' }
		});
	});
});

describe('drafts', () => {
	it('rejects a stale draft even when an outbound message is newest', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 30,
			unread: 1
		});
		upsertMessage(db!, {
			id: 'basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 10,
			text: 'first question'
		});
		upsertMessage(db!, {
			id: 'newer-inbound',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 20,
			text: 'follow-up'
		});
		upsertMessage(db!, {
			id: 'outbound-tail',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 30,
			text: 'unrelated reply'
		});
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'old draft',
			status: 'drafted',
			generated_at: 11,
			basis_msg_id: 'basis'
		});

		const response = await api('/api/chats/alice%40s.whatsapp.net/draft/approve', {
			method: 'POST'
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			basis_msg_id: 'basis',
			latest_inbound_id: 'newer-inbound'
		});
	});

	it('approve enqueues outbox; skip demotes chat from needs-reply', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 10,
			unread: 1
		});
		upsertMessage(db!, {
			id: 'basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 10,
			text: 'question?'
		});
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'draft reply',
			status: 'drafted',
			generated_at: 11,
			basis_msg_id: 'basis'
		});

		const approve = await api('/api/chats/alice%40s.whatsapp.net/draft/approve', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'edited reply' })
		});
		expect(approve.status).toBe(202);
		const approved = (await approve.json()) as {
			outbox: { text: string; status: string };
			draft: { status: string };
		};
		expect(approved.outbox.text).toBe('edited reply');
		expect(approved.outbox.status).toBe('pending');
		expect(approved.draft.status).toBe('approved');

		// Re-seed a skippable draft on a needs-reply chat.
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'another',
			status: 'drafted',
			generated_at: 12,
			basis_msg_id: 'basis'
		});
		const skip = await api('/api/chats/alice%40s.whatsapp.net/draft/skip', {
			method: 'POST'
		});
		expect(skip.status).toBe(200);

		const filtered = await api('/api/chats?filter=needs-reply');
		const body = (await filtered.json()) as { items: unknown[] };
		expect(body.items).toEqual([]);
	});
});
