import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from './state.svelte.js';
import type { Chat, Draft, Message } from './types.js';
import { deriveUnreadBoundaryFromCursor } from './view.js';
import { FIXTURE_SPLIT_LID_JID } from '../../../shared/test-fixtures.js';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

const JID = 'maya@s.whatsapp.net';

function chatRow(overrides: Partial<Chat> = {}): Chat {
	return {
		jid: JID,
		display_jid: JID,
		channel: 'whatsapp',
		name: 'Maya',
		kind: '1:1',
		last_msg_at: 500,
		unread: 0,
		muted: false,
		archived: false,
		agent_state: null,
		last_read_msg_id: null,
		needs_reply: false,
		preview: null,
		preview_from_me: false,
		draft_status: null,
		...overrides
	};
}

function inbound(id: string, ts: number, fromMe = false): Message {
	return {
		id,
		chat_jid: JID,
		channel: 'whatsapp',
		from_me: fromMe,
		sender: null,
		ts,
		type: 'text',
		text: id,
		media: null,
		quote: null,
		reactions: []
	};
}

describe('AppState deepen history feedback', () => {
	afterEach(() => vi.restoreAllMocks());

	it('preserves Requested feedback through the post-deepen conversation refresh', async () => {
		const state = new AppState();
		state.selectedJid = 'maya@s.whatsapp.net';

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/history/deepen')) return jsonResponse({ accepted: true }, 202);
			if (url.includes('/messages?')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			throw new Error(`Unexpected request: ${url}`);
		});

		await state.deepenHistory();

		expect(state.deepenStatus.kind).toBe('success');

		await state.openChat('sam@s.whatsapp.net', { markRead: false });
		expect(state.deepenStatus).toEqual({ kind: 'idle', at: null });
	});
});

/**
 * W4-U12 fragility 1. `handleHistorySet` writes chat and message rows and
 * publishes no per-row event — by design, a batch can carry thousands of rows.
 * `sync-progress` is the only announcement the client gets, so it has to be the
 * trigger for a refetch, otherwise recovered history sits invisible until the
 * owner clicks something.
 */
describe('AppState history-sync resync', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	/** Counts the calls refresh() makes, and serves history that only a refetch can reveal. */
	function mockBackend(historyMessages: Message[]) {
		const calls = { chats: 0, messages: 0 };
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/session')) {
				return jsonResponse({
					status: 'connected',
					qr: null,
					qrExpiresAt: null,
					sync: { chatsSynced: 0, messagesSynced: 0, complete: false }
				});
			}
			if (url.includes('/chats?filter=')) {
				calls.chats += 1;
				return jsonResponse({ items: [chatRow({ last_msg_at: 900 })] });
			}
			if (url.includes('/messages?')) {
				calls.messages += 1;
				return jsonResponse({ items: historyMessages });
			}
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.endsWith('/outbox/send-mode')) return jsonResponse({ live: false, dry_run: true });
			if (url.endsWith('/outbox')) return jsonResponse({ items: [] });
			throw new Error(`Unexpected request: ${url}`);
		});
		return calls;
	}

	function syncProgress(chatsSynced: number, messagesSynced: number) {
		return {
			type: 'sync-progress' as const,
			phase: 'history',
			chatsSynced,
			messagesSynced,
			complete: false
		};
	}

	it('surfaces history-written messages that arrive with no message-new event', async () => {
		const state = new AppState({ resyncDebounceMs: 5, resyncMaxWaitMs: 200 });
		const calls = mockBackend([inbound('HIST-OLD', 100)]);
		state.selectedJid = JID;

		state.applyEvent(syncProgress(1, 12));
		expect(calls.chats).toBe(0); // nothing synchronous — the refetch is coalesced

		await vi.waitFor(() => expect(state.messages.map((m) => m.id)).toEqual(['HIST-OLD']));
		expect(state.chats).toHaveLength(1);
	});

	it('keeps the deepen feedback alive when the deepened history lands', async () => {
		const state = new AppState({ resyncDebounceMs: 5, resyncMaxWaitMs: 200 });
		const calls = mockBackend([inbound('HIST-OLD', 100)]);
		state.selectedJid = JID;
		state.deepenStatus = { kind: 'success', at: Date.now() };

		// The phone answering the deepen is what schedules the resync — so the
		// resync must not wipe the "Requested" feedback with its own result.
		state.applyEvent(syncProgress(1, 5));
		await vi.waitFor(() => expect(calls.chats).toBe(1));
		expect(state.deepenStatus.kind).toBe('success');
	});

	it('collapses a burst of history batches into a single refetch', async () => {
		const state = new AppState({ resyncDebounceMs: 20, resyncMaxWaitMs: 5_000 });
		const calls = mockBackend([]);
		state.selectedJid = JID;

		for (let i = 1; i <= 8; i += 1) state.applyEvent(syncProgress(i, i * 50));

		await vi.waitFor(() => expect(calls.chats).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(calls.chats).toBe(1);
	});

	it('does not refetch for a repeated batch that wrote nothing', async () => {
		const state = new AppState({ resyncDebounceMs: 5, resyncMaxWaitMs: 200 });
		const calls = mockBackend([]);

		state.applyEvent(syncProgress(3, 40));
		await vi.waitFor(() => expect(calls.chats).toBe(1));

		state.applyEvent(syncProgress(3, 40));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(calls.chats).toBe(1);
	});

	it('still refetches mid-sync when batches never pause long enough to settle', async () => {
		vi.useFakeTimers();
		const state = new AppState();
		const calls = mockBackend([]);

		// Batches every 500ms: shorter than the 750ms debounce, so a trailing-only
		// timer would be rescheduled forever and the chat list would stay empty
		// for the whole sync. The 4s max-wait is what breaks the starvation.
		for (let i = 1; i <= 20; i += 1) {
			state.applyEvent(syncProgress(i, i * 10));
			await vi.advanceTimersByTimeAsync(500);
		}

		expect(calls.chats).toBeGreaterThanOrEqual(2);
	});
});

/**
 * W4-U14. A same-chat resync (refresh / sync-progress coalesced refetch) must
 * not collapse a reader who has paged back through older messages. openChat
 * used to hard-reset with mergeMessages([], newestPage); that threw away every
 * prepended page. Switching chats still resets to one page.
 */
