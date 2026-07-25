import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppSendTransport } from '../channels/whatsapp/send.js';
import { upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import {
	cancelOutbox,
	enqueueDraftOutbox,
	enqueueManualOutbox,
	getOutbox,
	markOutboxSending
} from '../store/outbox.js';
import { OutboxPacer } from './pacer.js';

const NOW = 2_000_000_000_000;
let dataDir: string | undefined;
let db: AppDatabase | undefined;
const pacers: OutboxPacer[] = [];

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-pacer-'));
	db = openDatabase({ dataDir });
	for (const jid of ['alice@s.whatsapp.net', 'bob@s.whatsapp.net']) {
		upsertChat(db, { jid, kind: '1:1', last_msg_at: NOW });
	}
	return db;
}

function transport(overrides: Partial<WhatsAppSendTransport> = {}): WhatsAppSendTransport {
	return {
		setPresence: vi.fn(async () => undefined),
		sendText: vi.fn(async () => undefined),
		markRead: vi.fn(async () => undefined),
		...overrides
	};
}

function pacer(
	database: AppDatabase,
	sendTransport: WhatsAppSendTransport,
	overrides: Partial<ConstructorParameters<typeof OutboxPacer>[0]> = {}
): OutboxPacer {
	const instance = new OutboxPacer({
		minDraftDelayMs: 1_000,
		maxDraftDelayMs: 1_000,
		manualPresenceMs: 0,
		retryDelayMs: 500,
		now: Date.now,
		random: () => 0,
		sleep: async () => undefined,
		...overrides,
		db: database,
		transport: sendTransport
	});
	pacers.push(instance);
	return instance;
}

