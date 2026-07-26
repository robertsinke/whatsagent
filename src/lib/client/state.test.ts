import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from './state.svelte.js';
import type { Chat, Draft, Message } from './types.js';
import { deriveUnreadBoundaryFromCursor } from './view.js';

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