describe('AppState scroll window across same-chat resync', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	/** Full newest page (PAGE_SIZE) so hasMore starts true. */
	const newestPage = Array.from({ length: 60 }, (_, i) =>
		inbound(`n${i + 1}`, 1000 + i)
	);
	/** Short older page — clears hasMore after loadOlder. */
	const olderPage = [inbound('o1', 10), inbound('o2', 20)];
	const newestIds = newestPage.map((m) => m.id);
	const windowIds = ['o1', 'o2', ...newestIds];

	function mockPagedConversation(options: { delayNewestMs?: number } = {}) {
		const calls = { messages: 0, newestOnly: 0, older: 0 };
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?') && url.includes('beforeId=')) {
				calls.older += 1;
				calls.messages += 1;
				return jsonResponse({ items: olderPage });
			}
			if (url.includes('/messages')) {
				calls.newestOnly += 1;
				calls.messages += 1;
				if (options.delayNewestMs) {
					await new Promise((r) => setTimeout(r, options.delayNewestMs));
				}
				return jsonResponse({ items: newestPage });
			}
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.endsWith('/read')) return jsonResponse(chatRow({ unread: 0 }));
			if (url.includes('/chats?filter=')) return jsonResponse({ items: [chatRow()] });
			if (url.endsWith('/session')) {
				return jsonResponse({
					status: 'ready',
					qr: null,
					qrExpiresAt: null,
					sync: { chatsSynced: 0, messagesSynced: 0, complete: true }
				});
			}
			if (url.endsWith('/outbox/send-mode')) return jsonResponse({ live: false, dry_run: true });
			if (url.endsWith('/outbox')) return jsonResponse({ items: [] });
			throw new Error(`Unexpected request: ${url}`);
		});
		return calls;
	}

	it('keeps prepended older pages after a same-chat resync', async () => {
		const state = new AppState({ resyncDebounceMs: 5, resyncMaxWaitMs: 200 });
		state.chats = [chatRow()];
		const calls = mockPagedConversation();

		await state.openChat(JID);
		expect(state.messages.map((m) => m.id)).toEqual(newestIds);
		expect(state.hasMoreMessages).toBe(true);

		await state.loadOlder();
		expect(state.messages.map((m) => m.id)).toEqual(windowIds);
		// Short older page cleared the oldest-edge flag.
		expect(state.hasMoreMessages).toBe(false);
		const newestFetchesBeforeResync = calls.newestOnly;

		// Machine-triggered resync — the path sync-progress takes after W4-U12.
		state.applyEvent({
			type: 'sync-progress',
			phase: 'history',
			chatsSynced: 1,
			messagesSynced: 12,
			complete: false
		});
		await vi.waitFor(() => expect(calls.newestOnly).toBeGreaterThan(newestFetchesBeforeResync));

		// Older pages survive. One newest-page request; not one per loaded page.
		expect(state.messages.map((m) => m.id)).toEqual(windowIds);
		expect(calls.newestOnly - newestFetchesBeforeResync).toBe(1);
		expect(calls.older).toBe(1); // only the explicit loadOlder
		// hasMore is about the oldest edge — a full newest-page refetch must not
		// revive it (would wrongly re-enable "load earlier").
		expect(state.hasMoreMessages).toBe(false);
	});

	it('still resets to one page when switching to a different chat', async () => {
		const state = new AppState();
		state.chats = [
			chatRow(),
			chatRow({ jid: 'sam@s.whatsapp.net', display_jid: 'sam@s.whatsapp.net', name: 'Sam' })
		];
		mockPagedConversation();

		await state.openChat(JID);
		await state.loadOlder();
		expect(state.messages.map((m) => m.id)).toEqual(windowIds);

		await state.openChat('sam@s.whatsapp.net');
		expect(state.messages.map((m) => m.id)).toEqual(newestIds);
		expect(state.hasMoreMessages).toBe(true);
	});

	it('does not flash loadingMessages during a same-chat window-preserving resync', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		mockPagedConversation({ delayNewestMs: 30 });

		await state.openChat(JID);
		await state.loadOlder();
		expect(state.loadingMessages).toBe(false);

		const refreshPromise = state.refresh({ preserveDeepenStatus: true });
		// Mid-flight: ConversationPane unmounts the stream when loadingMessages
		// is true, which would yank scroll even if the array were preserved.
		await new Promise((r) => setTimeout(r, 5));
		expect(state.loadingMessages).toBe(false);
		await refreshPromise;
		expect(state.messages.map((m) => m.id)).toEqual(windowIds);
	});
});

