import {
	ApiError,
	type AgentCancelResult,
	type AgentClearResult,
	type AgentStatus,
	type CalendarProposal,
	type CancellationNotice,
	type Chat,
	type Draft,
	type Message,
	type OutboxRow,
	type ProvidersResponse,
	type RefinementIntent,
	type SendProposal,
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

	/**
	 * Read a chat's messages. Without `focusMsgId`, the GET dispatches the
	 * `get-messages` registry action (PANEL-S12) — same definition the agent
	 * tool uses. With `focusMsgId`, the server keeps the direct store read:
	 * quote-jump is view-local and deliberately not on the action.
	 */
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
	 * PANEL-S7 — dispatch the `open-chat` registry action. The server emits a
	 * `focus-chat` event over the WebSocket, which the client reducer routes
	 * into `AppState.openChat` (load-only, never marks read). The owner's click
	 * then dispatches `mark-read` separately, so loading and marking read are
	 * two independent registry actions rather than one fused client call.
	 */
	openChat: (jid: string) =>
		request<{ jid: string; name: string | null }>(
			`/chats/${encodeURIComponent(jid)}/open`,
			{ method: 'POST' }
		),

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
	 * Approve → outbox. Throws `ApiError` with status 409 in two distinct cases,
	 * told apart by `body.conflict`: `stale-inbound` (newer inbound than the
	 * draft's basis message) and `text-changed` (the stored draft is no longer
	 * the text `baseHash` was taken from). Neither is ever inferred client-side,
	 * and neither may be retried automatically.
	 *
	 * `baseHash` is the hash of the draft text the owner *reviewed*, which is
	 * not necessarily the `text` being sent — the owner may have rewritten it.
	 */
	approveDraft: (
		jid: string,
		text?: string,
		confirmedLatestInboundId?: string,
		baseHash?: string
	) =>
		request<{ outbox: OutboxRow; draft: Draft }>(
			`/chats/${encodeURIComponent(jid)}/draft/approve`,
			{
				method: 'POST',
				body: JSON.stringify({
					...(text === undefined ? {} : { text }),
					...(confirmedLatestInboundId
						? { confirmed_latest_inbound_id: confirmedLatestInboundId }
						: {}),
					...(baseHash ? { base_hash: baseHash } : {})
				})
			}
		),

	/**
	 * PL-U7 — whether the agent panel can run at all. The panel needs the `/mcp`
	 * surface, which ships off by default and is NOT enabled implicitly, so this
	 * is how the composer knows whether to be usable. `available: false` is a
	 * normal configuration, not an error.
	 */
	agentStatus: () => request<AgentStatus>('/agent/status'),

	/**
	 * PL-U7 — start a turn. 202 with correlation ids; the transcript arrives over
	 * the WebSocket as `agent-part-updated`, so there is nothing to apply here.
	 * A 409 means a turn is already running — refused, never queued.
	 */
	agentTurn: (text: string) =>
		request<{ status: 'running'; session_id: string; message_id: string; harness: string }>(
			'/agent/turn',
			{ method: 'POST', body: JSON.stringify({ text }) }
		),

	/** PL-U7 — stop the running turn. Idempotent: no turn is a 200, not an error. */
	cancelAgentTurn: () => request<AgentCancelResult>('/agent/cancel', { method: 'POST' }),

	/** PANEL-S3 — wipe the panel transcript (cancels first if a turn is running). */
	clearAgentPanel: () => request<AgentClearResult>('/agent/clear', { method: 'POST' }),

	/** PL-U3 — pending proposals, for the first paint after a reload. */
	proposals: () => request<{ items: SendProposal[] }>('/proposals'),

	/**
	 * PL-U3 — the owner's confirmation. This is the call that creates the outbox
	 * row for an agent-proposed send; `base_hash` is mandatory, so a proposal
	 * cannot be confirmed without naming the text that was on screen.
	 */
	confirmProposal: (id: number, baseHash: string, confirmedLatestInboundId?: string) =>
		request<{ outbox: OutboxRow; proposal: SendProposal }>(`/proposals/${id}/confirm`, {
			method: 'POST',
			body: JSON.stringify({
				base_hash: baseHash,
				...(confirmedLatestInboundId
					? { confirmed_latest_inbound_id: confirmedLatestInboundId }
					: {})
			})
		}),

	rejectProposal: (id: number) =>
		request<{ proposal: SendProposal }>(`/proposals/${id}/reject`, { method: 'POST' }),

	/** CAL-2 — pending calendar proposals for first paint after a reload. */
	calendarProposals: () => request<{ items: CalendarProposal[] }>('/calendar/proposals'),

	/**
	 * CAL-2 — owner's confirmation. This is the call that PUTs the VEVENT to
	 * Google; `base_hash` is mandatory so a proposal cannot be confirmed without
	 * naming the payload that was on screen.
	 */
	confirmCalendarProposal: (id: number, baseHash: string) =>
		request<{ proposal: CalendarProposal; google_event_id: string }>(
			`/calendar/proposals/${id}/confirm`,
			{
				method: 'POST',
				body: JSON.stringify({ base_hash: baseHash })
			}
		),

	rejectCalendarProposal: (id: number) =>
		request<{ proposal: CalendarProposal }>(`/calendar/proposals/${id}/reject`, {
			method: 'POST'
		}),

	/** PL-U5 — open cancellation notices (agent undid an owner-approved send). */
	cancellationNotices: () =>
		request<{ items: CancellationNotice[] }>('/cancellation-notices'),

	dismissCancellationNotice: (id: number) =>
		request<{ notice: CancellationNotice }>(`/cancellation-notices/${id}/dismiss`, {
			method: 'POST'
		}),

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
	 * ONB-1 — run the vendor's pinned installer for Claude Code or OpenCode.
	 * Frontend-only on the server. The UI must show `command` before calling.
	 */
	installProvider: (provider: 'claude' | 'codex') =>
		request<{
			ok: boolean;
			provider: 'claude' | 'codex';
			command: string;
			pinnedVersion: string;
			exitCode: number | null;
			output: string;
			installedVersion: string | null;
			error?: string;
		}>('/providers/install', {
			method: 'POST',
			body: JSON.stringify({ provider })
		}),

	/**
	 * CAL-1 — save or test Google Calendar CalDAV credentials (App Password).
	 * Frontend-only on the server. `mode: 'save'` encrypts then PROPFINDs via
	 * the decrypting accessor; `mode: 'test'` PROPFINDs without persisting.
	 */
	connectCalendar: (input: {
		serverUrl: string;
		email: string;
		password: string;
		mode: 'test' | 'save';
	}) =>
		request<{
			mode: 'test' | 'save';
			saved: boolean;
			ok: boolean;
			status: number;
			serverUrl: string;
			email: string;
		}>('/calendar/connect', {
			method: 'POST',
			body: JSON.stringify(input)
		}),

	/** CAL-1 — list calendar events in a range (same action the panel tool uses). */
	listCalendarEvents: (input: {
		start?: string;
		end?: string;
		limit?: number;
		offset?: number;
	} = {}) =>
		request<{
			items: Array<{
				uid: string;
				summary: string;
				start: string;
				end: string;
				location: string | null;
				allDay: boolean;
				recurrenceId: string | null;
			}>;
			total: number;
			offset: number;
			limit: number;
			has_more: boolean;
			range: { start: string; end: string };
		}>('/calendar/events', {
			method: 'POST',
			body: JSON.stringify(input)
		}),

	/**
	 * SEC-1 — re-measure a harness tool surface (Tier 1 by default).
	 * `deep: true` runs the decoy + positive-control path and spends a model call.
	 */
	verifyHarnessIsolation: (input: {
		harness: 'claude' | 'codex';
		surface?: 'drafting' | 'panel';
		deep?: boolean;
	}) =>
		request<{
			report: {
				harness: 'claude' | 'codex';
				binary: string;
				surface: 'drafting' | 'panel';
				tier: 1 | 2;
				tier1Strength: 'realized-surface' | 'resolved-config-only';
				pinnedVersion: string;
				detectedVersion: string | null;
				verdict: 'pass' | 'fail' | 'inconclusive' | 'unavailable';
				summary: string;
				checkedAt: number;
				findings: Array<{ code: string; detail: string }>;
			};
			store: Record<
				string,
				Partial<
					Record<
						'drafting' | 'panel',
						{
							verdict: string;
							summary: string;
							pinnedVersion: string;
							detectedVersion: string | null;
							checkedAt: number;
							tier1Strength?: string;
						}
					>
				>
			>;
		}>('/providers/verify-isolation', {
			method: 'POST',
			body: JSON.stringify(input)
		}),

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
		),

	/** PL-U5 — promote an agent voice suggestion into the document body. */
	promoteVoiceSuggestion: (id: string) =>
		request<VoicePromoteResponse>(`/voice/global/suggestions/${encodeURIComponent(id)}/promote`, {
			method: 'POST'
		}),

	/** PL-U5 — discard an agent voice suggestion without touching the document. */
	discardVoiceSuggestion: (id: string) =>
		request<{ suggestion: VoiceSuggestion; suggestions: VoiceSuggestion[] }>(
			`/voice/global/suggestions/${encodeURIComponent(id)}/discard`,
			{ method: 'POST' }
		)
};

export type VoiceSuggestion = {
	id: string;
	text: string;
	createdAt: string;
};

export type VoiceDocumentResponse = {
	stem: string;
	content: string | null;
	byteLength: number;
	modifiedAt: string | null;
	path: string;
	hash: string;
	mirrorGuard: boolean;
	suggestions: VoiceSuggestion[];
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

export type VoicePromoteResponse = {
	stem: string;
	suggestion: VoiceSuggestion;
	hash: string;
	byteLength: number;
	modifiedAt: string | null;
	mirrorGuard: boolean;
	content: string | null;
	suggestions: VoiceSuggestion[];
};
