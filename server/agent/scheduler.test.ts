import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChat, setChatAgentState, upsertChat } from '../store/chats.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { deleteDraft, getDraft, upsertDraft, type Draft } from '../store/drafts.js';
import { getMessage, upsertMessage, type Message } from '../store/messages.js';
import { ProviderError, type DraftProvider } from '../providers/provider.js';
import { NullMemory } from './memory/null-memory.js';
import { DraftScheduler } from './scheduler.js';

const NOW = 1_700_000_100_000;
let db: AppDatabase | undefined;
let dataDir: string | undefined;
const schedulers: DraftScheduler[] = [];

function setup(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-scheduler-'));
	db = openDatabase({ dataDir });
	return db;
}

function addMessage(
	database: AppDatabase,
	jid: string,
	id: string,
	ts: number,
	options: { fromMe?: boolean; kind?: '1:1' | 'group'; text?: string } = {}
): Message {
	const existing = getChat(database, jid);
	upsertChat(database, {
		jid,
		name: existing?.name ?? jid,
		kind: options.kind ?? existing?.kind ?? '1:1',
		last_msg_at: ts,
		unread: existing?.unread ?? 0,
		muted: existing?.muted ?? false,
		archived: existing?.archived ?? false,
		agent_state: existing?.agent_state ?? null
	});
	upsertMessage(database, {
		id,
		chat_jid: jid,
		from_me: options.fromMe ?? false,
		ts,
		text: options.text ?? `message ${id}`
	});
	return getMessage(database, id)!;
}

function scheduler(database: AppDatabase, provider: DraftProvider, overrides = {}): DraftScheduler {
	const instance = new DraftScheduler({
		db: database,
		provider,
		providerName: 'fake',
		memory: new NullMemory(),
		debounceMs: 60_000,
		concurrency: 2,
		now: () => NOW,
		...overrides
	});
	schedulers.push(instance);
	return instance;
}

