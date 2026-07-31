/**
 * Wire types, mirroring `server/api/*`. Kept as a hand-written mirror rather
 * than importing from `server/` because `server/**` is outside the SvelteKit
 * tsconfig include and the SPA must not pull node-only modules into the bundle.
 */

// The provider-domain response shape lives in `shared/` so server validation
// and the client dropdown never drift apart — re-exported here so `api.ts`
// keeps its single-type-import convention.
export type {
	ProviderInfo,
	ProviderModelOption,
	ProvidersResponse,
	ProviderAuthState,
	ProviderUnavailableReason,
	ProviderPathSource,
	ActiveProviderInfo,
	SavedProviderInfo
} from '../../../shared/provider-types.js';
export type {
	AgentPart,
	AgentSessionView,
	ClientCommand
} from '../../../shared/agent-events.js';
import type { AgentPart, ClientCommand } from '../../../shared/agent-events.js';
export type { DraftTextSource } from '../../../shared/approval-hash.js';
import type { DraftTextSource } from '../../../shared/approval-hash.js';

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
	/** PL-U3 — who last wrote `text`; drives the re-confirmation copy. */
	text_source: DraftTextSource;
};

/**
 * PL-U7 — the agent panel runtime's own state. `available` is false whenever the
 * MCP surface is off, which is the default: the panel is unusable without tools
 * and says so rather than accepting turns that go nowhere.
 */
export type AgentStatus = {
	/**
	 * PANEL-S2 — the whole configuration answer. The Settings toggle reconciles
	 * the running panel in the same request, so "saved but not running yet" is
	 * no longer a state: this is either running now or not switched on.
	 */
	available: boolean;
	running: boolean;
	sessionId: string | null;
	messageId: string | null;
	harness: string | null;
};

/**
 * PANEL-S1 — what `POST /api/agent/cancel` actually returns: turn state only.
 * `available` is a configuration fact the cancel action has no access to, so it
 * is absent here rather than typed and undefined at runtime — the caller
 * preserves the one it already holds.
 */
export type AgentCancelResult = Omit<AgentStatus, 'available'> & {
	cancelled: boolean;
};

/** PANEL-S3 — wipe the in-memory panel transcript. */
export type AgentClearResult = Omit<AgentStatus, 'available'> & {
	cleared: boolean;
	cancelled: boolean;
	nextSessionId: string;
};

/**
 * PANEL-S6 — a proposal the agent asked for. It is not queued and never will be
 * unless the owner confirms it; `confirm-proposal` is frontend-only precisely
 * so that this row can only become an outbox row by way of a click.
 *
 * `kind` discriminates what would go on the wire: `send` (message text) or
 * `reaction` (emoji + target message). Reaction rows keep `text` empty.
 */
export type ProposalStatus = 'pending' | 'confirmed' | 'rejected';
export type ProposalKind = 'send' | 'reaction';

export type SendProposal = {
	id: number;
	chat_jid: string;
	kind: ProposalKind;
	text: string;
	reaction_emoji: string | null;
	reaction_target_msg_id: string | null;
	status: ProposalStatus;
	created_at: number;
	basis_msg_id: string | null;
	decided_at: number | null;
	outbox_id: number | null;
};

/**
 * CAL-2 — a calendar event the agent proposed. Inert until the owner confirms
 * via `confirm-calendar-event` (frontend-only). `chat_jid` is optional
 * provenance — unlike send proposals, an event need not belong to a chat.
 */
export type CalendarProposal = {
	id: number;
	summary: string;
	start: string;
	end: string;
	location: string | null;
	chat_jid: string | null;
	status: ProposalStatus;
	created_at: number;
	decided_at: number | null;
	google_event_id: string | null;
};

/**
 * PL-U5 — durable warning that the agent cancelled a message the owner had
 * already approved. `dismissed_at` is null while it still needs to be seen.
 */
export type CancellationNotice = {
	id: number;
	chat_jid: string;
	cancelled_text: string;
	created_at: number;
	dismissed_at: number | null;
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
	/** D2 (Wave 3 U2): `text` is an ordinary send, `reaction` is a react call. */
	payload_kind: 'text' | 'reaction';
	/** Emoji for reaction rows; empty string removes a reaction. Null on text rows. */
	reaction_emoji: string | null;
	/** Target message id for reaction rows. Null on text rows. */
	reaction_target_msg_id: string | null;
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
	/**
	 * W4-U13: `jid` turned out to be a second identity of `merged_into` (LID vs
	 * phone) and no longer exists server-side. Always preceded by a
	 * `chat-updated` for the survivor.
	 */
	| { type: 'chat-removed'; jid: string; merged_into: string }
	| { type: 'draft-updated'; draft: Draft }
	| { type: 'draft-removed'; chat_jid: string }
	/** PL-U3 — a proposed send appeared, or was confirmed/rejected by the owner. */
	| { type: 'proposal-updated'; proposal: SendProposal }
	/** CAL-2 — a proposed calendar event appeared, or was confirmed/rejected. */
	| { type: 'calendar-proposal-updated'; proposal: CalendarProposal }
	/**
	 * PL-U5 — the agent cancelled an approved send, or the owner dismissed that
	 * notice. Open notices are also refetched on hydrate.
	 */
	| { type: 'cancellation-notice'; notice: CancellationNotice }
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
	  }
	/**
	 * W4-U8: outbox send-mode flipped at runtime. `live: true` = the pacer
	 * transmits over WhatsApp; `live: false` (safe default) = rows are marked
	 * sent without reaching a recipient. Mirrors the server event so the
	 * topbar indicator and the settings toggle stay in sync without a refetch.
	 */
	| { type: 'send-mode'; live: boolean; dry_run: boolean }
	/** PL-A1 — streaming agent parts; see shared/agent-events.ts. */
	/**
	 * PL-U7 — the panel turn's own lifecycle, separate from its parts.
	 *
	 * Needed because "is a turn still running?" is not derivable from the parts.
	 * A turn can end without a `step-finish` (a harness that exits mid-step, a
	 * cancel, a spawn failure), and a turn's *first* part can arrive seconds after
	 * the owner pressed Enter. Inferring the state from step markers therefore
	 * either leaves the composer locked forever or unlocks it early; both are
	 * worse than one explicit event. `reason` is what the panel shows when a turn
	 * ended without finishing normally.
	 */
	| {
			type: 'agent-turn';
			phase: 'started' | 'finished';
			sessionId: string;
			messageId: string;
			harness: string;
			reason?: string;
	  }
	| { type: 'agent-part-updated'; part: AgentPart; delta?: string }
	/**
	 * PANEL-S4/S7 — focus a chat in the SPA without marking it read. Emitted by
	 * the `open-chat` registry action (both the agent tool surface and the
	 * owner's chat-list click). The reducer routes this into `openChat(jid)`,
	 * which is load-only; `mark-read` is a separate action the click dispatches
	 * next.
	 */
	| { type: 'focus-chat'; jid: string; name: string | null }
	/** PL-A1 — closed client-command set; see shared/agent-events.ts. */
	| { type: 'client-command'; command: ClientCommand };

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
