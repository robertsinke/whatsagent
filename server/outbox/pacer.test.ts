import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferJSON, type WAMessage } from 'baileys';
import { WhatsAppDisconnectedError, type WhatsAppSendTransport } from '../channels/whatsapp/send.js';
import { Boom } from '@hapi/boom';
import { upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { upsertDraft } from '../store/drafts.js';
import { upsertMessage } from '../store/messages.js';
import {
	cancelOutbox,
	enqueueDraftOutbox,
	enqueueManualOutbox,
	enqueueReactionOutbox,
	getOutbox,
	markOutboxSending,
	retryFailedOutbox
} from '../store/outbox.js';
import { setSetting } from '../store/settings.js';
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
		sendReaction: vi.fn(async () => undefined),
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
		// These tests assert what the pacer transmits, so they need live sends —
		// and the constructor fails safe to dry-run. Opting in explicitly here
		// keeps that default honest rather than weakening it for production.
		dryRun: false,
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
	it('reads its jitter window from settings', () => {
		const database = setup();
		setSetting(database, 'pacing_min_seconds', '0.25');
		setSetting(database, 'pacing_max_seconds', '0.75');
		const instance = pacer(database, transport(), {
			minDraftDelayMs: undefined,
			maxDraftDelayMs: undefined,
			random: () => 0.5
		});

		expect(instance.jitterMs()).toBe(500);
	});

	it('globally spaces rapid draft approvals and sends them single-flight in order', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const sendTransport = transport();
		const instance = pacer(database, sendTransport, {
			minDraftDelayMs: undefined,
			maxDraftDelayMs: undefined
		});
		const ids = Array.from({ length: 10 }, (_, index) =>
			enqueueDraftOutbox(database, {
				chatJid: index % 2 ? 'bob@s.whatsapp.net' : 'alice@s.whatsapp.net',
				text: `reply ${index}`,
				draftText: `draft ${index}`,
				basisMsgId: `basis-${index}`,
				now: NOW,
				jitterMs: instance.jitterMs()
			})
		);
		const scheduled = ids.map((id) => getOutbox(database, id)!.send_after);
		expect(scheduled).toEqual(Array(10).fill(NOW));

		let active = 0;
		let maxActive = 0;
		const sendText = vi.fn(async (_jid: string, _text: string, _messageId: string) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active -= 1;
		});
		(sendTransport.sendText as ReturnType<typeof vi.fn>).mockImplementation(sendText);
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

	it('recovers three near-zero-spaced rows once each after restart', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		const ids = Array.from({ length: 3 }, (_, index) =>
			enqueueDraftOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: `restart-safe ${index}`,
				draftText: `restart-safe ${index}`,
				basisMsgId: `basis-${index}`,
				now: NOW,
				jitterMs: 0
			})
		);
		const messageIds = ids.map((id) => getOutbox(database, id)!.message_id);
		expect(markOutboxSending(database, ids[0]!)).toBe(true);
		database.close();
		db = openDatabase({ dataDir: dataDir! });
		const restartedDatabase = db;

		const sendTransport = transport();
		pacer(restartedDatabase, sendTransport, {
			minDraftDelayMs: undefined,
			maxDraftDelayMs: undefined
		}).start();
		await vi.runAllTimersAsync();

		expect(sendTransport.sendText).toHaveBeenCalledTimes(3);
		expect((sendTransport.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]))
			.toEqual(messageIds);
		expect(ids.map((id) => getOutbox(restartedDatabase, id)?.sent_at)).toEqual(
			Array(3).fill(NOW)
		);
	});

	it('recovers a claimed quoted reply and sends it once with its persisted target', async () => {
		vi.useFakeTimers({ now: NOW });
		const beforeRestart = setup();
		const quoted = {
			key: {
				id: 'quoted-target',
				remoteJid: 'alice@s.whatsapp.net',
				fromMe: false
			},
			message: { conversation: 'Are we still meeting?' },
			messageTimestamp: Math.floor(NOW / 1_000)
		} satisfies WAMessage;
		upsertMessage(beforeRestart, {
			id: 'quoted-target',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: NOW,
			text: 'Are we still meeting?',
			raw: JSON.stringify(quoted, BufferJSON.replacer)
		});
		const id = enqueueManualOutbox(beforeRestart, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'Yes, see you there.',
			replyToMsgId: 'quoted-target',
			now: NOW
		});
		const messageId = getOutbox(beforeRestart, id)!.message_id!;
		expect(markOutboxSending(beforeRestart, id)).toBe(true);
		beforeRestart.close();
		db = openDatabase({ dataDir: dataDir! });
		const database = db;
		expect(getOutbox(database, id)?.reply_to_msg_id).toBe('quoted-target');

		const sendTransport = transport();
		pacer(database, sendTransport).start();
		await vi.runAllTimersAsync();

		expect(sendTransport.sendText).toHaveBeenCalledOnce();
		expect(sendTransport.sendText).toHaveBeenCalledWith(
			'alice@s.whatsapp.net',
			'Yes, see you there.',
			messageId,
			quoted
		);
		expect(getOutbox(database, id)?.status).toBe('sent');
	});

	it('cancels a quoted reply with corrupt target data and safely releases the next row', async () => {
		vi.useFakeTimers({ now: NOW });
		const database = setup();
		upsertMessage(database, {
			id: 'broken-target',
			chat_jid: 'alice@s.whatsapp.net',
			from_me: false,
			ts: NOW,
			text: 'Cannot reconstruct me',
			raw: '{not-json'
		});
		const brokenId = enqueueManualOutbox(database, {
			chatJid: 'alice@s.whatsapp.net',
			text: 'Must remain quoted',
			replyToMsgId: 'broken-target',
			now: NOW
		});
		const nextId = enqueueManualOutbox(database, {
			chatJid: 'bob@s.whatsapp.net',
			text: 'Independent send',
			now: NOW
		});
		const onError = vi.fn();
		const sendTransport = transport();
		pacer(database, sendTransport, { onError }).start();
		await vi.runAllTimersAsync();

		expect(getOutbox(database, brokenId)?.status).toBe('cancelled');
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'QuotedReplyTargetError' }),
			expect.objectContaining({ id: brokenId, reply_to_msg_id: 'broken-target' })
		);
		expect(sendTransport.sendText).toHaveBeenCalledOnce();
		expect(sendTransport.sendText).toHaveBeenCalledWith(
			'bob@s.whatsapp.net',
			'Independent send',
			getOutbox(database, nextId)!.message_id,
			undefined
		);
		expect(getOutbox(database, nextId)?.status).toBe('sent');
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

	describe('reaction payload', () => {
		function seedTargetMessage(
			database: AppDatabase,
			jid: string = 'alice@s.whatsapp.net',
			id: string = 'react-target'
		): WAMessage {
			const target = {
				key: { id, remoteJid: jid, fromMe: false },
				message: { conversation: 'React to me' },
				messageTimestamp: Math.floor(NOW / 1_000)
			} satisfies WAMessage;
			upsertMessage(database, {
				id,
				chat_jid: jid,
				from_me: false,
				ts: NOW,
				text: 'React to me',
				raw: JSON.stringify(target, BufferJSON.replacer)
			});
			return target;
		}

		it('sends exactly one react payload for a reaction row', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const target = seedTargetMessage(database);
			const id = enqueueReactionOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'react-target',
				emoji: '👍',
				now: NOW
			});
			const sendTransport = transport();
			pacer(database, sendTransport).start();
			await vi.runAllTimersAsync();

			expect(sendTransport.sendReaction).toHaveBeenCalledOnce();
			expect(sendTransport.sendReaction).toHaveBeenCalledWith(
				'alice@s.whatsapp.net',
				target.key,
				'👍'
			);
			expect(sendTransport.sendText).not.toHaveBeenCalled();
			expect(getOutbox(database, id)?.status).toBe('sent');
		});

		it('removal sends the empty-emoji form', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const target = seedTargetMessage(database);
			const id = enqueueReactionOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'react-target',
				emoji: '',
				now: NOW
			});
			const sendTransport = transport();
			pacer(database, sendTransport).start();
			await vi.runAllTimersAsync();

			expect(sendTransport.sendReaction).toHaveBeenCalledWith(
				'alice@s.whatsapp.net',
				target.key,
				''
			);
			expect(getOutbox(database, id)?.status).toBe('sent');
		});

		it('dry-run suppresses the react call entirely', async () => {
			vi.useFakeTimers({ now: NOW });
			vi.spyOn(console, 'info').mockImplementation(() => undefined);
			const database = setup();
			seedTargetMessage(database);
			const id = enqueueReactionOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'react-target',
				emoji: '👍',
				now: NOW
			});
			const sendTransport = transport();
			pacer(database, sendTransport, { dryRun: true }).start();
			await vi.runAllTimersAsync();

			expect(sendTransport.sendReaction).not.toHaveBeenCalled();
			expect(getOutbox(database, id)?.status).toBe('sent');
		});

		it('a reaction never bypasses the pacer', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			seedTargetMessage(database);
			// No pacer is started — the row stays pending.
			enqueueReactionOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'react-target',
				emoji: '👍',
				now: NOW
			});
			// Advance timers with no pacer running.
			await vi.advanceTimersByTimeAsync(10_000);
			const rows = database
				.prepare("SELECT status FROM outbox WHERE payload_kind = 'reaction'")
				.all() as { status: string }[];
			expect(rows).toEqual([{ status: 'pending' }]);
		});

		it('restart mid-queue does not double-apply a reaction', async () => {
			vi.useFakeTimers({ now: NOW });
			const beforeRestart = setup();
			seedTargetMessage(beforeRestart);
			const id = enqueueReactionOutbox(beforeRestart, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'react-target',
				emoji: '👍',
				now: NOW
			});
			// Crash after claim, before send.
			expect(markOutboxSending(beforeRestart, id)).toBe(true);
			beforeRestart.close();
			db = openDatabase({ dataDir: dataDir! });
			const database = db;

			const sendTransport = transport();
			pacer(database, sendTransport, {
				minDraftDelayMs: undefined,
				maxDraftDelayMs: undefined
			}).start();
			await vi.runAllTimersAsync();

			// Recovered from 'sending' → 'pending' → sent exactly once.
			expect(sendTransport.sendReaction).toHaveBeenCalledOnce();
			expect(getOutbox(database, id)?.status).toBe('sent');
		});

		it('cancels a reaction with a corrupt target and releases the next row', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			upsertMessage(database, {
				id: 'broken-target',
				chat_jid: 'alice@s.whatsapp.net',
				from_me: false,
				ts: NOW,
				text: 'Cannot reconstruct',
				raw: '{not-json'
			});
			seedTargetMessage(database, 'bob@s.whatsapp.net', 'good-target');
			const brokenId = enqueueReactionOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'broken-target',
				emoji: '👍',
				now: NOW
			});
			const nextId = enqueueReactionOutbox(database, {
				chatJid: 'bob@s.whatsapp.net',
				targetMsgId: 'good-target',
				emoji: '❤️',
				now: NOW
			});
			const onError = vi.fn();
			const sendTransport = transport();
			pacer(database, sendTransport, { onError }).start();
			await vi.runAllTimersAsync();

			expect(getOutbox(database, brokenId)?.status).toBe('cancelled');
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'QuotedReplyTargetError' }),
				expect.objectContaining({ id: brokenId })
			);
			expect(sendTransport.sendReaction).toHaveBeenCalledOnce();
			expect(getOutbox(database, nextId)?.status).toBe('sent');
		});
	});

	describe('live send-mode toggle (W4-U8)', () => {
		it('fails safe: an omitted dryRun option means DRY RUN, never live sends', async () => {
			// A caller that supplies a real transport but forgets `dryRun` must not
			// transmit to real recipients. A sent WhatsApp message cannot be unsent,
			// so this default is the difference between a recoverable mistake and an
			// unrecoverable one. The `pacer()` helper opts into live explicitly, so
			// construct directly here to exercise the real default.
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'must not be transmitted',
				now: NOW
			});
			const sendTransport = transport();
			const instance = new OutboxPacer({
				db: database,
				transport: sendTransport,
				minDraftDelayMs: 1_000,
				maxDraftDelayMs: 1_000,
				manualPresenceMs: 0,
				now: Date.now,
				random: () => 0,
				sleep: async () => undefined
			});
			pacers.push(instance);

			expect(instance.isDryRun()).toBe(true);

			instance.start();
			await vi.advanceTimersByTimeAsync(0);

			// The queue still advances — dry-run changes whether we transmit, not
			// whether the row is processed — but nothing reached the transport.
			expect(getOutbox(database, id)?.status).toBe('sent');
			expect(sendTransport.sendText).not.toHaveBeenCalled();
		});

		it('flips from live to dry-run mid-flight and suppresses the next send', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id1 = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'first, live',
				now: NOW
			});
			// Second row due later, so the toggle lands before it drains.
			const id2 = enqueueManualOutbox(database, {
				chatJid: 'bob@s.whatsapp.net',
				text: 'second, after toggle to dry-run',
				now: NOW + 5_000
			});
			const sendTransport = transport();
			const instance = pacer(database, sendTransport);
			instance.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(sendTransport.sendText).toHaveBeenCalledTimes(1);
			expect(getOutbox(database, id1)?.status).toBe('sent');
			expect(instance.isDryRun()).toBe(false);

			// Safe direction: live → dry-run is one call, never confirmed.
			instance.setDryRun(true);
			expect(instance.isDryRun()).toBe(true);

			await vi.advanceTimersByTimeAsync(10_000);
			expect(sendTransport.sendText).toHaveBeenCalledTimes(1);
			// The row still advances through the queue (marked sent) — only the
			// transport call is suppressed. The pacer is still the only sender;
			// the toggle changes whether it transmits, not whether it drains.
			expect(getOutbox(database, id2)?.status).toBe('sent');
		});

		it('flips from dry-run to live mid-flight and transmits the next send', async () => {
			vi.useFakeTimers({ now: NOW });
			vi.spyOn(console, 'info').mockImplementation(() => undefined);
			const database = setup();
			const id1 = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'first, dry-run',
				now: NOW
			});
			const id2 = enqueueManualOutbox(database, {
				chatJid: 'bob@s.whatsapp.net',
				text: 'second, after toggle to live',
				now: NOW + 5_000
			});
			const sendTransport = transport();
			const instance = pacer(database, sendTransport, { dryRun: true });
			instance.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(sendTransport.sendText).not.toHaveBeenCalled();
			expect(getOutbox(database, id1)?.status).toBe('sent');
			expect(instance.isDryRun()).toBe(true);

			// Unsafe direction: the UI confirms before calling this; the pacer
			// itself applies the change immediately and without a second gate.
			instance.setDryRun(false);
			expect(instance.isDryRun()).toBe(false);

			await vi.advanceTimersByTimeAsync(10_000);
			expect(sendTransport.sendText).toHaveBeenCalledTimes(1);
			expect(getOutbox(database, id2)?.status).toBe('sent');
		});

		it('does not change what is sent, only whether it is transmitted', async () => {
			vi.useFakeTimers({ now: NOW });
			vi.spyOn(console, 'info').mockImplementation(() => undefined);
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'payload is identical in either mode',
				now: NOW
			});
			const sendTransport = transport();
			const instance = pacer(database, sendTransport, { dryRun: true });
			instance.setDryRun(false);
			instance.start();
			await vi.runAllTimersAsync();

			expect(sendTransport.sendText).toHaveBeenCalledWith(
				'alice@s.whatsapp.net',
				'payload is identical in either mode',
				expect.any(String),
				undefined
			);
			expect(getOutbox(database, id)?.status).toBe('sent');
		});
	});
	/**
	 * OUTBOX-1 — the outbox used to re-arm every failed send 5s later, forever:
	 * no attempt counter, no cap, no `failed` status. That is an invisible
	 * failure for the owner and the traffic shape that flags an account.
	 */
	describe('bounded retry and terminal failure', () => {
		it('backs off, gives up after the cap, and records why', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'never gets through',
				now: NOW
			});
			const sendText = vi.fn(async () => {
				throw new Error('socket hung up');
			});
			const onError = vi.fn();
			const sendTransport = transport({ sendText });
			pacer(database, sendTransport, { onError, maxAttempts: 3 }).start();

			await vi.advanceTimersByTimeAsync(0);
			expect(getOutbox(database, id)).toMatchObject({ status: 'pending', attempts: 1 });

			// First retry waits the base delay, the second twice that — not a
			// fixed 5s drumbeat.
			await vi.advanceTimersByTimeAsync(499);
			expect(sendText).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(getOutbox(database, id)).toMatchObject({ status: 'pending', attempts: 2 });
			await vi.advanceTimersByTimeAsync(999);
			expect(sendText).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);

			expect(getOutbox(database, id)).toMatchObject({
				status: 'failed',
				attempts: 3,
				last_error: 'socket hung up',
				sent_at: null
			});
			expect(getOutbox(database, id)?.failed_at).toBe(Date.now());

			// The row is terminal: no further traffic, however long we wait.
			await vi.advanceTimersByTimeAsync(600_000);
			expect(sendText).toHaveBeenCalledTimes(3);
			expect(onError).toHaveBeenCalledTimes(3);
		});

		it('fails a rejected payload on the first attempt instead of retrying it', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'whatsapp will never accept this',
				now: NOW
			});
			const sendText = vi.fn(async () => {
				throw new Boom('no content in message', { statusCode: 400 });
			});
			const sendTransport = transport({ sendText });
			pacer(database, sendTransport, { maxAttempts: 5 }).start();
			await vi.advanceTimersByTimeAsync(600_000);

			expect(sendText).toHaveBeenCalledOnce();
			expect(getOutbox(database, id)).toMatchObject({
				status: 'failed',
				attempts: 1,
				last_error: 'no content in message'
			});
		});

		it('does not spend the attempt budget while there is no socket', async () => {
			// Nothing reaches WhatsApp when the transport has no socket, so the
			// ban-risk rationale does not apply — and failing the owner's queue
			// because their laptop slept would be wrong. This is the one case the
			// cap deliberately does not bound.
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'queued while offline',
				now: NOW
			});
			let connected = false;
			const sendText = vi.fn(async () => {
				if (!connected) throw new WhatsAppDisconnectedError();
			});
			const sendTransport = transport({ sendText });
			pacer(database, sendTransport, { maxAttempts: 2 }).start();
			await vi.advanceTimersByTimeAsync(5_000);

			expect(sendText.mock.calls.length).toBeGreaterThan(2);
			expect(getOutbox(database, id)).toMatchObject({ status: 'pending', attempts: 0 });

			connected = true;
			await vi.advanceTimersByTimeAsync(500);
			expect(getOutbox(database, id)).toMatchObject({ status: 'sent', attempts: 0 });
		});

		it('releases the rows behind a failed one', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const doomed = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'doomed',
				now: NOW
			});
			const next = enqueueManualOutbox(database, {
				chatJid: 'bob@s.whatsapp.net',
				text: 'independent send',
				now: NOW
			});
			const sendText = vi.fn(async (jid: string) => {
				if (jid === 'alice@s.whatsapp.net') {
					throw new Boom('rejected', { statusCode: 400 });
				}
			});
			const sendTransport = transport({ sendText });
			pacer(database, sendTransport).start();
			await vi.runAllTimersAsync();

			expect(getOutbox(database, doomed)?.status).toBe('failed');
			expect(getOutbox(database, next)?.status).toBe('sent');
		});

		it('applies the same policy to a reaction row', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			upsertMessage(database, {
				id: 'react-target',
				chat_jid: 'alice@s.whatsapp.net',
				from_me: false,
				ts: NOW,
				text: 'react to me',
				raw: JSON.stringify(
					{
						key: { id: 'react-target', remoteJid: 'alice@s.whatsapp.net', fromMe: false },
						message: { conversation: 'react to me' }
					} satisfies WAMessage,
					BufferJSON.replacer
				)
			});
			const id = enqueueReactionOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				targetMsgId: 'react-target',
				emoji: '\u{1F44D}',
				now: NOW
			});
			const sendReaction = vi.fn(async () => {
				throw new Boom('rejected', { statusCode: 400 });
			});
			const sendTransport = transport({ sendReaction });
			pacer(database, sendTransport).start();
			await vi.advanceTimersByTimeAsync(600_000);

			expect(sendReaction).toHaveBeenCalledOnce();
			expect(getOutbox(database, id)).toMatchObject({ status: 'failed', attempts: 1 });
		});

		it('lets the owner re-arm a failed row with a fresh budget', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'retry me',
				now: NOW
			});
			let broken = true;
			const sendText = vi.fn(async () => {
				if (broken) throw new Boom('rejected', { statusCode: 400 });
			});
			const sendTransport = transport({ sendText });
			const instance = pacer(database, sendTransport);
			instance.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(getOutbox(database, id)?.status).toBe('failed');

			broken = false;
			expect(retryFailedOutbox(database, id, Date.now())).toBe(true);
			expect(getOutbox(database, id)).toMatchObject({
				status: 'pending',
				attempts: 0,
				last_error: null,
				failed_at: null
			});
			instance.wake();
			await vi.runAllTimersAsync();
			expect(getOutbox(database, id)?.status).toBe('sent');
		});

		it('refuses to re-arm a row that is not failed', () => {
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'still queued',
				now: NOW
			});
			expect(retryFailedOutbox(database, id, NOW)).toBe(false);
			expect(getOutbox(database, id)?.status).toBe('pending');
		});

		it('lets the owner discard a failed row', async () => {
			vi.useFakeTimers({ now: NOW });
			const database = setup();
			const id = enqueueManualOutbox(database, {
				chatJid: 'alice@s.whatsapp.net',
				text: 'discard me',
				now: NOW
			});
			const sendText = vi.fn(async () => {
				throw new Boom('rejected', { statusCode: 400 });
			});
			pacer(database, transport({ sendText })).start();
			await vi.advanceTimersByTimeAsync(0);

			expect(getOutbox(database, id)?.status).toBe('failed');
			expect(cancelOutbox(database, id)).toBe(true);
			expect(getOutbox(database, id)?.status).toBe('cancelled');
		});
	});
});