afterEach(() => {
	for (const scheduler of schedulers.splice(0)) scheduler.stop();
	vi.useRealTimers();
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

describe('DraftScheduler', () => {
	it('debounces a five-message burst into one provider call', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'One reply' }));
		const agent = scheduler(database, { draft });

		for (let i = 0; i < 5; i += 1) {
			const message = addMessage(database, 'alice@s.whatsapp.net', `m${i}`, NOW + i);
			agent.onMessage(message);
			if (i < 4) await vi.advanceTimersByTimeAsync(10_000);
		}
		expect(draft).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(draft).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledOnce();
		expect(getDraft(database, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('m4');
	});

	it('structurally excludes group mentions', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Never' }));
		const agent = scheduler(database, { draft });
		const mention = addMessage(database, 'team@g.us', 'g1', NOW, {
			kind: 'group',
			text: '@owner are you joining?'
		});

		agent.onMessage(mention);
		agent.start();
		await vi.runAllTimersAsync();

		expect(draft).not.toHaveBeenCalled();
		expect(getDraft(database, 'team@g.us')).toBeUndefined();
	});

	it('schedules only the exact outbound message named by the development override', async () => {
		vi.useFakeTimers();
		const database = setup();
		const allowed = addMessage(database, 'self@s.whatsapp.net', 'self-test', NOW, {
			fromMe: true,
			text: 'Want to play golf tomorrow?'
		});
		const other = addMessage(database, 'bob@s.whatsapp.net', 'other-outbound', NOW, {
			fromMe: true
		});
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Yes.' }));
		const agent = scheduler(database, { draft }, { devDraftFromMeMessageId: 'self-test' });

		agent.onMessage(other);
		agent.onMessage(allowed);
		await vi.advanceTimersByTimeAsync(60_000);
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledOnce();
		expect(getDraft(database, 'self@s.whatsapp.net')?.basis_msg_id).toBe('self-test');
		expect(getDraft(database, 'bob@s.whatsapp.net')).toBeUndefined();
	});

	it('processes backlog oldest-first with a concurrency cap and continues after failure', async () => {
		vi.useFakeTimers();
		const database = setup();
		for (const [jid, age] of [
			['old@s.whatsapp.net', 90_000],
			['middle@s.whatsapp.net', 80_000],
			['new@s.whatsapp.net', 70_000]
		] as const) {
			addMessage(database, jid, `${jid}-m1`, NOW - age);
		}

		const order: string[] = [];
		let active = 0;
		let maxActive = 0;
		const provider: DraftProvider = {
			draft: async (input) => {
				const content = input.conversation.at(-1)!.content;
				order.push(content);
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				if (content.includes('old@s.whatsapp.net')) {
					throw new ProviderError('process_exit', 'broken');
				}
				return { kind: 'draft', text: `reply to ${content}` };
			}
		};
		const agent = scheduler(database, provider);

		agent.start();
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		expect(order.slice(0, 2)).toEqual([
			'message old@s.whatsapp.net-m1',
			'message middle@s.whatsapp.net-m1'
		]);
		expect(order).toHaveLength(3);
		expect(maxActive).toBe(2);
		expect(getDraft(database, 'old@s.whatsapp.net')?.status).toBe('failed');
		expect(getDraft(database, 'new@s.whatsapp.net')?.status).toBe('ready');
	});

	it('invalidates and regenerates a ready draft after new inbound', async () => {
		vi.useFakeTimers();
		const database = setup();
		addMessage(database, 'alice@s.whatsapp.net', 'm1', NOW - 90_000);
		let calls = 0;
		const agent = scheduler(database, {
			draft: async () => ({ kind: 'draft', text: `draft ${++calls}` })
		});
		agent.start();
		await vi.advanceTimersByTimeAsync(0);
		await agent.waitForIdle();

		const followUp = addMessage(database, 'alice@s.whatsapp.net', 'm2', NOW + 1);
		agent.onMessage(followUp);
		expect(getDraft(database, 'alice@s.whatsapp.net')?.status).toBe('stale');
		await vi.advanceTimersByTimeAsync(60_000);
		await agent.waitForIdle();

		expect(calls).toBe(2);
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			status: 'ready',
			text: 'draft 2',
			basis_msg_id: 'm2'
		});
	});

	it('returns a skipped chat to the pipeline on later inbound', async () => {
		vi.useFakeTimers();
		const database = setup();
		addMessage(database, 'alice@s.whatsapp.net', 'm1', NOW - 90_000);
		setChatAgentState(database, 'alice@s.whatsapp.net', 'skipped');
		deleteDraft(database, 'alice@s.whatsapp.net');
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Fresh reply' }));
		const agent = scheduler(database, { draft });
		agent.start();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(draft).not.toHaveBeenCalled();

		const next = addMessage(database, 'alice@s.whatsapp.net', 'm2', NOW + 1);
		agent.onMessage(next);
		await vi.advanceTimersByTimeAsync(60_000);
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledOnce();
		expect(getDraft(database, 'alice@s.whatsapp.net')?.basis_msg_id).toBe('m2');
	});

	it('does not auto-retry failures, but re-enters after new inbound', async () => {
		vi.useFakeTimers();
		const database = setup();
		addMessage(database, 'alice@s.whatsapp.net', 'm1', NOW - 90_000);
		const draft = vi
			.fn()
			.mockRejectedValueOnce(new ProviderError('timeout', 'timed out', true, 1))
			.mockResolvedValueOnce({ kind: 'draft', text: 'Recovered' });
		const agent = scheduler(database, { draft });
		agent.start();
		await vi.advanceTimersByTimeAsync(0);
		await agent.waitForIdle();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(draft).toHaveBeenCalledOnce();

		const next = addMessage(database, 'alice@s.whatsapp.net', 'm2', NOW + 1);
		agent.onMessage(next);
		await vi.advanceTimersByTimeAsync(60_000);
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledTimes(2);
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			status: 'ready',
			text: 'Recovered',
			basis_msg_id: 'm2'
		});
	});

	it('retries a failed draft only when explicitly requested', async () => {
		vi.useFakeTimers();
		const database = setup();
		addMessage(database, 'alice@s.whatsapp.net', 'm1', NOW - 90_000);
		const draft = vi
			.fn()
			.mockRejectedValueOnce(new ProviderError('unavailable', 'offline'))
			.mockResolvedValueOnce({ kind: 'draft', text: 'Manual retry' });
		const agent = scheduler(database, { draft });
		agent.start();
		await vi.advanceTimersByTimeAsync(0);
		await agent.waitForIdle();
		expect(getDraft(database, 'alice@s.whatsapp.net')?.status).toBe('failed');

		agent.retry('alice@s.whatsapp.net');
		await vi.advanceTimersByTimeAsync(0);
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledTimes(2);
		expect(getDraft(database, 'alice@s.whatsapp.net')).toMatchObject({
			status: 'ready',
			text: 'Manual retry'
		});
	});

	it('requeues rate limits only after retryAfterMs', async () => {
		vi.useFakeTimers();
		const database = setup();
		addMessage(database, 'alice@s.whatsapp.net', 'm1', NOW - 90_000);
		const draft = vi
			.fn()
			.mockRejectedValueOnce(new ProviderError('rate_limit', 'wait', true, 500))
			.mockResolvedValueOnce({ kind: 'draft', text: 'After backoff' });
		const agent = scheduler(database, { draft });
		agent.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(draft).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(499);
		expect(draft).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledTimes(2);
		expect(getDraft(database, 'alice@s.whatsapp.net')?.status).toBe('ready');
	});
});