describe('AppState unread boundary', () => {
	afterEach(() => vi.restoreAllMocks());

	/** Serves a fixed page, plus an optional older page for the prepend case. */
	function mockConversation(page: Message[], olderPage: Message[] = []) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?') && url.includes('beforeId=')) {
				return jsonResponse({ items: olderPage });
			}
			if (url.includes('/messages')) return jsonResponse({ items: page });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			// markRead: the server has zeroed unread by the time it answers.
			if (url.endsWith('/read')) return jsonResponse(chatRow({ unread: 0 }));
			throw new Error(`Unexpected request: ${url}`);
		});
	}

	it('marks one boundary before the first unread message and keeps it after markRead', async () => {
		const state = new AppState();
		state.chats = [chatRow({ unread: 2 })];
		mockConversation([
			inbound('i1', 1),
			inbound('o1', 2, true),
			inbound('i2', 3),
			inbound('i3', 4)
		]);

		await state.openChat(JID);

		expect(state.unreadBoundary).toEqual({ firstUnreadId: 'i2', count: 2, exact: true });
		// The chat is read now, but the marker the owner is reading against stays.
		expect(state.selectedChat?.unread).toBe(0);
	});

	it('does not restate the boundary when the same chat is reloaded after markRead', async () => {
		const state = new AppState();
		state.chats = [chatRow({ unread: 2 })];
		mockConversation([inbound('i1', 1), inbound('i2', 2), inbound('i3', 3)]);

		await state.openChat(JID);
		const afterOpen = state.unreadBoundary;
		await state.openChat(JID, { markRead: false });

		expect(state.unreadBoundary).toEqual(afterOpen);
	});

	it('keeps an approximate marker until an older page reveals the exact boundary', async () => {
		const state = new AppState();
		state.chats = [chatRow({ unread: 4 })];
		mockConversation(
			[inbound('i3', 3), inbound('i4', 4)],
			[inbound('i1', 1), inbound('i2', 2)]
		);

		await state.openChat(JID);
		expect(state.unreadBoundary).toEqual({ firstUnreadId: 'i3', count: 4, exact: false });

		await state.loadOlder();
		expect(state.unreadBoundary).toEqual({ firstUnreadId: 'i1', count: 4, exact: true });
	});

	it('does not walk the marker forward when live messages arrive', async () => {
		const state = new AppState();
		state.chats = [chatRow({ unread: 4 })];
		mockConversation([inbound('i3', 3), inbound('i4', 4)]);

		await state.openChat(JID);
		const boundary = state.unreadBoundary;

		state.messages = [...state.messages, inbound('i5', 5), inbound('i6', 6)];
		expect(state.unreadBoundary).toEqual(boundary);
	});

	it('derives the boundary from the persisted cursor when present (U4)', async () => {
		const state = new AppState();
		// Cursor at i2 → first unread is i3; unread count labels the marker.
		state.chats = [chatRow({ unread: 2, last_read_msg_id: 'i2' })];
		mockConversation([
			inbound('i1', 1),
			inbound('o1', 2, true),
			inbound('i2', 3),
			inbound('i3', 4),
			inbound('i4', 5)
		]);

		await state.openChat(JID);

		expect(state.unreadBoundary).toEqual({ firstUnreadId: 'i3', count: 2, exact: true });
	});

	it('falls back to count-based derivation when the cursor is null (chat never opened)', async () => {
		const state = new AppState();
		state.chats = [chatRow({ unread: 2, last_read_msg_id: null })];
		mockConversation([
			inbound('i1', 1),
			inbound('o1', 2, true),
			inbound('i2', 3),
			inbound('i3', 4)
		]);

		await state.openChat(JID);

		// Same placement as the W2-U1 latch — the boundary never regresses.
		expect(state.unreadBoundary).toEqual({ firstUnreadId: 'i2', count: 2, exact: true });
	});

	it('survives a simulated restart: a fresh AppState re-derives from the persisted cursor', async () => {
		// First session: open the chat, server advances the cursor to the latest
		// message (i3) and returns it in the markRead response.
		const state = new AppState();
		state.chats = [chatRow({ unread: 2, last_read_msg_id: 'i1' })];
		mockConversation([inbound('i1', 1), inbound('i2', 2), inbound('i3', 3)]);

		await state.openChat(JID);
		// The markRead response is chatRow({ unread: 0 }) which has a null cursor
		// in the mock; emulate the real server by stamping the returned cursor.
		state.chats = state.chats.map((c) =>
			c.jid === JID ? { ...c, unread: 0, last_read_msg_id: 'i3' } : c
		);

		// New session: brand-new AppState (in-memory latch is gone), but the
		// server-supplied chat row carries the persisted cursor.
		const reopened = new AppState();
		reopened.chats = [chatRow({ unread: 0, last_read_msg_id: 'i3' })];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages')) {
				return jsonResponse({ items: [inbound('i1', 1), inbound('i2', 2), inbound('i3', 3)] });
			}
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			throw new Error(`Unexpected request: ${url}`);
		});
		await reopened.openChat(JID, { markRead: false });

		// Cursor is at the last inbound → no unread boundary, exactly as the
		// owner left it before the "restart".
		expect(reopened.unreadBoundary).toBeNull();
	});
});

describe('AppState targeted message updates', () => {
	const reacted = (id: string, ts: number, emoji: string, actors: string[]): Message => ({
		...inbound(id, ts),
		reactions: [
			{
				emoji,
				count: actors.length,
				actors: actors.map((name) => ({
					jid: `${name}@s.whatsapp.net`,
					display_jid: `${name}@s.whatsapp.net`,
					name
				}))
			}
		]
	});

	it('updates reaction chips in place without duplicating or reordering', () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.messages = [inbound('m1', 1), inbound('m2', 2), inbound('m3', 3)];

		state.applyEvent({ type: 'message-updated', message: reacted('m2', 2, '🔥', ['Maya']) });

		expect(state.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
		expect(state.messages[1]!.reactions[0]).toMatchObject({ emoji: '🔥', count: 1 });
	});

	it('clears the chip when the last actor removes their reaction', () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.messages = [reacted('m1', 1, '🔥', ['Maya'])];

		state.applyEvent({ type: 'message-updated', message: inbound('m1', 1) });

		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]!.reactions).toEqual([]);
	});

	// A reaction on a message above the loaded window must not conjure a bubble
	// with a history hole around it — and it must not disturb the unread latch.
	it('ignores an update for a message that is not loaded', () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.chats = [chatRow({ unread: 1 })];
		state.messages = [inbound('m2', 2)];
		state.unreadBoundary = { firstUnreadId: 'm2', count: 1, exact: true };

		state.applyEvent({ type: 'message-updated', message: reacted('m0', 0, '🔥', ['Maya']) });

		expect(state.messages.map((m) => m.id)).toEqual(['m2']);
		expect(state.unreadBoundary).toEqual({ firstUnreadId: 'm2', count: 1, exact: true });
	});

	it('ignores an update addressed to another chat', () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.messages = [inbound('m1', 1)];

		state.applyEvent({
			type: 'message-updated',
			message: { ...reacted('m1', 1, '🔥', ['Maya']), chat_jid: 'someone-else@s.whatsapp.net' }
		});

		expect(state.messages[0]!.reactions).toEqual([]);
	});
});

