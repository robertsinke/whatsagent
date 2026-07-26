import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../index.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertChat } from '../store/chats.js';
import { linkContactIdentity, upsertContact } from '../store/contacts.js';
import { upsertDraft } from '../store/drafts.js';
import { listDraftFeedback } from '../store/draft-feedback.js';
import { getMessage, upsertMessage, upsertMessageReaction } from '../store/messages.js';
import { getOutbox } from '../store/outbox.js';
import { EventBus } from './events.js';
import type { Memory } from '../agent/memory/memory.js';
import type { DraftProvider } from '../providers/provider.js';
import type { WhatsAppSendTransport } from '../channels/whatsapp/send.js';
import { handleHistorySet, type HistorySetPayload } from '../channels/whatsapp/ingest.js';

let dataDir: string | undefined;
let app: App | undefined;
let db: AppDatabase | undefined;

async function startTestApp(
	events = new EventBus(),
	memory?: Memory,
	draftProvider?: DraftProvider,
	options: { outboxTransport?: WhatsAppSendTransport } = {}
): Promise<App> {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-api-'));
	db = openDatabase({ dataDir });
	app = createApp({
		db,
		events,
		port: 0,
		host: '127.0.0.1',
		staticDir: null,
		memory,
		draftProvider,
		providerName: draftProvider ? 'fake' : undefined,
		outboxTransport: options.outboxTransport
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

function seedMessageFidelityFixture(database: AppDatabase): void {
	const fixture = JSON.parse(
		readFileSync(
			new URL('../channels/whatsapp/fixtures/message-fidelity.json', import.meta.url),
			'utf8'
		)
	) as HistorySetPayload;
	handleHistorySet(database, fixture);
}

afterEach(async () => {
	vi.restoreAllMocks();
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

describe('GET /api/settings', () => {
	it('surfaces effective near-immediate pacing defaults', async () => {
		await startTestApp();

		const response = await api('/api/settings');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			pacing_min_seconds: '0',
			pacing_max_seconds: '1'
		});
	});
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

	it('projects saved contact names and phone aliases without changing the routing jid', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: '203663104602149@lid',
			kind: '1:1',
			last_msg_at: 100
		});
		upsertContact(db!, {
			jid: '31683799485@s.whatsapp.net',
			name: 'Robert'
		});
		linkContactIdentity(db!, {
			lidJid: '203663104602149@lid',
			phoneJid: '31683799485@s.whatsapp.net'
		});

		const response = await api('/api/chats');
		const body = (await response.json()) as {
			items: Array<{ jid: string; display_jid: string; name: string | null }>;
		};

		expect(body.items[0]).toMatchObject({
			jid: '203663104602149@lid',
			display_jid: '31683799485@s.whatsapp.net',
			name: 'Robert'
		});
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
			source: string;
		};
		expect(row.chat_jid).toBe('alice@s.whatsapp.net');
		expect(row.text).toBe('hello from owner');
		expect(row.status).toBe('pending');
		expect(row.source).toBe('manual');
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

	it('rejects a reply target from another chat without creating an outbox row', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 2 });
		upsertChat(db!, { jid: 'bob@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(db!, {
			id: 'bob-message',
			chat_jid: 'bob@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'Bob only'
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'wrong chat', reply_to_msg_id: 'bob-message' })
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Reply target does not belong to this chat' });
		expect(db!.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
	});

	it('persists and returns a same-chat reply target on the outbox wire shape', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(db!, {
			id: 'alice-message',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'Question'
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/messages', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: 'Answer', reply_to_msg_id: 'alice-message' })
		});
		const row = (await res.json()) as { id: number; reply_to_msg_id: string | null };

		expect(res.status).toBe(202);
		expect(row.reply_to_msg_id).toBe('alice-message');
		expect(getOutbox(db!, row.id)?.reply_to_msg_id).toBe('alice-message');
	});
});

