/**
 * Wire types, mirroring `server/api/*`. Kept as a hand-written mirror rather
 * than importing from `server/` because `server/**` is outside the SvelteKit
 * tsconfig include and the SPA must not pull node-only modules into the bundle.
 */

export type ChatKind = '1:1' | 'group';

export type Chat = {
	jid: string;
	channel: string;
	name: string | null;
	kind: ChatKind;
	last_msg_at: number | null;
	unread: number;
	muted: boolean;
	archived: boolean;
	agent_state: string | null;
	/** Server verdict (deterministic classifier floor) — never re-derived here. */
	needs_reply: boolean;
	preview: string | null;
	preview_from_me: boolean;
	draft_status: DraftStatus | null;
};

/** D2 — persisted, never guessed client-side. */
export type MediaState = 'placeholder' | 'downloading' | 'ready' | 'failed';

/** `unavailable` is terminal (no retry); `transient` is retriable. */
export type MediaFailureReason = 'unavailable' | 'transient';

export type MediaView = {
	state: MediaState;
	error: MediaFailureReason | null;
	size: number | null;
	mime: string | null;
	filename: string | null;
	cached: boolean;
};

export type Message = {
	id: string;
	chat_jid: string;
	channel: string;
	from_me: boolean;
	sender: string | null;
	ts: number;
	type: string;
	text: string | null;
	media: MediaView | null;
};

/**
 * `stale` is computed by the server (newer inbound after `basis_msg_id`).
 * The client must never infer it — the approve endpoint's 409 is the other
 * authoritative signal.
 */
export type DraftStatus =
	| 'drafting'
	| 'ready'
	| 'stale'
	| 'failed'
	| 'skipped'
	| 'approved'
	| 'sent';

export type Draft = {
	chat_jid: string;
	text: string;
	status: DraftStatus;
	generated_at: number;
	provider: string | null;
	basis_msg_id: string | null;
};

export type OutboxRow = {
	id: number;
	chat_jid: string;
	text: string;
	queued_at: number;
	send_after: number;
	sent_at: number | null;
	status: string;
};

/** D5 — derived session view. */
export type SessionStatus =
	| 'initializing'
	| 'qr_pending'
	| 'qr_expired'
	| 'pairing'
	| 'syncing'
	| 'ready'
	| 'disconnected'
	| 'logged_out';

/** Indeterminate by construction: counts only, no total, no percentage. */
export type SyncView = {
	chatsSynced: number;
	messagesSynced: number;
	complete: boolean;
};

export type SessionView = {
	status: SessionStatus;
	qr: string | null;
	qrExpiresAt: number | null;
	sync: SyncView;
};

export type ServerEvent =
	| { type: 'message-new'; message: Message }
	| { type: 'chat-updated'; chat: Chat }
	| { type: 'draft-updated'; draft: Draft }
	| { type: 'draft-removed'; chat_jid: string }
	| { type: 'outbox-updated'; outbox: OutboxRow }
	| { type: 'connection'; state: string }
	| { type: 'pairing-needed'; qr: string }
	| { type: 'session'; session: SessionView }
	| {
			type: 'sync-progress';
			phase: string;
			chatsSynced: number;
			messagesSynced: number;
			complete: boolean;
	  };

/** Thrown by the API client; `status` carries the HTTP code (409 = stale draft). */
export class ApiError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;

	constructor(status: number, message: string, body: Record<string, unknown> = {}) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}