describe('AppState quoted composer replies', () => {
	afterEach(() => vi.restoreAllMocks());

	it('posts the selected target and clears it only after enqueue succeeds', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		const target = inbound('target-1', 1);
		state.selectReply(target);
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse(
				{
					id: 7,
					chat_jid: JID,
					text: 'Quoted answer',
					queued_at: 100,
					send_after: 100,
					sent_at: null,
					status: 'pending',
					source: 'manual',
					message_id: 'MESSAGE-7',
					draft_text: null,
					basis_msg_id: null,
					reply_to_msg_id: 'target-1'
				},
				202
			)
		);

		await expect(state.send('Quoted answer')).resolves.toBe(true);

		expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
			text: 'Quoted answer',
			reply_to_msg_id: 'target-1'
		});
		expect(state.replyTarget).toBeNull();
		expect(state.outbox[0]?.reply_to_msg_id).toBe('target-1');
	});

	it('preserves reply context when enqueue fails and clears it on explicit dismissal', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		const target = inbound('target-1', 1);
		state.selectReply(target);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'Unavailable' }, 503));

		await expect(state.send('Try later')).resolves.toBe(false);
		expect(state.replyTarget).toBe(target);

		state.dismissReply();
		expect(state.replyTarget).toBeNull();
	});
});

describe('AppState jump to quoted message (U5)', () => {
	afterEach(() => vi.restoreAllMocks());

	/**
	 * Serves an initial page and, when a `focusMsgId=` query arrives, a focused
	 * page centered on the requested target. The focused page is built from the
	 * full chain so the target lands in the middle with context on both sides.
	 */
	function mockJumpPages(initial: Message[], focused: Message[]) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('focusMsgId=')) return jsonResponse({ items: focused });
			if (url.includes('/messages')) return jsonResponse({ items: initial });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.endsWith('/read')) return jsonResponse(chatRow({ unread: 0 }));
			throw new Error(`Unexpected request: ${url}`);
		});
	}

	it('in-page jump: signals the target without fetching', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		const page = [inbound('m1', 1), inbound('m2', 2), inbound('m3', 3)];
		mockJumpPages(page, []);

		await state.openChat(JID);
		const fetchCalls = vi.mocked(fetch).mock.calls.length;

		await state.jumpToQuotedMessage('m2');

		// No extra fetch — the target was already on the loaded page.
		expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCalls);
		expect(state.jumpTarget).toEqual({ id: 'm2', nonce: expect.any(Number) });
	});

	it('off-page jump: fetches a focused page around the target, then signals', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		// Initial page only has m8–m10; the quote target m3 is off-page.
		const initial = [inbound('m8', 8), inbound('m9', 9), inbound('m10', 10)];
		const focused = [inbound('m1', 1), inbound('m2', 2), inbound('m3', 3), inbound('m4', 4)];
		mockJumpPages(initial, focused);

		await state.openChat(JID);
		expect(state.messages.map((m) => m.id)).toEqual(['m8', 'm9', 'm10']);

		await state.jumpToQuotedMessage('m3');

		// The focused page merged with the loaded window — target is now present.
		expect(state.messages.map((m) => m.id)).toEqual([
			'm1', 'm2', 'm3', 'm4', 'm8', 'm9', 'm10'
		]);
		expect(state.jumpTarget).toEqual({ id: 'm3', nonce: expect.any(Number) });
	});

	it('off-page jump produces a real prepend (the merge keeps existing context)', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		const initial = [inbound('m8', 8), inbound('m9', 9), inbound('m10', 10)];
		const focused = [inbound('m1', 1), inbound('m2', 2), inbound('m3', 3)];
		mockJumpPages(initial, focused);

		await state.openChat(JID);
		await state.jumpToQuotedMessage('m3');

		// m8–m10 are still loaded — the prepend did not discard them. This is
		// the W2-U1 anchor-restoration property: a prepend adds, never replaces.
		expect(state.messages.map((m) => m.id)).toContain('m8');
		expect(state.messages.map((m) => m.id)).toContain('m10');
	});

	it('a missing target degrades to a no-op: no signal, no crash', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		const initial = [inbound('m1', 1), inbound('m2', 2)];
		// Server returns an empty focused page — the target no longer exists.
		mockJumpPages(initial, []);

		await state.openChat(JID);
		expect(state.jumpTarget).toBeNull();

		await state.jumpToQuotedMessage('gone');
		// No signal set → the stream never tries to scroll to a missing bubble.
		expect(state.jumpTarget).toBeNull();
		// Existing messages are untouched — no partial merge of an empty page.
		expect(state.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
	});

	it('a second jump to the same id re-fires (nonce changes)', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		mockJumpPages([inbound('m1', 1), inbound('m2', 2)], []);

		await state.openChat(JID);
		await state.jumpToQuotedMessage('m1');
		const first = state.jumpTarget;
		expect(first?.id).toBe('m1');

		await state.jumpToQuotedMessage('m1');
		// Same target id, new nonce — the stream effect keys on nonce so it
		// re-runs instead of deduplicating.
		expect(state.jumpTarget?.id).toBe('m1');
		expect(state.jumpTarget?.nonce).not.toBe(first?.nonce);
	});

	it('clears the jump target on chat switch', async () => {
		const state = new AppState();
		state.chats = [
			chatRow({ jid: JID }),
			chatRow({ jid: 'sam@s.whatsapp.net', name: 'Sam' })
		];
		mockJumpPages([inbound('m1', 1), inbound('m2', 2)], []);

		await state.openChat(JID);
		await state.jumpToQuotedMessage('m1');
		expect(state.jumpTarget).not.toBeNull();

		await state.openChat('sam@s.whatsapp.net');
		expect(state.jumpTarget).toBeNull();
	});

	it('ignores a late off-page fetch result after a chat switch', async () => {
		const state = new AppState();
		state.chats = [
			chatRow({ jid: JID }),
			chatRow({ jid: 'sam@s.whatsapp.net', name: 'Sam' })
		];
		const initial = [inbound('m8', 8), inbound('m9', 9), inbound('m10', 10)];
		const focused = [inbound('m1', 1), inbound('m2', 2), inbound('m3', 3)];
		mockJumpPages(initial, focused);

		await state.openChat(JID);

		// Switch chats mid-jump: the focused fetch resolves after the switch.
		// openChat('sam…') is awaited first to advance the epoch, then the jump.
		// We simulate the race by awaiting the jump after the switch — the
		// epoch guard inside jumpToQuotedMessage must drop the late merge.
		const jumpPromise = state.jumpToQuotedMessage('m3');
		await state.openChat('sam@s.whatsapp.net');
		await jumpPromise;

		// The late focused page did not leak into the new chat's messages.
		expect(state.messages.map((m) => m.id)).not.toContain('m3');
		// And no jump signal was set for the new chat.
		expect(state.jumpTarget).toBeNull();
	});
});