describe('POST /api/messages/:id/reactions (reaction → outbox)', () => {
	it('enqueues a reaction outbox row that rides the pacer', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(db!, {
			id: 'target-msg',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'hello'
		});

		const res = await api('/api/messages/target-msg/reactions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emoji: '👍' })
		});
		expect(res.status).toBe(202);
		const row = (await res.json()) as {
			id: number;
			chat_jid: string;
			payload_kind: string;
			reaction_emoji: string;
			reaction_target_msg_id: string;
			status: string;
			source: string;
		};
		expect(row.payload_kind).toBe('reaction');
		expect(row.reaction_emoji).toBe('👍');
		expect(row.reaction_target_msg_id).toBe('target-msg');
		expect(row.status).toBe('pending');
		expect(row.source).toBe('manual');
		expect(getOutbox(db!, row.id)?.reaction_target_msg_id).toBe('target-msg');
	});

	it('enqueues a removal with an empty emoji string', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(db!, {
			id: 'target-msg',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'hello'
		});

		const res = await api('/api/messages/target-msg/reactions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emoji: '' })
		});
		expect(res.status).toBe(202);
		const row = (await res.json()) as { reaction_emoji: string };
		expect(row.reaction_emoji).toBe('');
	});

	it('returns 404 for an unknown message', async () => {
		await startTestApp();
		const res = await api('/api/messages/unknown/reactions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emoji: '👍' })
		});
		expect(res.status).toBe(404);
	});

	it('rejects a missing emoji field', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(db!, {
			id: 'target-msg',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'hello'
		});

		const res = await api('/api/messages/target-msg/reactions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({})
		});
		expect(res.status).toBe(400);
	});
});

describe('GET /api/chats/:jid/messages (structured views)', () => {
	it('returns late-bound senders, quote fallbacks, and reaction aggregates without raw envelopes', async () => {
		await startTestApp();
		seedMessageFidelityFixture(db!);

		const response = await api('/api/chats/team%40g.us/messages?limit=20');
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<Record<string, any>>;
		};
		const target = body.items.find((message) => message.id === 'group-target')!;
		const bob = body.items.find((message) => message.id === 'group-bob')!;
		const resolved = body.items.find((message) => message.id === 'quote-resolved')!;
		const missing = body.items.find((message) => message.id === 'quote-missing')!;

		expect(target.sender).toMatchObject({
			jid: 'alice@s.whatsapp.net',
			name: 'Alice'
		});
		expect(bob.sender).toMatchObject({
			jid: '222@lid',
			display_jid: '31600000002@s.whatsapp.net',
			name: 'Bob'
		});
		expect(resolved.quote).toMatchObject({
			target_id: 'group-target',
			resolved: true,
			type: 'text',
			text: 'Original text',
			sender: { name: 'Alice' }
		});
		expect(missing.quote).toMatchObject({
			target_id: 'missing-target',
			resolved: false,
			type: 'image',
			text: 'Fallback caption',
			sender: { name: 'Bob' }
		});
		expect(target.reactions).toEqual([
			expect.objectContaining({
				emoji: '👍',
				count: 2,
				actors: [
					expect.objectContaining({ name: 'Alice' }),
					expect.objectContaining({ name: 'Bob' })
				]
			})
		]);
		expect(JSON.stringify(body)).not.toContain('"raw"');
	});

	it('uses a JID fallback until a later contact update improves the same stored message', async () => {
		await startTestApp();
		seedMessageFidelityFixture(db!);

		const before = await api('/api/chats/team%40g.us/messages?limit=20').then((res) => res.json()) as {
			items: Array<{ id: string; sender: { name: string } }>;
		};
		expect(before.items.find((message) => message.id === 'quote-resolved')?.sender.name).toBe(
			'unknown@s.whatsapp.net'
		);

		upsertContact(db!, { jid: 'unknown@s.whatsapp.net', name: 'Charlie' });
		const after = await api('/api/chats/team%40g.us/messages?limit=20').then((res) => res.json()) as {
			items: Array<{ id: string; sender: { name: string } }>;
		};
		expect(after.items.find((message) => message.id === 'quote-resolved')?.sender.name).toBe(
			'Charlie'
		);
	});
});

