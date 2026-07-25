import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelEvent, ChannelEventListener } from './channels/channel.js';
import type { DraftProvider } from './providers/provider.js';
import { upsertChat } from './store/chats.js';
import { openDatabase, type AppDatabase } from './store/db.js';
import { getDraft } from './store/drafts.js';
import { getMessage, upsertMessage } from './store/messages.js';
import { enqueueDraftOutbox, getOutbox } from './store/outbox.js';
import { createApp, type App } from './index.js';
import type { Memory } from './agent/memory/memory.js';

class FakeChannel implements Channel {
	readonly listeners = new Set<ChannelEventListener>();
	start = vi.fn(async () => undefined);
	stop = vi.fn(async () => undefined);

	onEvent(listener: ChannelEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: ChannelEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

let dataDir: string | undefined;
let db: AppDatabase | undefined;
let app: App | undefined;

afterEach(async () => {
	if (app) {
		const current = app;
		app = undefined;
		db = undefined;
		await current.close();
	} else {
		db?.close();
		db = undefined;
	}
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('live draft scheduler wiring', () => {
	it('starts after history sync and receives only post-commit live inbound messages', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-runtime-'));
		db = openDatabase({ dataDir });
		upsertChat(db, {
			jid: 'alice@s.whatsapp.net',
			kind: '1:1',
			last_msg_at: 10
		});
		upsertMessage(db, {
			id: 'owner-style',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: true,
			ts: 5,
			text: 'Short and direct.'
		});
		upsertMessage(db, {
			id: 'history-basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 10,
			text: 'history question'
		});

		let draftCount = 0;
		let voiceRetained = false;
		const memory: Memory = {
			retainVoiceObservation: vi.fn(async () => { voiceRetained = true; }),
			retainEditDelta: async () => undefined,
			recallStyleFor: async () => 'Uses short, direct replies.',
			reflect: async () => undefined
		};
		const draft: DraftProvider['draft'] = vi.fn(async (input) => {
			expect(voiceRetained).toBe(true);
			expect(input.system).toContain('Uses short, direct replies.');
			return {
				kind: 'draft' as const,
				text: `reply ${++draftCount}`
			};
		});
		const channel = new FakeChannel();
		app = createApp({
			db,
			channel,
			draftProvider: { draft },
			providerName: 'fake',
			memory,
			draftDebounceMs: 0,
			port: 0,
			staticDir: null
		});
		await app.start();

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(draft).not.toHaveBeenCalled();

		channel.emit({
			type: 'sync-progress',
			progress: 100,
			isLatest: true,
			chats: 1,
			messages: 1
		});
		await vi.waitFor(() => expect(draft).toHaveBeenCalledTimes(1));
		expect(getDraft(db!, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('history-basis');
		const queued = enqueueDraftOutbox(db!, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'approved old answer',
			draftText: 'approved old answer',
			basisMsgId: 'history-basis',
			now: 11,
			jitterMs: 30_000
		});

		upsertMessage(db!, {
			id: 'live-basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 20,
			text: 'live follow-up'
		});
		const committed = getMessage(db!, 'live-basis')!;
		channel.emit({ type: 'message-committed', message: committed });

		await vi.waitFor(() => expect(draft).toHaveBeenCalledTimes(2));
		expect(getOutbox(db!, queued)?.status).toBe('cancelled');
		expect(getDraft(db!, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('live-basis');

		// A reconnect can recover inbound history without a live upsert event. Each
		// terminal sync batch rescans so that message is not stranded.
		upsertMessage(db!, {
			id: 'reconnect-history',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: 30,
			text: 'arrived while offline'
		});
		channel.emit({
			type: 'sync-progress',
			progress: 100,
			isLatest: true,
			chats: 1,
			messages: 1
		});
		await vi.waitFor(() => expect(draft).toHaveBeenCalledTimes(3));
		expect(getDraft(db!, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('reconnect-history');
	});
});