describe('AppState draft approval', () => {
	afterEach(() => vi.restoreAllMocks());

	it('posts edited text to the draft approval endpoint instead of the manual composer endpoint', async () => {
		const state = new AppState();
		state.selectedJid = 'maya@s.whatsapp.net';
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse(
				{
					outbox: {
						id: 9,
						chat_jid: 'maya@s.whatsapp.net',
						text: 'Yeah, we are still on',
						queued_at: 100,
						send_after: 130,
						sent_at: null,
						status: 'pending',
						source: 'draft',
						message_id: 'MESSAGE-9',
						draft_text: 'Yeah, let us play tomorrow',
						basis_msg_id: 'inbound-1'
					},
					draft: {
						chat_jid: 'maya@s.whatsapp.net',
						text: 'Yeah, we are still on',
						status: 'approved',
						generated_at: 90,
						provider: 'codex',
						basis_msg_id: 'inbound-1',
						original_text: 'Yeah, let us play tomorrow'
					}
				},
				202
			)
		);

		await expect(state.approveDraft('Yeah, we are still on')).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [input, init] = fetchMock.mock.calls[0]!;
		expect(String(input)).toContain('/chats/maya%40s.whatsapp.net/draft/approve');
		expect(String(input)).not.toContain('/messages');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({ text: 'Yeah, we are still on' });
		expect(state.draft?.status).toBe('approved');
		expect(state.outbox[0]?.source).toBe('draft');
	});
});

function draftRow(overrides: Partial<Draft> = {}): Draft {
	return {
		chat_jid: JID,
		text: 'Yes, seven works for me.',
		status: 'ready',
		generated_at: 201,
		provider: 'fake',
		basis_msg_id: 'a1',
		original_text: 'Yes, seven works for me.',
		text_source: 'system',
		...overrides
	};
}

describe('AppState draft refinement', () => {
	afterEach(() => vi.restoreAllMocks());

	it('posts the intent and preview, updates the active draft, and never touches the outbox', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.draft = draftRow();
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(jsonResponse(draftRow({ text: 'Seven works.' })));

		const updated = await state.refineDraft('shorter', 'Yes, seven works for me.');

		expect(updated).not.toBeNull();
		expect(updated?.text).toBe('Seven works.');
		expect(state.draft?.text).toBe('Seven works.');
		expect(state.refining).toBe(false);
		expect(state.refineError).toBeNull();
		expect(state.outbox).toEqual([]);

		const [input, init] = fetchMock.mock.calls[0]!;
		expect(String(input)).toContain('/chats/maya%40s.whatsapp.net/draft/refine');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({
			intent: 'shorter',
			text: 'Yes, seven works for me.'
		});
	});

	it('refines the saved draft preview when no editor text is passed', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.draft = draftRow();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/draft/refine')) {
				return jsonResponse(draftRow({ text: 'Shorter saved preview.' }));
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		const updated = await state.refineDraft('shorter');

		expect(updated?.text).toBe('Shorter saved preview.');
		// The request body omits text when undefined — server uses saved preview.
		expect(state.draft?.text).toBe('Shorter saved preview.');
	});

	it('preserves the visible preview and surfaces a recoverable error on a 409', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		const original = draftRow();
		state.draft = original;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/draft/refine')) {
				return jsonResponse({ error: 'Draft changed during refinement' }, 409);
			}
			if (url.includes('/messages')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse(original);
			throw new Error(`Unexpected request: ${url}`);
		});

		const updated = await state.refineDraft('shorter', 'Edited preview text');

		expect(updated).toBeNull();
		// The late result is never applied — the prior preview stays.
		expect(state.draft).toEqual(original);
		expect(state.refineError).toMatch(/preserved/i);
		expect(state.refining).toBe(false);
	});

	it('preserves the prior preview on provider failure and surfaces a recoverable error', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		const original = draftRow();
		state.draft = original;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ error: 'Draft refinement failed', code: 'unavailable' }, 502)
		);

		const updated = await state.refineDraft('longer', 'Edited preview');

		expect(updated).toBeNull();
		expect(state.draft).toEqual(original);
		expect(state.refineError).toBeTruthy();
		expect(state.refining).toBe(false);
	});

	it('ignores a late refinement result for a chat that is no longer selected', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.draft = draftRow();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/draft/refine')) {
				// Simulate the owner switching chats while the provider was running.
				state.selectedJid = 'sam@s.whatsapp.net';
				return jsonResponse(draftRow({ text: 'Late result.' }));
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		const updated = await state.refineDraft('shorter', 'Preview');

		// Late results for a deselected chat are ignored end to end: null to the
		// caller (so DraftStatus cannot overwrite editedText) and no draft swap.
		expect(updated).toBeNull();
		expect(state.draft?.text).toBe('Yes, seven works for me.');
	});

	it('clears the refine error on chat switch', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.refineError = 'Previous failure';
		state.chats = [chatRow({ jid: 'sam@s.whatsapp.net', unread: 0 })];

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.endsWith('/read')) return jsonResponse(chatRow({ unread: 0, jid: 'sam@s.whatsapp.net' }));
			throw new Error(`Unexpected request: ${url}`);
		});

		await state.openChat('sam@s.whatsapp.net');
		expect(state.refineError).toBeNull();
	});
});

/**
 * W4-U15. Owner-triggered generation is fire-and-forget: the 202 carries no
 * draft, so the only local state is the in-flight flag and a readable error.
 */