describe('GET /api/chats/:jid/messages (quote subtypes)', () => {
	// The live DB holds zero stored quotes — these assertions are the only
	// evidence the API surfaces a typed QuoteView per stored subtype.
	it('projects quote type and text for each stored subtype', async () => {
		await startTestApp();
		seedMessageFidelityFixture(db!);

		const response = await api('/api/chats/quotes%40g.us/messages?limit=50');
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<{ id: string; quote: { type: string; text: string | null } | null }>;
		};
		const byId = new Map(body.items.map((m) => [m.id, m.quote]));

		expect(byId.get('quote-image')).toMatchObject({ type: 'image', text: 'Sunset at the pier' });
		expect(byId.get('quote-video')).toMatchObject({ type: 'video', text: 'Clip from the gig' });
		expect(byId.get('quote-audio')).toMatchObject({ type: 'audio', text: null });
		expect(byId.get('quote-document')).toMatchObject({ type: 'document', text: 'Contract' });
		expect(byId.get('quote-sticker')).toMatchObject({ type: 'sticker', text: null });
		expect(byId.get('quote-location')).toMatchObject({ type: 'location', text: 'Amsterdam Office' });
		expect(byId.get('quote-contact')).toMatchObject({ type: 'contact', text: 'Sara Patel' });
		expect(byId.get('quote-live-location')).toMatchObject({
			type: 'location',
			text: 'On my way'
		});
		expect(byId.get('quote-contacts-array')).toMatchObject({
			type: 'contact',
			text: 'Two contacts'
		});
		// Unrecognized subtype still gets a typed quote — never dropped.
		expect(byId.get('quote-unrecognized')).toMatchObject({
			type: 'pollCreation',
			text: null
		});
	});
});

