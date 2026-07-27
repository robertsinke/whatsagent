import type {
	Chat,
	DraftStatus,
	IdentityView,
	MediaView,
	Message,
	QuoteView,
	ReactionView,
	SessionStatus,
	SessionView
} from './types.js';

export type ChatTab = 'all' | 'needs-reply' | 'groups';

/** Row data the chat list renders. Pure — derived from a server-decided chat. */
export type ChatRowView = {
	jid: string;
	name: string;
	initials: string;
	preview: string;
	time: string;
	unread: number;
	needsReply: boolean;
	draftStatus: DraftStatus | null;
	muted: boolean;
};

const DAY_MS = 86_400_000;

function epochMilliseconds(ts: number): number {
	return ts > 0 && ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

/**
 * `display_jid` is server-supplied and always present in a `ChatView` — but this
 * runs inside Svelte effects, where a throw kills the *entire* reactive graph
 * (frozen chat list, dead selection), not just one row. So a chat that arrives
 * without it degrades to its routing jid instead of taking the app down.
 */
export function displayName(chat: Pick<Chat, 'jid' | 'display_jid' | 'name'>): string {
	if (chat.name && chat.name.trim()) return chat.name.trim();
	const jid = chat.display_jid || chat.jid || '';
	const local = jid.split('@')[0] || jid;
	return local.startsWith('+') ? local : `+${local}`;
}

/**
 * Every digit that identifies a chat, for phone-number search. Includes both
 * sides of a LID/phone identity pair, because the chat's own jid may be the lid
 * while the number the owner remembers lives on `display_jid` (or the reverse).
 */
export function jidDigits(chat: Pick<Chat, 'jid' | 'display_jid'>): string {
	const jids =
		chat.display_jid === chat.jid ? [chat.jid] : [chat.display_jid, chat.jid];
	// Same reasoning as `displayName`: never throw inside a render.
	return jids.map((jid) => (jid?.split('@')[0] ?? '').replace(/\D/g, '')).join(' ');
}

export function initialsFor(name: string): string {
	const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return '?';
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** WhatsApp-style relative stamp: time today, weekday this week, date beyond. */
export function formatChatTime(ts: number | null, now: number = Date.now()): string {
	if (!ts) return '';
	const normalizedTs = epochMilliseconds(ts);
	const then = new Date(normalizedTs);
	const today = new Date(now);
	const sameDay =
		then.getFullYear() === today.getFullYear() &&
		then.getMonth() === today.getMonth() &&
		then.getDate() === today.getDate();
	if (sameDay) {
		return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}
	if (now - normalizedTs < 2 * DAY_MS) return 'Yesterday';
	if (now - normalizedTs < 7 * DAY_MS) return then.toLocaleDateString(undefined, { weekday: 'short' });
	return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatMessageTime(ts: number): string {
	return new Date(epochMilliseconds(ts)).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function toChatRow(chat: Chat, now: number = Date.now()): ChatRowView {
	const name = displayName(chat);
	const preview = chat.preview?.trim() ?? '';
	return {
		jid: chat.jid,
		name,
		initials: initialsFor(name),
		preview: preview && chat.preview_from_me ? `You: ${preview}` : preview,
		time: formatChatTime(chat.last_msg_at, now),
		unread: chat.unread,
		needsReply: chat.needs_reply,
		draftStatus: chat.draft_status,
		muted: chat.muted
	};
}

export function filterChats(chats: Chat[], tab: ChatTab): Chat[] {
	if (tab === 'needs-reply') return chats.filter((c) => c.needs_reply);
	if (tab === 'groups') return chats.filter((c) => c.kind === 'group');
	return chats;
}

export function tabCounts(chats: Chat[]): Record<ChatTab, number> {
	return {
		all: chats.length,
		'needs-reply': chats.filter((c) => c.needs_reply).length,
		groups: chats.filter((c) => c.kind === 'group').length
	};
}

/** Newest-last ordering for the conversation pane, de-duplicated by id. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
	const byId = new Map(existing.map((m) => [m.id, m]));
	for (const message of incoming) byId.set(message.id, message);
	return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

/**
 * In-place replacement for a message already on screen. Unlike `mergeMessages`
 * this never inserts and never reorders: a relationship update (reaction, quote
 * resolution, media state) for a message outside the loaded window is dropped
 * rather than spliced into the middle of the stream.
 */
export function replaceMessage(existing: Message[], updated: Message): Message[] {
	const index = existing.findIndex((m) => m.id === updated.id);
	return index === -1 ? existing : existing.with(index, updated);
}

/**
 * The single "New" marker in an open conversation. `count` is the server's
 * unread count snapshotted *before* the chat was marked read — the client never
 * re-derives unread state, it only remembers what the server said on open.
 */
export type UnreadBoundary = {
	/** Id of the first unread inbound message; the marker renders before it. */
	firstUnreadId: string;
	count: number;
	/** False while the loaded window is too short to prove where unread begins. */
	exact: boolean;
};

/**
 * Place one unread boundary inside the loaded window.
 *
 * Unread counts inbound messages only. When the count fits inside the loaded
 * inbound messages the boundary is exact; when it exceeds them the marker sits
 * at the oldest loaded inbound message — honestly approximate — until older
 * pages reveal the real boundary.
 *
 * Call this only on open and after a prepend: live messages arriving while the
 * chat is open are not part of the snapshotted unread set, and re-deriving
 * against them would walk the marker forward.
 */
export function deriveUnreadBoundary(
	messages: Message[],
	unreadCount: number
): UnreadBoundary | null {
	if (unreadCount <= 0) return null;
	const inbound = messages.filter((m) => !m.from_me);
	if (inbound.length === 0) return null;
	const exact = unreadCount <= inbound.length;
	const first = exact ? inbound[inbound.length - unreadCount]! : inbound[0]!;
	return { firstUnreadId: first.id, count: unreadCount, exact };
}

/**
 * U4 — derive the unread boundary from the persisted read cursor instead of
 * the in-memory unread latch. The cursor is the id of the last message the
 * owner has read; the boundary marker renders before the first inbound message
 * strictly newer than it. A `null` cursor means "the chat has never been
 * opened locally since migration 010", so the caller must fall back to the
 * count-based {@link deriveUnreadBoundary} for those chats — the boundary
 * never regresses.
 *
 * `count` is the server's unread count at open (the count and the cursor are
 * written together by `markChatRead`, so they agree). It is only used for the
 * marker's label, never to place the marker — the cursor places the marker.
 */
export function deriveUnreadBoundaryFromCursor(
	messages: Message[],
	lastReadMsgId: string | null,
	unreadCount: number
): UnreadBoundary | null {
	if (lastReadMsgId === null) return null;
	if (unreadCount <= 0) return null;
	const inbound = messages.filter((m) => !m.from_me);
	if (inbound.length === 0) return null;
	const idx = inbound.findIndex((m) => m.id === lastReadMsgId);
	let firstUnreadIdx: number;
	if (idx === -1) {
		// The cursor is outside the loaded window — every loaded inbound is
		// unread. The marker sits at the oldest loaded inbound; older pages
		// may reveal it. This is the "approximate" case.
		firstUnreadIdx = 0;
	} else {
		firstUnreadIdx = idx + 1;
	}
	if (firstUnreadIdx >= inbound.length) return null;
	const first = inbound[firstUnreadIdx]!;
	// `exact` while the cursor is on screen — the boundary is provably here.
	// When the cursor is off-page (idx === -1) the marker is honestly approximate.
	const exact = idx !== -1;
	return { firstUnreadId: first.id, count: unreadCount, exact };
}

export function unreadBoundaryLabel(boundary: UnreadBoundary): string {
	const plural = boundary.count === 1 ? 'message' : 'messages';
	return boundary.exact
		? `${boundary.count} unread ${plural}`
		: `${boundary.count} unread ${plural} · earliest not loaded yet`;
}

export type Tone = 'neutral' | 'progress' | 'good' | 'warn' | 'bad';

export type SessionBanner = {
	label: string;
	detail: string;
	tone: Tone;
	/** True while the shell should stay fully usable (D5: syncing is not a gate). */
	usable: boolean;
	/** Show a re-pair / regenerate button. */
	canRepair: boolean;
	/** Cover the shell with the pairing screen. */
	blocking: boolean;
};

/**
 * D5 — the pairing/connection surface. `disconnected` auto-reconnects;
 * `logged_out` is terminal and re-pairing is itself a ban signal, so it is
 * labelled distinctly and loudly.
 */
export function sessionBanner(session: SessionView): SessionBanner {
	const status: SessionStatus = session.status;
	switch (status) {
		case 'initializing':
			return {
				label: 'Starting up',
				detail: 'Connecting to WhatsApp…',
				tone: 'progress',
				usable: true,
				canRepair: false,
				blocking: false
			};
		case 'qr_pending':
			return {
				label: 'Scan to pair',
				detail: 'WhatsApp → Linked devices → Link a device.',
				tone: 'progress',
				usable: false,
				canRepair: false,
				blocking: true
			};
		case 'qr_expired':
			return {
				label: 'QR code expired',
				detail: 'Generate a fresh code to continue pairing.',
				tone: 'warn',
				usable: false,
				canRepair: true,
				blocking: true
			};
		case 'pairing':
			return {
				label: 'Pairing',
				detail: 'Phone scanned — finishing the handshake…',
				tone: 'progress',
				usable: false,
				canRepair: false,
				blocking: true
			};
		case 'syncing':
			return {
				label: 'Catching up',
				detail: syncDetail(session),
				tone: 'progress',
				usable: true,
				canRepair: false,
				blocking: false
			};
		case 'ready':
			return {
				label: 'Connected',
				detail: 'Live.',
				tone: 'good',
				usable: true,
				canRepair: false,
				blocking: false
			};
		case 'disconnected':
			return {
				label: 'Reconnecting',
				detail: 'Lost the WhatsApp socket — retrying automatically.',
				tone: 'warn',
				usable: true,
				canRepair: false,
				blocking: false
			};
		case 'logged_out':
			return {
				label: 'Logged out',
				detail:
					'This device was unlinked on your phone. Re-pairing is required — note that frequent re-pairing is itself a ban signal.',
				tone: 'bad',
				usable: false,
				canRepair: true,
				blocking: true
			};
	}
}

/**
 * Counts only. Baileys never reports a total, so there is no percentage and no
 * determinate bar anywhere in this app (D5).
 */
export function syncDetail(session: SessionView): string {
	const { chatsSynced, messagesSynced } = session.sync;
	if (chatsSynced === 0 && messagesSynced === 0) return 'Waiting for history…';
	return `${chatsSynced.toLocaleString()} chats · ${messagesSynced.toLocaleString()} messages so far`;
}

export type DraftBadge = { label: string; tone: Tone; spinner: boolean };

export function draftBadge(status: DraftStatus): DraftBadge {
	switch (status) {
		case 'drafting':
			return { label: 'Drafting', tone: 'progress', spinner: true };
		case 'ready':
			return { label: 'Draft ready', tone: 'good', spinner: false };
		case 'stale':
			return { label: 'Needs re-check', tone: 'warn', spinner: false };
		case 'failed':
			return { label: 'Draft failed', tone: 'bad', spinner: false };
		case 'skipped':
			return { label: 'Skipped', tone: 'neutral', spinner: false };
		case 'approved':
			return { label: 'Queued', tone: 'progress', spinner: false };
		case 'sent':
			return { label: 'Sent', tone: 'good', spinner: false };
	}
}

/** A draft may only be sent from a state the server still considers current. */
export function canApprove(status: DraftStatus): boolean {
	return status === 'ready';
}

/**
 * A draft may only be preview-refined from a state the server still considers
 * current. Mirrors the server's `REFINABLE_STATUSES` (`server/agent/refiner.ts`)
 * intersected with the statuses the shell actually renders as a visible draft.
 * `failed` is excluded — a failed draft has no valid preview to transform, and
 * `drafting` is excluded because there is no text yet. The server is the final
 * authority; this helper only controls whether the controls render.
 */
export function canRefine(status: DraftStatus): boolean {
	return status === 'ready' || status === 'stale';
}

/** Once approval hands a reply to the outbox, the draft card has finished its job. */
export function isVisibleDraftStatus(status: DraftStatus): boolean {
	return status === 'drafting' || status === 'ready' || status === 'stale' || status === 'failed';
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export function mediaKind(type: string): MediaKind {
	switch (type) {
		case 'image':
		case 'video':
		case 'audio':
		case 'document':
		case 'sticker':
			return type;
		default:
			return 'other';
	}
}

export type MediaAffordance = {
	label: string;
	/** Fetch-on-demand button (D2: media is never bulk-prefetched). */
	canLoad: boolean;
	canRetry: boolean;
	/** True once the bytes exist locally and can be opened/played. */
	canOpen: boolean;
	busy: boolean;
	terminal: boolean;
};

/**
 * D2 — four states, straight off the server. `unavailable` is terminal: it gets
 * no retry affordance, because retrying cannot bring the bytes back.
 */
export function mediaAffordance(type: string, media: MediaView): MediaAffordance {
	const noun = mediaNoun(type);
	switch (media.state) {
		case 'placeholder':
			return {
				label: media.size ? `${noun} · ${formatBytes(media.size)}` : noun,
				canLoad: true,
				canRetry: false,
				canOpen: false,
				busy: false,
				terminal: false
			};
		case 'downloading':
			return {
				label: `Downloading ${noun.toLowerCase()}…`,
				canLoad: false,
				canRetry: false,
				canOpen: false,
				busy: true,
				terminal: false
			};
		case 'ready':
			return {
				label: media.filename ?? noun,
				canLoad: false,
				canRetry: false,
				canOpen: true,
				busy: false,
				terminal: false
			};
		case 'failed':
			return media.error === 'unavailable'
				? {
						label: 'No longer available',
						canLoad: false,
						canRetry: false,
						canOpen: false,
						busy: false,
						terminal: true
					}
				: {
						label: "Couldn't download",
						canLoad: false,
						canRetry: true,
						canOpen: false,
						busy: false,
						terminal: false
					};
	}
}

function mediaNoun(type: string): string {
	switch (mediaKind(type)) {
		case 'image':
			return 'Photo';
		case 'video':
			return 'Video';
		case 'audio':
			return 'Voice message';
		case 'document':
			return 'Document';
		case 'sticker':
			return 'Sticker';
		default:
			return 'Attachment';
	}
}

/**
 * Inbound attribution for a group bubble. The server already resolved the best
 * local name (contact name → push name → phone/JID), so this only picks the
 * honest fallback when there is no identity at all — it never guesses a name.
 */
export function senderLabel(sender: IdentityView | null): string {
	if (!sender) return 'Unknown participant';
	const name = sender.name?.trim();
	// A `name` still carrying an `@` domain *is* the server's honest fallback,
	// not a contact name — render it as an identity, not as a person's name.
	if (name && !name.includes('@')) return name;
	const jid = sender.display_jid || sender.jid;
	const local = jid.split('@')[0] || jid;
	// Only phone-backed JIDs get a `+`; a LID is a number but not a phone number.
	if (!jid.endsWith('@s.whatsapp.net')) return local;
	return local.startsWith('+') ? local : `+${local}`;
}

export type QuotePreview = {
	/** Who wrote the quoted message. */
	sender: string;
	/** One-line gist of the quoted content. */
	body: string;
	/** False when the target is not in local history — rendered distinctly. */
	resolved: boolean;
	/** Full sentence for assistive technology. */
	label: string;
	/** Subtype label for icon rendering; `other` covers unrecognized subtypes. */
	kind: QuoteKind;
	/** U5 — id of the quoted message, for jump-to-quote navigation. */
	targetId: string;
};

/**
 * Compact reply-target preview. Everything here comes from fields already on
 * the message: no lookup into the loaded page, no fetch. That matters for more
 * than purity — the quote inset must reach its final height on first paint or
 * it would grow underneath the prepend scroll anchor (U1).
 */
export function quotePreview(quote: QuoteView): QuotePreview {
	const sender = senderLabel(quote.sender);
	const kind = quoteKind(quote.type);
	const text = quote.text?.trim();
	const body = text ?? quoteFallbackBody(quote, kind);
	const label = quote.resolved
		? `Replying to ${sender}: ${body}`
		: `Replying to ${sender}: ${body} (original message not loaded)`;
	return { sender, body, resolved: quote.resolved, label, kind, targetId: quote.target_id };
}

/**
 * The subtype label used to pick an icon and a noun fallback. Wider than
 * {@link mediaKind} because a quote can target location/contact/poll subtypes
 * that the media attachment surface never renders.
 */
export type QuoteKind =
	| 'image'
	| 'video'
	| 'audio'
	| 'document'
	| 'sticker'
	| 'location'
	| 'contact'
	| 'text'
	| 'other';

export function quoteKind(type: string): QuoteKind {
	switch (type) {
		case 'image':
		case 'video':
		case 'audio':
		case 'document':
		case 'sticker':
		case 'location':
		case 'contact':
		case 'text':
			return type;
		default:
			return 'other';
	}
}

/** Noun for a quote subtype when no preview text is available. */
export function quoteNoun(kind: QuoteKind): string {
	switch (kind) {
		case 'image':
			return 'Photo';
		case 'video':
			return 'Video';
		case 'audio':
			return 'Voice message';
		case 'document':
			return 'Document';
		case 'sticker':
			return 'Sticker';
		case 'location':
			return 'Location';
		case 'contact':
			return 'Contact';
		case 'text':
			return 'Message';
		default:
			return 'Message';
	}
}

function quoteFallbackBody(quote: QuoteView, kind: QuoteKind): string {
	// An unresolved target with no snapshot text is the only case that admits
	// "unavailable" — every resolved subtype gets a meaningful noun.
	if (kind === 'other') {
		return quote.resolved ? quote.type : 'Original message unavailable';
	}
	return quoteNoun(kind);
}

export type ReactionChip = {
	emoji: string;
	count: number;
	/** Actor names for assistive technology; never a send affordance (display-only). */
	label: string;
};

const MAX_NAMED_ACTORS = 3;

/**
 * Display-only reaction aggregate. This wave renders reactions but adds no way
 * to create or remove one, so the chip must not read as a button — the actor
 * detail lives in this label instead.
 */
export function reactionChip(reaction: ReactionView): ReactionChip {
	const names = reaction.actors.map((actor) => senderLabel(actor));
	const shown = names.slice(0, MAX_NAMED_ACTORS);
	const rest = names.length - shown.length;
	const who = rest > 0 ? `${shown.join(', ')} and ${rest} more` : joinNames(shown);
	return {
		emoji: reaction.emoji,
		count: reaction.count,
		label: who ? `Reacted ${reaction.emoji} by ${who}` : `Reacted ${reaction.emoji}`
	};
}

function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Exponential backoff with jitter for the WS reconnect loop. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
	return Math.round(base * (0.7 + random() * 0.6));
}

export type DeepenKind = 'idle' | 'loading' | 'success' | 'error';

/** Deepen-history status view for the conversation header affordance. */
export type DeepenStatusView = {
	/** Button label. */
	label: string;
	/** Whether the action is in flight and the button should be inert. */
	busy: boolean;
	/** Whether the last attempt failed and a retry is the obvious next action. */
	failed: boolean;
	/** Whether the last attempt was accepted (older messages may still be arriving). */
	accepted: boolean;
};

/**
 * Owner-triggered history-deepen UI state. Read-only with respect to WhatsApp:
 * the action only asks the phone for older messages via
 * `fetchMessageHistory` — it never sends anything to a recipient, so it does
 * NOT route through the outbox/approval guard (R9 is about *sending*, not
 * fetching). The server additionally refuses while disconnected.
 */
export function deepenStatusView(kind: DeepenKind): DeepenStatusView {
	switch (kind) {
		case 'idle':
			return { label: 'Deepen history', busy: false, failed: false, accepted: false };
		case 'loading':
			return { label: 'Deepening…', busy: true, failed: false, accepted: false };
		case 'success':
			return { label: 'Requested', busy: false, failed: false, accepted: true };
		case 'error':
			return { label: 'Retry deepen', busy: false, failed: true, accepted: false };
	}
}
