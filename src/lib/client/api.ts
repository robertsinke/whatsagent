import {
	ApiError,
	type Chat,
	type Draft,
	type Message,
	type OutboxRow,
	type ProvidersResponse,
	type RefinementIntent,
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

	messages: (
		jid: string,
		options: { limit?: number; beforeTs?: number; beforeId?: string; focusMsgId?: string } = {}
	) => {
		const params = new URLSearchParams();
		if (options.limit) params.set('limit', String(options.limit));
		if (options.beforeTs !== undefined) params.set('beforeTs', String(options.beforeTs));
		if (options.beforeId) params.set('beforeId', options.beforeId);
		if (options.focusMsgId) params.set('focusMsgId', options.focusMsgId);
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
	 * `/api/chats/:jid/history/deepen`). Returns 202 on acceptance; the rows are
	 * ingested later from a `messaging-history.set` batch, which announces itself
	 * over WS as `sync-progress` only — never `message-new`. Read-only
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

	/**
	 * Preview-only draft refinement. Returns the updated draft; never enqueues
	 * an outbox row, writes memory feedback, or wakes the pacer. A 409 means the
	 * draft or inbound history changed while the provider was running — the
	 * caller must preserve the visible preview and reload current state rather
	 * than applying the late result. `text` is the displayed editor text when
	 * edit mode is open; omit it to refine the saved draft preview.
	 */
	refineDraft: (jid: string, intent: RefinementIntent, text?: string) =>
		request<Draft>(`/chats/${encodeURIComponent(jid)}/draft/refine`, {
			method: 'POST',
			body: JSON.stringify({
				intent,
				...(text === undefined ? {} : { text })
			})
		}),

	/**
	 * W4-U15 — owner-triggered draft generation. Accepted with 202; the draft
	 * itself arrives over the `draft-updated` socket events, so there is nothing
	 * to apply optimistically here. Never enqueues an outbox row or sends.
	 */
	generateDraft: (jid: string) =>
		request<{ ok: true; chat_jid: string }>(
			`/chats/${encodeURIComponent(jid)}/draft/generate`,
			{ method: 'POST' }
		),

	outbox: () => request<{ items: OutboxRow[] }>('/outbox').then((r) => r.items),

	cancelOutbox: (id: number) => request<OutboxRow>(`/outbox/${id}`, { method: 'DELETE' }),

	/** D2: on-demand only — nothing prefetches media. */
	loadMedia: (messageId: string) =>
		request<Message>(`/messages/${encodeURIComponent(messageId)}/media`, { method: 'POST' }),

	mediaUrl: (messageId: string) => `/api/messages/${encodeURIComponent(messageId)}/media`,

	/**
	 * D2 (Wave 3 U2): react to (or remove a reaction from) a message. Goes
	 * through the outbox pacer — a reaction is a Baileys sendMessage call, so
	 * R9 puts it on the same single send path as every other send. An empty
	 * emoji string removes a prior reaction.
	 */
	react: (messageId: string, emoji: string) =>
		request<OutboxRow>(`/messages/${encodeURIComponent(messageId)}/reactions`, {
			method: 'POST',
			body: JSON.stringify({ emoji })
		}),

	settings: () => request<Record<string, string>>('/settings'),

	setSetting: (key: string, value: string) =>
		request<{ key: string; value: string }>('/settings', {
			method: 'PUT',
			body: JSON.stringify({ key, value })
		}),

	/**
	 * OSS-P2.4: provider discovery snapshot. The response carries the merged
	 * provider list, what the running process built at boot (`active`), the
	 * persisted values (`saved`), and a server-derived `restartRequired` flag.
	 * `refresh: true` forces a full re-probe of binaries and the Ollama daemon.
	 */
	providers: () => request<ProvidersResponse>('/providers'),

	refreshProviders: () =>
		request<ProvidersResponse>('/providers?refresh=1'),

	/**
	 * W4-U8: outbox send-mode. `live: true` enables real WhatsApp sends through
	 * the pacer (after owner confirmation in the UI); `live: false` is the safe
	 * default and is never confirmed. Takes effect without a restart — the
	 * server pushes the change into the live pacer and emits a `send-mode` WS
	 * event so every open client updates its indicator.
	 */
	sendMode: () => request<{ live: boolean; dry_run: boolean }>('/outbox/send-mode'),

	setSendMode: (live: boolean) =>
		request<{ live: boolean; dry_run: boolean }>('/outbox/send-mode', {
			method: 'PUT',
			body: JSON.stringify({ live })
		}),

	/**
	 * W4-U10 / P3.2: the global voice document on disk — what drafting actually
	 * reads (D2). Returns content null with byteLength 0 when nothing has been
	 * learned yet. `hash` is the `baseHash` for the next {@link saveVoice}, and
	 * `mirrorGuard` is true while a previous hand edit is holding the Hindsight
	 * mirror off this document.
	 */
	voiceGlobal: () => request<VoiceDocumentResponse>('/voice/global'),

	/**
	 * P3.2: save a hand edit. `baseHash` is the `hash` from the load; a mismatch
	 * means the document moved underneath this editor and the server answers 409
	 * with the current document rather than overwriting it — so callers must
	 * handle a rejected request, not just a resolved one.
	 *
	 * The save arms the mirror guard, which is what makes the edit survive the
	 * 60-second mirror tick. `looksLikeVoiceDocument: false` in the response is a
	 * WARNING (the editor may have mangled the document's tables), never a sign
	 * the save failed.
	 */
	saveVoice: (content: string, baseHash: string, note?: string) =>
		request<VoiceSaveResponse>('/voice/global', {
			method: 'PUT',
			body: JSON.stringify(note === undefined ? { content, baseHash } : { content, baseHash, note })
		}),

	/**
	 * P3.2: ask the memory service to regenerate the voice models now. Refresh is
	 * asynchronous server-side — the regenerated document lands on a later mirror
	 * tick, not in this response. `available: false` (still a 200) means no memory
	 * service is wired; `error` non-null means one is and it did not answer.
	 */
	refreshVoice: () =>
		request<{ available: boolean; refreshed: string[]; error: string | null }>(
			'/voice/global/refresh',
			{ method: 'POST' }
		)
};

export type VoiceDocumentResponse = {
	stem: string;
	content: string | null;
	byteLength: number;
	modifiedAt: string | null;
	path: string;
	hash: string;
	mirrorGuard: boolean;
	memory: { available: boolean; mode: string };
};

export type VoiceSaveResponse = {
	stem: string;
	hash: string;
	byteLength: number;
	modifiedAt: string | null;
	mirrorGuard: boolean;
	looksLikeVoiceDocument: boolean;
	/** `recorded` — Hindsight took the correction. `skipped` — no memory service. `failed` — it did not answer; the file is saved regardless. */
	directive: 'recorded' | 'skipped' | 'failed';
};