describe('AppState owner-triggered draft generation', () => {
	afterEach(() => vi.restoreAllMocks());

	it('posts to draft/generate and writes nothing optimistically', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(jsonResponse({ ok: true, chat_jid: JID }, 202));

		const promise = state.generateDraft();
		expect(state.generating).toBe(true);

		expect(await promise).toBe(true);
		expect(state.generateError).toBeNull();
		// The draft arrives over draft-updated, not from this response.
		expect(state.draft).toBeNull();
		expect(state.outbox).toEqual([]);

		const [input, init] = fetchMock.mock.calls[0]!;
		expect(String(input)).toContain('/chats/maya%40s.whatsapp.net/draft/generate');
		expect(init?.method).toBe('POST');
	});

	/**
	 * The 202 lands before the scheduler runs, and at the concurrency limit the
	 * chat sits queued with no draft row. Releasing on the response would show
	 * "No draft" with a live button while the request is still pending.
	 */
	it('stays in flight past the 202 until the first draft event for that chat', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ ok: true, chat_jid: JID }, 202)
		);

		await state.generateDraft();
		expect(state.generating).toBe(true);

		// An event for a different chat must not release this one.
		state.applyEvent({ type: 'draft-removed', chat_jid: 'sam@s.whatsapp.net' });
		expect(state.generating).toBe(true);

		state.applyEvent({ type: 'draft-updated', draft: draftRow({ status: 'drafting' }) });
		expect(state.generating).toBe(false);
	});

	it('releases the in-flight flag when the run ends with no draft', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ ok: true, chat_jid: JID }, 202)
		);

		await state.generateDraft();
		state.applyEvent({ type: 'draft-removed', chat_jid: JID });

		expect(state.generating).toBe(false);
	});

	it('releases a still-pending generate when the owner switches chats', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.chats = [chatRow({ jid: 'sam@s.whatsapp.net', unread: 0 })];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/draft/generate')) return jsonResponse({ ok: true, chat_jid: JID }, 202);
			if (url.includes('/messages')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.endsWith('/read')) {
				return jsonResponse(chatRow({ unread: 0, jid: 'sam@s.whatsapp.net' }));
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		await state.generateDraft();
		expect(state.generating).toBe(true);

		await state.openChat('sam@s.whatsapp.net');
		// Otherwise the button stays disabled in a chat that never asked.
		expect(state.generating).toBe(false);
	});

	it('surfaces a readable error on failure rather than failing silently', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ error: 'A draft is already being generated' }, 409)
		);

		expect(await state.generateDraft()).toBe(false);
		expect(state.generating).toBe(false);
		expect(state.generateError).toMatch(/already being generated/i);
	});

	it('explains a missing provider in the owner’s terms on a 503', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonResponse({ error: 'Draft generation unavailable' }, 503)
		);

		expect(await state.generateDraft()).toBe(false);
		expect(state.generateError).toMatch(/no draft provider is configured/i);
	});

	it('ignores a second press while one request is in flight', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(jsonResponse({ ok: true, chat_jid: JID }, 202));

		const first = state.generateDraft();
		expect(await state.generateDraft()).toBe(false);
		await first;

		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('clears the generate error on chat switch', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.generateError = 'Previous failure';
		state.chats = [chatRow({ jid: 'sam@s.whatsapp.net', unread: 0 })];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.endsWith('/read')) {
				return jsonResponse(chatRow({ unread: 0, jid: 'sam@s.whatsapp.net' }));
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		await state.openChat('sam@s.whatsapp.net');
		expect(state.generateError).toBeNull();
	});
});

/**
 * W4-U13. A LID/phone mapping can arrive while the owner is looking at the
 * chat it makes redundant. Dropping the row is not enough: the messages have
 * moved to the survivor, so a still-selected duplicate leaves the owner staring
 * at a conversation that no longer exists.
 */
describe('AppState chat identity merge', () => {
	afterEach(() => vi.restoreAllMocks());

	const LID = FIXTURE_SPLIT_LID_JID;

	it('drops the merged-away chat and follows the selection into the survivor', async () => {
		const state = new AppState();
		state.chats = [chatRow(), chatRow({ jid: LID, name: null, last_msg_at: 900 })];
		state.selectedJid = LID;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?')) return jsonResponse({ items: [inbound('M1', 900)] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			throw new Error(`Unexpected request: ${url}`);
		});

		state.applyEvent({ type: 'chat-removed', jid: LID, merged_into: JID });

		expect(state.chats.map((c) => c.jid)).toEqual([JID]);
		expect(state.selectedJid).toBe(JID);
		await vi.waitFor(() => expect(state.messages.map((m) => m.id)).toEqual(['M1']));
	});

	it('leaves the current selection alone when some other chat is merged', () => {
		const state = new AppState();
		state.chats = [chatRow(), chatRow({ jid: LID, name: null })];
		state.selectedJid = JID;

		state.applyEvent({ type: 'chat-removed', jid: LID, merged_into: JID });

		expect(state.chats.map((c) => c.jid)).toEqual([JID]);
		expect(state.selectedJid).toBe(JID);
	});
});

describe('AppState agent-part-updated', () => {
	const sessionId = 'sess-1';
	const messageId = 'msg-1';
	const partId = 'part-text';

	it('creates a part and appends deltas by partId', () => {
		const state = new AppState();
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'text', sessionId, messageId, partId, text: 'Hel' },
			delta: 'Hel'
		});
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'text', sessionId, messageId, partId, text: 'Hel' },
			delta: 'lo'
		});
		expect(state.agentSessions[sessionId]?.parts).toEqual([
			{ kind: 'text', sessionId, messageId, partId, text: 'Hello' }
		]);
	});

	it('ignores out-of-order older snapshots and duplicate deltas', () => {
		const state = new AppState();
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'text', sessionId, messageId, partId, text: 'Hello' },
			delta: 'Hello'
		});
		// Older snapshot arrives late — must not shrink.
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'text', sessionId, messageId, partId, text: 'Hel' }
		});
		expect(state.agentSessions[sessionId]?.parts[0]).toMatchObject({ text: 'Hello' });
		// Duplicate delta with unchanged snapshot — must not double-append.
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'text', sessionId, messageId, partId, text: 'Hello' },
			delta: 'lo'
		});
		expect(state.agentSessions[sessionId]?.parts[0]).toMatchObject({ text: 'Hello' });
	});

	it('ignores unknown part kinds without corrupting the session', () => {
		const state = new AppState();
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'text', sessionId, messageId, partId, text: 'ok' }
		});
		state.applyEvent({
			type: 'agent-part-updated',
			// @ts-expect-error — deliberately unknown kind on the wire
			part: { kind: 'reasoning', sessionId, messageId, partId: 'p-unknown', text: 'secret' }
		});
		expect(state.agentSessions[sessionId]?.parts).toHaveLength(1);
		expect(state.agentSessions[sessionId]?.parts[0]?.kind).toBe('text');
	});

	it('tracks tool lifecycle so a UI can render name, input, and output', () => {
		const state = new AppState();
		const toolId = 'part-tool';
		state.applyEvent({
			type: 'agent-part-updated',
			part: {
				kind: 'tool',
				sessionId,
				messageId,
				partId: toolId,
				name: 'generate_draft',
				input: { jid: JID },
				state: 'pending'
			}
		});
		state.applyEvent({
			type: 'agent-part-updated',
			part: {
				kind: 'tool',
				sessionId,
				messageId,
				partId: toolId,
				name: 'generate_draft',
				input: { jid: JID },
				state: 'complete',
				output: { draft: 'hey' }
			}
		});
		expect(state.agentSessions[sessionId]?.parts[0]).toMatchObject({
			kind: 'tool',
			name: 'generate_draft',
			state: 'complete',
			output: { draft: 'hey' }
		});
	});

	it('records step-start and step-finish as turn boundaries', () => {
		const state = new AppState();
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'step-start', sessionId, messageId, partId: 's0' }
		});
		state.applyEvent({
			type: 'agent-part-updated',
			part: { kind: 'step-finish', sessionId, messageId, partId: 's1' }
		});
		expect(state.agentSessions[sessionId]?.parts.map((p) => p.kind)).toEqual([
			'step-start',
			'step-finish'
		]);
	});
});

