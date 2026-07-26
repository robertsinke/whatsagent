import {
	ApiError,
	type Chat,
	type Draft,
	type Message,
	type OutboxRow,
	type SessionView
} from './types.js';

/**
 * Same-origin REST client. In production the Node backend serves this bundle,
 * so `/api/...` is literally the same origin; in `vite dev` the proxy in
 * vite.config.ts forwards it (and rewrites Origin for the CSRF check).
 *
 * R9: nothing here reaches WhatsApp. Composer sends and draft approvals both
 * return outbox rows — the outbox pacer is the only sender.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`/api${path}`, {
		...init,
		headers: {
			...(init.body ? { 'Content-Type': 'application/json' } : {}),
			...init.headers
		}
	});

	if (!response.ok) {
		let body: Record<string, unknown> = {};
		try {
			body = (await response.json()) as Record<string, unknown>;
		} catch {
			// Non-JSON error body — the status is the signal.
		}
		throw new ApiError(
			response.status,
			typeof body.error === 'string' ? body.error : response.statusText,
			body
		);
	}

	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export type ChatFilter = 'all' | 'needs-reply' | 'groups';

export const api = {
	session: () => request<SessionView>('/session'),

	/** Re-pair: regenerate an expired QR, or start over after `logged_out`. */
	regeneratePairing: () => request<{ ok: true }>('/session/pair', { method: 'POST' }),

	chats: (filter: ChatFilter = 'all') =>
		request<{ items: Chat[] }>(`/chats?filter=${filter}`).then((r) => r.items),

	chat: (jid: string) => request<Chat>(`/chats/${encodeURIComponent(jid)}`),

	messages: (jid: string, options: { limit?: number; beforeTs?: number; beforeId?: string } = {}) => {
		const params = new URLSearchParams();
		if (options.limit) params.set('limit', String(options.limit));
		if (options.beforeTs !== undefined) params.set('beforeTs', String(options.beforeTs));
		if (options.beforeId) params.set('beforeId', options.beforeId);
		const query = params.toString();
		return request<{ items: Message[] }>(
			`/chats/${encodeURIComponent(jid)}/messages${query ? `?${query}` : ''}`
		).then((r) => r.items);
	},

	/** Composer send → outbox row. Never a direct socket send (R9). */
	send: (jid: string, text: string, replyToMsgId?: string) =>
		request<OutboxRow>(`/chats/${encodeURIComponent(jid)}/messages`, {
			method: 'POST',
			body: JSON.stringify({
				text,
				...(replyToMsgId ? { reply_to_msg_id: replyToMsgId } : {})
			})
		}),

	markRead: (jid: string) =>
		request<Chat>(`/chats/${encodeURIComponent(jid)}/read`, { method: 'POST' }),

	/**
	 * Owner-triggered on-demand history deepen. Asks the phone for older
	 * messages via Baileys `fetchMessageHistory` (server route POST
	 * `/api/chats/:jid/history/deepen`). Returns 202 on acceptance; ingestion
	 * arrives over WS as normal `message-new`/`sync-progress` events. Read-only
	 * for the client — this never sends anything to WhatsApp recipients and is
	 * gated to disconnected/eligible states on the server.
	 */
	deepenHistory: (jid: string, count?: number) =>
		request<{ ok: true }>(`/chats/${encodeURIComponent(jid)}/history/deepen`, {
			method: 'POST',
			body: JSON.stringify(count === undefined ? {} : { count })
		}),

	draft: (jid: string) => request<Draft>(`/chats/${encodeURIComponent(jid)}/draft`),

	editDraft: (jid: string, text: string) =>
		request<Draft>(`/chats/${encodeURIComponent(jid)}/draft`, {
			method: 'PATCH',
			body: JSON.stringify({ text })
		}),

	/**
	 * Approve → outbox. Throws `ApiError` with status 409 when the server has
	 * newer inbound than the draft's basis message; the caller must re-confirm
	 * rather than send. Staleness is never inferred client-side.
	 */
	approveDraft: (jid: string, text?: string, confirmedLatestInboundId?: string) =>
		request<{ outbox: OutboxRow; draft: Draft }>(
			`/chats/${encodeURIComponent(jid)}/draft/approve`,
			{
				method: 'POST',
				body: JSON.stringify({
					...(text === undefined ? {} : { text }),
					...(confirmedLatestInboundId
						? { confirmed_latest_inbound_id: confirmedLatestInboundId }
						: {})
				})
			}
		),

	skipDraft: (jid: string) =>
		request<{ ok: true; chat: Chat }>(`/chats/${encodeURIComponent(jid)}/draft/skip`, {
			method: 'POST'
		}),

	outbox: () => request<{ items: OutboxRow[] }>('/outbox').then((r) => r.items),

	cancelOutbox: (id: number) => request<OutboxRow>(`/outbox/${id}`, { method: 'DELETE' }),

	/** D2: on-demand only — nothing prefetches media. */
	loadMedia: (messageId: string) =>
		request<Message>(`/messages/${encodeURIComponent(messageId)}/media`, { method: 'POST' }),

	mediaUrl: (messageId: string) => `/api/messages/${encodeURIComponent(messageId)}/media`,

	settings: () => request<Record<string, string>>('/settings'),

	setSetting: (key: string, value: string) =>
		request<{ key: string; value: string }>('/settings', {
			method: 'PUT',
			body: JSON.stringify({ key, value })
		})
};
