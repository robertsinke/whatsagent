import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from './state.svelte.js';
import type { Chat, Message } from './types.js';

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
		media: null
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
