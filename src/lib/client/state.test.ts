import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from './state.svelte.js';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
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
