import { Boom } from '@hapi/boom';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
	classifyMediaFailure,
	downloadAndCacheMedia,
	MediaDownloadFailure
} from '../channels/whatsapp/media.js';
import { createApp, type App } from '../index.js';
import { upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getMessage, setMediaState, upsertMessage } from '../store/messages.js';
import { EventBus } from './events.js';
import { describeMedia } from './message-view.js';

let dataDir: string;
let db: AppDatabase;
let app: App | undefined;

const IMAGE_ENVELOPE = JSON.stringify({
	key: { id: 'img-1' },
	message: {
		imageMessage: {
			mimetype: 'image/jpeg',
			fileLength: { low: 51_200, high: 0, unsigned: true }
		}
	}
});

function seedMedia(): void {
	upsertChat(db, { jid: 'alice@s.whatsapp.net', name: 'Alice', kind: '1:1', last_msg_at: 10 });
	upsertMessage(db, {
		id: 'img-1',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: false,
		ts: 10,
		type: 'image',
		raw: IMAGE_ENVELOPE
	});
	upsertMessage(db, {
		id: 'txt-1',
		chat_jid: 'alice@s.whatsapp.net',
		from_me: false,
		ts: 11,
		type: 'text',
		text: 'hello'
	});
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-media-'));
	db = openDatabase({ dataDir });
	seedMedia();
});

afterEach(async () => {
	if (app) await app.close();
	else db.close();
	app = undefined;
	rmSync(dataDir, { recursive: true, force: true });
});

async function startApp(
	downloadMedia?: (messageId: string) => Promise<unknown>
): Promise<App> {
	app = createApp({
		db,
		events: new EventBus(),
		port: 0,
		host: '127.0.0.1',
		staticDir: null,
		dataDir,
		downloadMedia
	});
	await app.start();
	return app;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Origin', `http://127.0.0.1:${app!.port}`);
	return fetch(`${app!.url}${path}`, { ...init, headers });
}

describe('media state machine (D2)', () => {
	it('starts every media message as placeholder with size + mime described', () => {
		const message = getMessage(db, 'img-1')!;
		expect(message.media_state).toBe('placeholder');
		expect(describeMedia(message)).toMatchObject({
			state: 'placeholder',
			error: null,
			size: 51_200,
			mime: 'image/jpeg',
			cached: false
		});
	});

	it('classifies reupload-refused / expired media as terminal unavailable', () => {
		// Baileys maps NOT_FOUND onto statusCode 404 in MEDIA_RETRY_STATUS_MAP.
		expect(classifyMediaFailure(new Boom('gone', { statusCode: 404 }))).toBe('unavailable');
		expect(classifyMediaFailure(new Boom('gone', { statusCode: 410 }))).toBe('unavailable');
	});

	it('classifies decrypt / general / network errors as transient', () => {
		expect(classifyMediaFailure(new Boom('decrypt', { statusCode: 412 }))).toBe('transient');
		expect(classifyMediaFailure(new Boom('general', { statusCode: 418 }))).toBe('transient');
		expect(classifyMediaFailure(new Error('ECONNRESET'))).toBe('transient');
	});

	it('persists downloading → ready and never bulk-prefetches', async () => {
		const states: string[] = [];
		const download = vi.fn(async () => {
			states.push(getMessage(db, 'img-1')!.media_state);
			return Buffer.from('jpeg-bytes');
		});

		// Nothing fetched until asked.
		expect(getMessage(db, 'img-1')!.media_state).toBe('placeholder');

		const result = await downloadAndCacheMedia(db, 'img-1', { dataDir, download });

		expect(states).toEqual(['downloading']);
		const after = getMessage(db, 'img-1')!;
		expect(after.media_state).toBe('ready');
		expect(after.media_ref).toBe(result.mediaRef);
		expect(after.media_error).toBeNull();
	});

	it('persists failed + reason, and survives a history re-ingest', async () => {
		const download = vi.fn(async () => {
			throw new Boom('no longer available', { statusCode: 404 });
		});

		await expect(downloadAndCacheMedia(db, 'img-1', { dataDir, download })).rejects.toBeInstanceOf(
			MediaDownloadFailure
		);
		expect(getMessage(db, 'img-1')).toMatchObject({
			media_state: 'failed',
			media_error: 'unavailable'
		});

		// A re-ingested history batch must not reset persisted media state.
		upsertMessage(db, {
			id: 'img-1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 10,
			type: 'image',
			raw: IMAGE_ENVELOPE
		});
		expect(getMessage(db, 'img-1')).toMatchObject({
			media_state: 'failed',
			media_error: 'unavailable'
		});
	});

	it('keeps a cached media_ref across re-ingest', async () => {
		await downloadAndCacheMedia(db, 'img-1', {
			dataDir,
			download: async () => Buffer.from('jpeg-bytes')
		});
		upsertMessage(db, {
			id: 'img-1',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 10,
			type: 'image',
			raw: IMAGE_ENVELOPE
		});
		const after = getMessage(db, 'img-1')!;
		expect(after.media_ref).not.toBeNull();
		expect(after.media_state).toBe('ready');
	});
});

