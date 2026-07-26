import type {
	Chat,
	DraftStatus,
	MediaView,
	Message,
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

export function displayName(chat: Pick<Chat, 'jid' | 'display_jid' | 'name'>): string {
	if (chat.name && chat.name.trim()) return chat.name.trim();
	const local = chat.display_jid.split('@')[0] ?? chat.display_jid;
	return local.startsWith('+') ? local : `+${local}`;
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