describe('GET /api/chats/:jid/messages (focused page — U5 jump-to-quote)', () => {
	it('returns a page centered on focusMsgId with context on both sides', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'chain@s.whatsapp.net', kind: '1:1', last_msg_at: 20 });
		for (let i = 1; i <= 20; i++) {
			upsertMessage(db!, {
				id: `c${i}`,
				chat_jid: 'chain@s.whatsapp.net',
				from_me: i % 2 === 0,
				ts: i,
				text: `msg ${i}`
			});
		}

		const res = await api('/api/chats/chain%40s.whatsapp.net/messages?limit=10&focusMsgId=c10');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ id: string }> };
		// limit 10 → half=5 → 5 older (c5–c9) + target + 5 newer (c11–c15).
		expect(body.items.map((m) => m.id)).toEqual([
			'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13', 'c14', 'c15'
		]);
	});

	it('returns an empty page for an unknown focusMsgId (graceful, not a 404)', async () => {
		await startTestApp();
		upsertChat(db!, { jid: 'chain@s.whatsapp.net', kind: '1:1', last_msg_at: 1 });
		upsertMessage(db!, {
			id: 'c1',
			chat_jid: 'chain@s.whatsapp.net',
			from_me: false,
			ts: 1,
			text: 'only'
		});

		const res = await api('/api/chats/chain%40s.whatsapp.net/messages?focusMsgId=missing');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ id: string }> };
		// Empty page — the client degrades the jump to a no-op, never a crash.
		expect(body.items).toEqual([]);
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
					quote_target_id: null,
					quote_sender: null,
					quote_type: null,
					quote_text: null,
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

	it('fans a sanitized reaction aggregate as a targeted message-updated event', async () => {
		const events = new EventBus();
		await startTestApp(events);
		upsertChat(db!, { jid: 'team@g.us', kind: 'group', last_msg_at: 1 });
		upsertContact(db!, { jid: 'alice@s.whatsapp.net', name: 'Alice' });
		upsertMessage(db!, {
			id: 'target',
			chat_jid: 'team@g.us',
			from_me: false,
			sender: 'alice@s.whatsapp.net',
			ts: 1,
			text: 'hello',
			raw: '{"credentialAdjacent":"must-not-leak"}'
		});
		upsertMessageReaction(db!, {
			chat_jid: 'team@g.us',
			target_msg_id: 'target',
			actor: 'alice@s.whatsapp.net',
			emoji: '🔥',
			updated_at: 2
		});
		const stored = getMessage(db!, 'target')!;
		const origin = originForApp();

		const received = new Promise<Record<string, unknown>>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/ws`, {
				headers: { Origin: origin, Host: `127.0.0.1:${app!.port}` }
			});
			ws.on('message', (data) => {
				const event = JSON.parse(String(data)) as { type: string };
				if (event.type === 'message-updated') {
					ws.close();
					resolve(event);
				}
			});
			ws.once('open', () => app!.ingestHooks.onMessageUpdated(stored));
			ws.once('error', reject);
		});

		const event = await received;
		expect(event).toMatchObject({
			type: 'message-updated',
			message: {
				id: 'target',
				sender: { name: 'Alice' },
				reactions: [{ emoji: '🔥', count: 1, actors: [{ name: 'Alice' }] }]
			}
		});
		expect(JSON.stringify(event)).not.toContain('must-not-leak');
		expect(JSON.stringify(event)).not.toContain('"raw"');
	});
});

describe('drafts', () => {
	it('refines a preview, emits one sanitized update, and creates no side effects', async () => {
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Seven works.' }));
		const events = new EventBus();
		const received: unknown[] = [];
		events.subscribe((event) => received.push(event));
		const retainEditDelta = vi.fn(async () => undefined);
		const memory = {
			retainVoiceObservation: async () => undefined,
			retainEditDelta,
			recallStyleFor: async () => null,
			reflect: async () => undefined
		} satisfies Memory;
		await startTestApp(events, memory, { draft });
		seedNeedsReplyFixture(db!);
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'Yes, seven works for me.',
			status: 'ready',
			generated_at: 201,
			provider: 'fake',
			basis_msg_id: 'a1'
		});

		const response = await api('/api/chats/alice%40s.whatsapp.net/draft/refine', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ intent: 'shorter', text: 'Edited preview' })
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			text: 'Seven works.',
			basis_msg_id: 'a1',
			status: 'ready'
		});
		expect(draft).toHaveBeenCalledOnce();
		expect(received).toEqual([
			expect.objectContaining({
				type: 'draft-updated',
				draft: expect.objectContaining({ text: 'Seven works.', basis_msg_id: 'a1' })
			})
		]);
		expect(JSON.stringify(received)).not.toContain('Current draft preview');
		expect((db!.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count)
			.toBe(0);
		expect(listDraftFeedback(db!, 'alice@s.whatsapp.net')).toEqual([]);
		expect(retainEditDelta).not.toHaveBeenCalled();
	});

	it('rejects an invalid refinement intent before invoking the provider', async () => {
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Unused' }));
		await startTestApp(new EventBus(), undefined, { draft });
		seedNeedsReplyFixture(db!);
		upsertDraft(db!, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'Current draft',
			status: 'ready',
			generated_at: 201,
			basis_msg_id: 'a1'
		});

		const response = await api('/api/chats/alice%40s.whatsapp.net/draft/refine', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ intent: 'friendlier' })
		});

		expect(response.status).toBe(400);
		expect(draft).not.toHaveBeenCalled();
	});

	it('allows only one of two concurrent approvals to enqueue', async () => {
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 10
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
			text: 'one approval only',
			status: 'ready',
			generated_at: 11,
			basis_msg_id: 'basis'
		});

		const responses = await Promise.all([
			api('/api/chats/alice%40s.whatsapp.net/draft/approve', { method: 'POST' }),
			api('/api/chats/alice%40s.whatsapp.net/draft/approve', { method: 'POST' })
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
		expect((db!.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count)
			.toBe(1);
	});

	it('rolls back the outbox row when approval feedback persistence fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await startTestApp();
		upsertChat(db!, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 10
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
			status: 'ready',
			generated_at: 11,
			basis_msg_id: 'basis'
		});
		db!.exec(
			`CREATE TRIGGER fail_feedback BEFORE INSERT ON draft_feedback
			 BEGIN SELECT RAISE(ABORT, 'feedback unavailable'); END`
		);

		const response = await api('/api/chats/alice%40s.whatsapp.net/draft/approve', {
			method: 'POST'
		});
		expect(response.status).toBe(500);
		expect((db!.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count)
			.toBe(0);
		expect((db!.prepare('SELECT status FROM drafts WHERE chat_jid = ?').get('alice@s.whatsapp.net')))
			.toEqual({ status: 'ready' });
	});

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

		const confirmed = await api('/api/chats/alice%40s.whatsapp.net/draft/approve', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ confirmed_latest_inbound_id: 'newer-inbound' })
		});
		expect(confirmed.status).toBe(202);
		expect(await confirmed.json()).toMatchObject({
			outbox: { text: 'old draft', source: 'draft', status: 'pending' },
			draft: { status: 'approved' }
		});
	});

	it('approve enqueues outbox; skip demotes chat from needs-reply', async () => {
		const retainEditDelta = vi.fn(async () => undefined);
		const memory = {
			retainVoiceObservation: async () => undefined,
			retainEditDelta,
			recallStyleFor: async () => null,
			reflect: async () => undefined
		} satisfies Memory;
		await startTestApp(new EventBus(), memory);
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
			outbox: { text: string; status: string; draft_text: string };
			draft: { status: string };
		};
		expect(approved.outbox.text).toBe('edited reply');
		expect(approved.outbox.status).toBe('pending');
		expect(approved.outbox.draft_text).toBe('draft reply');
		expect(approved.draft.status).toBe('approved');
		expect(listDraftFeedback(db!, 'alice@s.whatsapp.net')).toMatchObject([
		{
			kind: 'approved',
			draft_text: 'draft reply',
			final_text: 'edited reply',
			basis_msg_id: 'basis'
		}
	]);

		// Skip remains meaningful after approval: it cancels the queued row.
		const skip = await api('/api/chats/alice%40s.whatsapp.net/draft/skip', {
			method: 'POST'
		});
		expect(skip.status).toBe(200);

		const filtered = await api('/api/chats?filter=needs-reply');
		const body = (await filtered.json()) as { items: unknown[] };
		expect(body.items).toEqual([]);
		expect((await api('/api/outbox').then((res) => res.json()))).toMatchObject({
			items: [{ status: 'cancelled', source: 'draft' }]
		});
		expect(listDraftFeedback(db!, 'alice@s.whatsapp.net').at(-1)).toMatchObject({
			kind: 'skipped',
			draft_text: 'draft reply',
			final_text: null,
			basis_msg_id: 'basis'
		});
		expect(retainEditDelta).toHaveBeenCalledTimes(2);
		expect(retainEditDelta).toHaveBeenNthCalledWith(1, {
			chatJid: 'alice@s.whatsapp.net',
			draft: 'draft reply',
			final: 'edited reply',
			skipped: false
		});
		expect(retainEditDelta).toHaveBeenNthCalledWith(2, {
			chatJid: 'alice@s.whatsapp.net',
			draft: 'draft reply',
			final: null,
			skipped: true
		});
	});
});

describe('read cursor (U4) — viewing produces no outbound WhatsApp traffic', () => {
	it('POST /chats/:jid/read advances the local cursor without calling the transport', async () => {
		const transport: WhatsAppSendTransport = {
			setPresence: vi.fn(async () => undefined),
			sendText: vi.fn(async () => undefined),
			sendReaction: vi.fn(async () => undefined),
			markRead: vi.fn(async () => undefined)
		};
		await startTestApp(new EventBus(), undefined, undefined, { outboxTransport: transport });
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 300, unread: 2 });
		upsertMessage(db!, {
			id: 'a1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 100,
			text: 'hi'
		});
		upsertMessage(db!, {
			id: 'a2',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 300,
			text: 'ping'
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/read', {
			method: 'POST',
			origin: originForApp(),
			headers: { 'Content-Type': 'application/json' },
			body: '{}'
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { last_read_msg_id: string | null; unread: number };
		expect(body.last_read_msg_id).toBe('a2');
		expect(body.unread).toBe(0);

		// HARD BOUNDARY: viewing/markRead must NOT emit a WhatsApp read receipt.
		expect(transport.markRead).not.toHaveBeenCalled();
		expect(transport.sendText).not.toHaveBeenCalled();
		expect(transport.setPresence).not.toHaveBeenCalled();
		expect(transport.sendReaction).not.toHaveBeenCalled();
	});

	it('GET /chats/:jid/messages is read-only and never touches the transport', async () => {
		const transport: WhatsAppSendTransport = {
			setPresence: vi.fn(async () => undefined),
			sendText: vi.fn(async () => undefined),
			sendReaction: vi.fn(async () => undefined),
			markRead: vi.fn(async () => undefined)
		};
		await startTestApp(new EventBus(), undefined, undefined, { outboxTransport: transport });
		upsertChat(db!, { jid: 'alice@s.whatsapp.net', kind: '1:1', last_msg_at: 100, unread: 3 });
		upsertMessage(db!, {
			id: 'm1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 100,
			text: 'hi'
		});

		const res = await api('/api/chats/alice%40s.whatsapp.net/messages?limit=10');
		expect(res.status).toBe(200);

		// No outbound traffic from a plain view.
		expect(transport.markRead).not.toHaveBeenCalled();
		expect(transport.sendText).not.toHaveBeenCalled();
		expect(transport.setPresence).not.toHaveBeenCalled();
		expect(transport.sendReaction).not.toHaveBeenCalled();
	});
});
