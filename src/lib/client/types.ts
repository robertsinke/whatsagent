/**
 * Wire types, mirroring `server/api/*`. Kept as a hand-written mirror rather
 * than importing from `server/` because `server/**` is outside the SvelteKit
 * tsconfig include and the SPA must not pull node-only modules into the bundle.
 */

export type ChatKind = '1:1' | 'group';

export type Chat = {
	jid: string;
	/** Display-only phone alias for LID-backed chats; `jid` remains the routing ID. */
	display_jid: string;
	channel: string;
	name: string | null;
	kind: ChatKind;
	last_msg_at: number | null;
	unread: number;
	muted: boolean;
	archived: boolean;
	agent_state: string | null;
	/**
	 * U4 — persistent local read cursor. Id of the last message the owner has
	 * read in this chat; `null` until the chat is first opened after migration
	 * 010 (or when the chat has no messages). The unread boundary is derived
	 * from this cursor, not the in-memory latch from W2-U1. LOCAL only — it
	 * never drives WhatsApp read receipts.
	 */
	last_read_msg_id: string | null;
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

/**
 * A participant, resolved server-side. `name` is already the best local name
 * with an honest JID fallback — the client never invents a display name, and
 * never claims a contact name the server did not resolve.
 */
export type IdentityView = {
	jid: string;
	/** Phone alias when known, otherwise the stable JID. */
	display_jid: string;
	name: string;
};

/**
 * Compact reply target. `resolved` is the server's verdict on whether the
 * target message exists locally; the client must not re-derive it by scanning
 * the loaded page, because the target is often outside the loaded window.
 */
export type QuoteView = {
	target_id: string;
	resolved: boolean;
	sender: IdentityView | null;
	type: string;
	text: string | null;
};

/** One emoji aggregated across actors. Display-only in this wave (no create/remove). */
export type ReactionView = {
	emoji: string;
	count: number;
	actors: IdentityView[];
};

export type Message = {
	id: string;
	chat_jid: string;
	channel: string;
	from_me: boolean;
	sender: IdentityView | null;
	ts: number;
	type: string;
	text: string | null;
	media: MediaView | null;
	quote: QuoteView | null;
	reactions: ReactionView[];
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

/**
 * Closed set of preview-only draft refinement intents. These mirror the
 * server's canonical wire values exactly (`server/providers/provider.ts`):
 * `regenerate`, `shorter`, `longer`, `more_formal`, `less_formal`. The client
 * must not invent additional intents — the server rejects anything outside
 * this set before invoking the provider.
 */
export type RefinementIntent =
	| 'regenerate'
	| 'shorter'
	| 'longer'
	| 'more_formal'
	| 'less_formal';

export type Draft = {
	chat_jid: string;
	text: string;
	status: DraftStatus;
	generated_at: number;
	provider: string | null;
	basis_msg_id: string | null;
	original_text: string;
};

export type OutboxRow = {
	id: number;
	chat_jid: string;
	text: string;
	queued_at: number;
	send_after: number;
	sent_at: number | null;
	status: string;
	source: 'draft' | 'manual';
	message_id: string | null;
	draft_text: string | null;
	basis_msg_id: string | null;
	/** Stored message id only; raw WhatsApp envelopes never cross this boundary. */
	reply_to_msg_id: string | null;
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
	/**
	 * A message whose *relationships* changed (reactions, resolved quote) —
	 * never a new message. The client replaces in place and never inserts, or a
	 * reaction on a message above the loaded window would splice a stranger into
	 * the middle of the stream.
	 */
	| { type: 'message-updated'; message: Message }
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