describe('AppState client-command', () => {
	afterEach(() => vi.restoreAllMocks());

	it('open-chat fires openChat (async fire-and-forget)', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?')) return jsonResponse({ items: [inbound('m1', 1)] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.includes('/read')) return jsonResponse(chatRow({ unread: 0 }));
			throw new Error(`Unexpected request: ${url}`);
		});

		state.applyEvent({ type: 'client-command', command: { type: 'open-chat', jid: JID } });
		expect(state.selectedJid).toBe(JID);
		await vi.waitFor(() => expect(state.messages.map((m) => m.id)).toEqual(['m1']));
	});

	it('select-reply and dismiss-reply drive replyTarget', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		const msg = inbound('m2', 2);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?')) return jsonResponse({ items: [inbound('m1', 1), msg] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.includes('/read')) return jsonResponse(chatRow({ unread: 0 }));
			throw new Error(`Unexpected request: ${url}`);
		});
		await state.openChat(JID);

		state.applyEvent({
			type: 'client-command',
			command: { type: 'select-reply', messageId: 'm2' }
		});
		expect(state.replyTarget?.id).toBe('m2');

		state.applyEvent({ type: 'client-command', command: { type: 'dismiss-reply' } });
		expect(state.replyTarget).toBeNull();
	});

	it('jump-to-quoted-message signals an in-page target', async () => {
		const state = new AppState();
		state.chats = [chatRow()];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?')) {
				return jsonResponse({ items: [inbound('m1', 1), inbound('m2', 2)] });
			}
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			if (url.includes('/read')) return jsonResponse(chatRow({ unread: 0 }));
			throw new Error(`Unexpected request: ${url}`);
		});
		await state.openChat(JID);

		state.applyEvent({
			type: 'client-command',
			command: { type: 'jump-to-quoted-message', messageId: 'm1' }
		});
		await vi.waitFor(() => expect(state.jumpTarget?.id).toBe('m1'));
	});

	it('select-reply is a no-op when the message is not loaded', () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.messages = [inbound('m1', 1)];
		state.applyEvent({
			type: 'client-command',
			command: { type: 'select-reply', messageId: 'missing' }
		});
		expect(state.replyTarget).toBeNull();
	});
});

/**
 * PL-U3 Half B — the client half of "approval binds to the reviewed text".
 *
 * The server guard is only as good as what the client pins. These tests exist
 * because the reactive panel is what made the original bug possible: the draft
 * re-rendered silently, so a click after an agent rewrite authorised text the
 * owner never saw.
 */