afterEach(() => {
	for (const instance of pacers.splice(0)) instance.stop();
	vi.restoreAllMocks();
	vi.useRealTimers();
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('OutboxPacer', () => {
	it('globally spaces rapid draft approvals and sends them single-flight in order', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const ids = Array.from({ length: 10 }, (_, index) =>
			enqueueDraftOutbox(database, {
				chatJid: index % 2 ? 'bob@s.whatsapp.net' : 'alice@s.whatsapp.net',
				text: `reply ${index}`,
				draftText: `draft ${index}`,
				basisMsgId: `basis-${index}`,
				now: NOW,
				jitterMs: 1_000
			})
		);
		const scheduled = ids.map((id) => getOutbox(database, id)!.send_after);
		expect(scheduled).toEqual(ids.map((_, index) => NOW + index * 1_000));

		let active = 0;
		let maxActive = 0;
		const sendText = vi.fn(async (_jid: string, _text: string, _messageId: string) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active -= 1;
		});
		const sendTransport = transport({ sendText });
		const instance = pacer(database, sendTransport);
		instance.start();
		await vi.runAllTimersAsync();

		expect(ids.map((id) => getOutbox(database, id)?.status)).toEqual(Array(10).fill('sent'));
		expect(maxActive).toBe(1);
		expect(sendText.mock.calls.map((call) => call[1])).toEqual(
			ids.map((_, index) => `reply ${index}`)
		);
	});

	it('cancels queued rows and never sends them', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const id = enqueueDraftOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'cancel me',
			draftText: 'cancel me',
			basisMsgId: 'basis',
			now: NOW + 10_000,
			jitterMs: 1_000
		});
		expect(cancelOutbox(database, id)).toBe(true);
		const sendTransport = transport();
		pacer(database, sendTransport).start();
		await vi.runAllTimersAsync();
		expect(sendTransport.sendText).not.toHaveBeenCalled();
		expect(getOutbox(database, id)?.status).toBe('cancelled');
	});

	it('holds approved drafts before history sync while allowing manual sends', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const draftId = enqueueDraftOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'wait for sync',
			draftText: 'wait for sync',
			basisMsgId: 'basis',
			now: NOW,
			jitterMs: 1_000
		});
		const manualId = enqueueManualOutbox(database, {
			chatJid: 'bob@s.whatsapp.net',
			text: 'owner typed this',
			now: NOW
		});
		const sendTransport = transport();
		const instance = pacer(database, sendTransport);
		instance.setDraftsPaused(true);
		instance.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(getOutbox(database, manualId)?.status).toBe('sent');
		expect(getOutbox(database, draftId)?.status).toBe('pending');
		expect(sendTransport.sendText).toHaveBeenCalledTimes(1);

		instance.setDraftsPaused(false);
		await vi.runAllTimersAsync();
		expect(getOutbox(database, draftId)?.status).toBe('sent');
		expect(sendTransport.sendText).toHaveBeenCalledTimes(2);
	});

	it('cancels a claimed draft when a newer inbound exists before send', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		upsertMessage(database, {
			id: 'basis',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: NOW,
			text: 'first question'
		});
		const id = enqueueDraftOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'stale answer',
			draftText: 'stale answer',
			basisMsgId: 'basis',
			now: NOW,
			jitterMs: 1_000
		});
		upsertMessage(database, {
			id: 'newer',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: NOW + 1,
			text: 'follow-up'
		});
		const sendTransport = transport();
		pacer(database, sendTransport).start();
		await vi.runAllTimersAsync();

		expect(sendTransport.sendText).not.toHaveBeenCalled();
		expect(getOutbox(database, id)?.status).toBe('cancelled');
	});

	it('recovers three queued rows with stable message ids and preserved spacing', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const ids = Array.from({ length: 3 }, (_, index) =>
			enqueueDraftOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: `restart-safe ${index}`,
				draftText: `restart-safe ${index}`,
				basisMsgId: `basis-${index}`,
				now: NOW,
				jitterMs: 1_000
			})
		);
		const messageIds = ids.map((id) => getOutbox(database, id)!.message_id);
		expect(markOutboxSending(database, ids[0]!)).toBe(true);

		const sendTransport = transport();
		pacer(database, sendTransport).start();
		await vi.runAllTimersAsync();

		expect(sendTransport.sendText).toHaveBeenCalledTimes(3);
		expect((sendTransport.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]))
			.toEqual(messageIds);
		expect(ids.map((id) => getOutbox(database, id)?.sent_at)).toEqual([
			NOW,
			NOW + 1_000,
			NOW + 2_000
		]);
	});

	it('keeps a disconnected send queued, then retries without releasing later rows', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const first = enqueueManualOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'first',
			now: NOW
		});
		const second = enqueueManualOutbox(database, {
			chatJid: 'bob@s.whatsapp.net',
			text: 'second',
			now: NOW
		});
		let connected = false;
		const sendText = vi.fn(async () => {
			if (!connected) throw new Error('disconnected');
		});
		const sendTransport = transport({ sendText });
		pacer(database, sendTransport).start();
		await vi.advanceTimersByTimeAsync(0);

		expect(getOutbox(database, first)?.status).toBe('pending');
		expect(getOutbox(database, second)?.status).toBe('pending');
		connected = true;
		await vi.advanceTimersByTimeAsync(500);
		await vi.runAllTimersAsync();
		expect(getOutbox(database, first)?.status).toBe('sent');
		expect(getOutbox(database, second)?.status).toBe('sent');
	});

	it('does not retry when a best-effort post-send presence update fails', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const id = enqueueManualOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'sent once',
			now: NOW
		});
		let calls = 0;
		const setPresence = vi.fn(async () => {
			calls += 1;
			if (calls === 2) throw new Error('socket closed after send');
		});
		const sendTransport = transport({ setPresence });
		pacer(database, sendTransport).start();
		await vi.runAllTimersAsync();

		expect(sendTransport.sendText).toHaveBeenCalledOnce();
		expect(getOutbox(database, id)?.status).toBe('sent');
	});

	it('marks the matching approved draft sent and retains the edit delta on the outbox row', async () => {
		vi.useFakeTimers({ now: NOW });
		vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const database = setup();
		upsertDraft(database, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'final wording',
			status: 'approved',
			generated_at: NOW,
			basis_msg_id: 'basis'
		});
		const id = enqueueDraftOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'final wording',
			draftText: 'original wording',
			basisMsgId: 'basis',
			now: NOW,
			jitterMs: 1_000
		});
		pacer(database, transport(), { dryRun: true }).start();
		await vi.runAllTimersAsync();

		expect(getOutbox(database, id)).toMatchObject({
			status: 'sent',
			draft_text: 'original wording',
			text: 'final wording',
			basis_msg_id: 'basis'
		});
		expect(database.prepare('SELECT status FROM drafts WHERE chat_jid = ?').get('alice@s.whatsapp.net'))
			.toEqual({ status: 'sent' });
	});
});