describe('media endpoints (D2)', () => {
	it('fetches on demand and then serves the cached bytes', async () => {
		await startApp(async (id) => {
			mkdirSync(join(dataDir, 'media'), { recursive: true });
			writeFileSync(join(dataDir, 'media', `${id}.jpg`), 'jpeg-bytes');
			const { setMediaRef } = await import('../store/messages.js');
			setMediaRef(db, id, join('media', `${id}.jpg`));
		});

		// Not downloaded yet ⇒ no bytes to serve.
		expect((await api('/api/messages/img-1/media')).status).toBe(409);

		const fetched = await api('/api/messages/img-1/media', { method: 'POST' });
		expect(fetched.status).toBe(200);
		expect((await fetched.json()).media).toMatchObject({ state: 'ready', cached: true });

		const served = await api('/api/messages/img-1/media');
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('image/jpeg');
		expect(await served.text()).toBe('jpeg-bytes');
	});

	it('refuses to retry terminally unavailable media', async () => {
		setMediaState(db, 'img-1', 'failed', 'unavailable');
		const download = vi.fn();
		await startApp(download as never);

		const res = await api('/api/messages/img-1/media', { method: 'POST' });
		expect(res.status).toBe(410);
		expect(download).not.toHaveBeenCalled();
	});

	it('reports a transient failure as retriable', async () => {
		await startApp(async (id) => {
			setMediaState(db, id, 'failed', 'transient');
			throw new Error('network');
		});
		const res = await api('/api/messages/img-1/media', { method: 'POST' });
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ reason: 'transient' });
	});

	it('rejects media requests for non-media messages', async () => {
		await startApp();
		expect((await api('/api/messages/txt-1/media', { method: 'POST' })).status).toBe(400);
		expect((await api('/api/messages/nope/media', { method: 'POST' })).status).toBe(404);
	});

	it('strips the raw envelope from the message list and exposes media state', async () => {
		await startApp();
		const res = await api('/api/chats/alice%40s.whatsapp.net/messages');
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		const image = body.items.find((m) => m.id === 'img-1')!;
		expect(image).not.toHaveProperty('raw');
		expect(image.media).toMatchObject({ state: 'placeholder', size: 51_200 });
	});
});

describe('session endpoint (D5)', () => {
	it('serves the derived view and pushes a snapshot on WS connect', async () => {
		await startApp();
		const res = await api('/api/session');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: 'initializing',
			qr: null,
			qrExpiresAt: null,
			sync: { chatsSynced: 0, messagesSynced: 0, complete: false }
		});

		const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/ws`, {
			headers: { Origin: `http://127.0.0.1:${app!.port}` }
		});
		const received: string[] = [];
		await new Promise<void>((resolve, reject) => {
			ws.on('message', (data) => {
				const event = JSON.parse(String(data)) as { type: string };
				received.push(event.type);
				if (event.type === 'session') resolve();
			});
			ws.on('error', reject);
		});
		ws.close();
		expect(received).toContain('session');
	});
});
