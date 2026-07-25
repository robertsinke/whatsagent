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