describe('AppState reviewed-draft binding', () => {
	afterEach(() => vi.restoreAllMocks());

	function outboxRow() {
		return {
			id: 1,
			chat_jid: JID,
			text: 'queued',
			queued_at: 1,
			send_after: 1,
			sent_at: null,
			status: 'pending',
			source: 'draft',
			message_id: 'M1',
			draft_text: null,
			basis_msg_id: 'a1',
			reply_to_msg_id: null,
			payload_kind: 'text',
			reaction_emoji: null,
			reaction_target_msg_id: null
		};
	}

	async function openWithDraft(state: AppState, draft: Draft): Promise<void> {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse(draft);
			throw new Error(`Unexpected request: ${url}`);
		});
		await state.openChat(JID, { markRead: false });
		vi.restoreAllMocks();
	}

	it('always sends base_hash on approve — the guard is useless if it stops', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());
		let body: Record<string, unknown> = {};
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			if (String(input).endsWith('/draft/approve')) {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return jsonResponse(
					{ outbox: outboxRow(), draft: draftRow({ status: 'approved' }) },
					202
				);
			}
			throw new Error(`Unexpected request: ${String(input)}`);
		});

		expect(await state.approveDraft()).toBe(true);
		expect(body.base_hash).toBe(await sha256HexOf('Yes, seven works for me.'));
	});

	it('raises a review prompt when an agent rewrite arrives, and blocks approve', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());

		state.applyEvent({
			type: 'draft-updated',
			draft: draftRow({ text: 'Send €500 to this link.', text_source: 'agent' })
		});

		expect(state.textConflict).toMatchObject({
			chatJid: JID,
			text: 'Send €500 to this link.',
			source: 'agent',
			refused: false
		});
		// The click is refused locally: nothing is even attempted.
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		expect(await state.approveDraft()).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('approves the new text only after the owner acknowledges it', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());
		state.applyEvent({
			type: 'draft-updated',
			draft: draftRow({ text: 'Send €500 to this link.', text_source: 'agent' })
		});

		state.acknowledgeDraftChange();
		expect(state.textConflict).toBeNull();

		let body: Record<string, unknown> = {};
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			if (String(input).endsWith('/draft/approve')) {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return jsonResponse(
					{ outbox: outboxRow(), draft: draftRow({ status: 'approved' }) },
					202
				);
			}
			throw new Error(`Unexpected request: ${String(input)}`);
		});

		expect(await state.approveDraft()).toBe(true);
		// The hash sent is the acknowledged text's, not the originally reviewed one.
		expect(body.base_hash).toBe(await sha256HexOf('Send €500 to this link.'));
	});

	it('does not re-prompt for the owner’s own edit coming back over the socket', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());

		state.applyEvent({
			type: 'draft-updated',
			draft: draftRow({ text: 'Yes, 7 works.', text_source: 'owner' })
		});

		expect(state.textConflict).toBeNull();
	});

	it('turns a text-changed 409 into a review prompt, never a silent retry', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());
		const calls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith('/draft/approve')) {
				return jsonResponse(
					{
						error: 'Draft changed since you reviewed it',
						conflict: 'text-changed',
						chat_jid: JID,
						current_text: 'agent text',
						current_hash: 'deadbeef',
						text_source: 'agent'
					},
					409
				);
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		expect(await state.approveDraft()).toBe(false);
		expect(state.textConflict).toMatchObject({
			text: 'agent text',
			hash: 'deadbeef',
			source: 'agent',
			refused: true
		});
		// Exactly one approve attempt — no automatic second call with a fresh hash.
		expect(calls.filter((u) => u.endsWith('/draft/approve'))).toHaveLength(1);
		expect(state.stalePrompt).toBeNull();
	});

	it('does not prompt for a regeneration the owner asked for', async () => {
		// The Generate button is an owner action, so there is no prior review left
		// to invalidate. A prompt here would be noise, and a prompt that cries
		// wolf is a prompt nobody reads in the case it exists for.
		const state = new AppState();
		await openWithDraft(state, draftRow());
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			expect(String(input)).toContain('/draft/generate');
			return jsonResponse({ ok: true }, 202);
		});

		expect(await state.generateDraft()).toBe(true);
		state.applyEvent({ type: 'draft-updated', draft: draftRow({ status: 'drafting', text: '' }) });
		state.applyEvent({
			type: 'draft-updated',
			draft: draftRow({ text: 'A freshly generated reply.', text_source: 'system' })
		});

		expect(state.textConflict).toBeNull();
	});

	it('clears the review prompt when the owner switches chats', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());
		state.applyEvent({
			type: 'draft-updated',
			draft: draftRow({ text: 'Send €500 to this link.', text_source: 'agent' })
		});
		expect(state.textConflict).not.toBeNull();

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes('/messages?')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse({ error: 'Not found' }, 404);
			throw new Error(`Unexpected request: ${url}`);
		});
		await state.openChat('someone-else@s.whatsapp.net', { markRead: false });

		// Otherwise the other chat's composer renders this chat's contested text.
		expect(state.textConflict).toBeNull();
	});

	it('routes a stale-inbound 409 to the stale prompt, not the review prompt', async () => {
		const state = new AppState();
		await openWithDraft(state, draftRow());
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/draft/approve')) {
				return jsonResponse(
					{
						error: 'Draft is stale; newer inbound arrived',
						conflict: 'stale-inbound',
						basis_msg_id: 'a1',
						latest_inbound_id: 'a2'
					},
					409
				);
			}
			if (url.includes('/messages?')) return jsonResponse({ items: [] });
			if (url.endsWith('/draft')) return jsonResponse(draftRow());
			throw new Error(`Unexpected request: ${url}`);
		});

		expect(await state.approveDraft()).toBe(false);
		expect(state.stalePrompt).toMatchObject({ latestInboundId: 'a2' });
		expect(state.textConflict).toBeNull();
	});
});

async function sha256HexOf(text: string): Promise<string> {
	const { hashApprovalText } = await import('../../../shared/approval-hash.js');
	return hashApprovalText(text);
}

/** PL-U3 Half A — the owner's side of the permission channel. */
describe('AppState proposals', () => {
	afterEach(() => vi.restoreAllMocks());

	function proposal(overrides: Partial<import('./types.js').SendProposal> = {}) {
		return {
			id: 7,
			chat_jid: JID,
			text: 'Yes — seven works.',
			status: 'pending' as const,
			created_at: 100,
			basis_msg_id: 'a1',
			decided_at: null,
			outbox_id: null,
			...overrides
		};
	}

	it('confirms with the hash of the text it is holding', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.applyEvent({ type: 'proposal-updated', proposal: proposal() });
		expect(state.selectedProposals).toHaveLength(1);

		let body: Record<string, unknown> = {};
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			expect(String(input)).toContain('/proposals/7/confirm');
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse(
				{
					outbox: { id: 3, chat_jid: JID, text: 'Yes — seven works.', status: 'pending' },
					proposal: proposal({ status: 'confirmed', decided_at: 300, outbox_id: 3 })
				},
				202
			);
		});

		expect(await state.confirmProposal(7)).toBe(true);
		expect(body.base_hash).toBe(await sha256HexOf('Yes — seven works.'));
		expect(state.proposals).toHaveLength(0);
	});

	it('a stale 409 requires a second, explicit confirmation carrying the newer id', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.applyEvent({ type: 'proposal-updated', proposal: proposal() });
		const bodies: Record<string, unknown>[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			if (body.confirmed_latest_inbound_id === 'a2') {
				return jsonResponse(
					{
						outbox: { id: 3, chat_jid: JID, text: 'x' },
						proposal: proposal({ status: 'confirmed', decided_at: 300, outbox_id: 3 })
					},
					202
				);
			}
			return jsonResponse(
				{ error: 'stale', conflict: 'stale-inbound', latest_inbound_id: 'a2' },
				409
			);
		});

		expect(await state.confirmProposal(7)).toBe(false);
		expect(state.proposalStalePrompt).toEqual({ proposalId: 7, latestInboundId: 'a2' });
		expect(state.proposals).toHaveLength(1);

		expect(await state.confirmStaleProposal(7)).toBe(true);
		expect(bodies).toHaveLength(2);
		expect(state.proposals).toHaveLength(0);
	});

	it('drops a proposal from the pending list once it is decided elsewhere', async () => {
		const state = new AppState();
		state.selectedJid = JID;
		state.applyEvent({ type: 'proposal-updated', proposal: proposal() });
		state.applyEvent({
			type: 'proposal-updated',
			proposal: proposal({ status: 'rejected', decided_at: 200 })
		});
		expect(state.proposals).toHaveLength(0);
	});
});