describe('DraftScheduler.generate — owner-triggered', () => {
	it('drafts in a chat the classifier rejects: owner spoke last and the chat is skipped', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'On demand' }));
		const agent = scheduler(database, { draft });
		addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);
		addMessage(database, 'alice@s.whatsapp.net', 'out-1', NOW + 1_000, { fromMe: true });
		setChatAgentState(database, 'alice@s.whatsapp.net', 'skipped');

		expect(agent.generate('alice@s.whatsapp.net')).toBe(true);
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledOnce();
		const row = getDraft(database, 'alice@s.whatsapp.net');
		expect(row?.status).toBe('ready');
		expect(row?.text).toBe('On demand');
		// Basis is the last message in the chat even though it is outbound, so a
		// later inbound still invalidates approval (R-draft-basis).
		expect(row?.basis_msg_id).toBe('out-1');
	});

	it('drafts in a muted, archived chat that has gone quiet', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Still yours to send' }));
		const agent = scheduler(database, { draft });
		addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);
		upsertChat(database, {
			jid: 'alice@s.whatsapp.net',
			name: 'alice',
			kind: '1:1',
			last_msg_at: NOW,
			unread: 0,
			muted: true,
			archived: true,
			agent_state: 'quiet'
		});

		expect(agent.generate('alice@s.whatsapp.net')).toBe(true);
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		expect(getDraft(database, 'alice@s.whatsapp.net')?.status).toBe('ready');
	});

	it('refuses a group chat at the seam — R8 does not depend on the route', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Never' }));
		const agent = scheduler(database, { draft });
		addMessage(database, 'team@g.us', 'g1', NOW, { kind: 'group' });

		expect(agent.generate('team@g.us')).toBe(false);
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		expect(draft).not.toHaveBeenCalled();
		expect(getDraft(database, 'team@g.us')).toBeUndefined();
	});

	it('refuses while a draft is drafting or approved', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Never' }));
		const agent = scheduler(database, { draft });
		addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);

		for (const status of ['drafting', 'approved'] as const) {
			upsertDraft(database, {
				chat_jid: 'alice@s.whatsapp.net',
				text: 'existing',
				status,
				generated_at: NOW,
				provider: 'fake',
				basis_msg_id: 'in-1'
			});
			expect(agent.generate('alice@s.whatsapp.net')).toBe(false);
			await vi.runAllTimersAsync();
			await agent.waitForIdle();
			expect(draft).not.toHaveBeenCalled();
			// The refusal must leave the existing row exactly as it was.
			expect(getDraft(database, 'alice@s.whatsapp.net')?.status).toBe(status);
		}
	});

	it('does not carry owner authority into the next automatic run for the same chat', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'On demand' }));
		const agent = scheduler(database, { draft });
		addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);
		const outbound = addMessage(database, 'alice@s.whatsapp.net', 'out-1', NOW + 1_000, {
			fromMe: true
		});

		agent.generate('alice@s.whatsapp.net');
		await vi.runAllTimersAsync();
		await agent.waitForIdle();
		expect(draft).toHaveBeenCalledOnce();

		// A later automatic pass over the same chat must obey the classifier again.
		setChatAgentState(database, 'alice@s.whatsapp.net', 'skipped');
		deleteDraft(database, 'alice@s.whatsapp.net');
		agent.onMessage(outbound);
		agent.start();
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		expect(draft).toHaveBeenCalledOnce();
		expect(getDraft(database, 'alice@s.whatsapp.net')).toBeUndefined();
	});

	it('cancels a pending debounce rather than racing it', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'One reply' }));
		const agent = scheduler(database, { draft });
		const inbound = addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);

		agent.onMessage(inbound);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(draft).not.toHaveBeenCalled();

		agent.generate('alice@s.whatsapp.net');
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		// One run total: the debounce timer was replaced, not queued alongside.
		expect(draft).toHaveBeenCalledOnce();
	});

	it('marks a stale-able existing draft stale and emits it before regenerating', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'draft' as const, text: 'Fresh' }));
		const updates: string[] = [];
		const agent = scheduler(database, { draft }, {
			hooks: { onDraftUpdated: (row: Draft) => updates.push(row.status) }
		});
		addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);
		upsertDraft(database, {
			chat_jid: 'alice@s.whatsapp.net',
			text: 'old',
			status: 'ready',
			generated_at: NOW,
			provider: 'fake',
			basis_msg_id: 'in-1'
		});

		expect(agent.generate('alice@s.whatsapp.net')).toBe(true);
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		expect(updates[0]).toBe('stale');
		expect(updates).toContain('drafting');
		expect(getDraft(database, 'alice@s.whatsapp.net')?.text).toBe('Fresh');
	});

	it('clears agent state instead of demoting to quiet when the provider declines', async () => {
		vi.useFakeTimers();
		const database = setup();
		const draft = vi.fn(async () => ({ kind: 'no_reply_needed' as const, reason: 'owner already covered it' }));
		const agent = scheduler(database, { draft });
		addMessage(database, 'alice@s.whatsapp.net', 'in-1', NOW);
		addMessage(database, 'alice@s.whatsapp.net', 'out-1', NOW + 1_000, { fromMe: true });

		agent.generate('alice@s.whatsapp.net');
		await vi.runAllTimersAsync();
		await agent.waitForIdle();

		// Asking for help must not be what silences the chat.
		expect(getChat(database, 'alice@s.whatsapp.net')?.agent_state).toBeNull();
	});
});
