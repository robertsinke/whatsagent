import { resolveContact } from '../store/contacts.js';
import type { AppDatabase } from '../store/db.js';
import {
	getMessage,
	listMessageReactions,
	type MediaFailureReason,
	type MediaState,
	type Message
} from '../store/messages.js';
import { usableName } from '../../shared/names.js';

export type IdentityView = {
	/** Stable stored identity; `me` represents the linked owner account. */
	jid: string;
	/** Phone alias when known, otherwise the stable JID. */
	display_jid: string;
	/** Best local name, with an honest identity fallback. */
	name: string;
};

export type QuoteView = {
	target_id: string;
	resolved: boolean;
	sender: IdentityView | null;
	type: string;
	text: string | null;
};

export type ReactionView = {
	emoji: string;
	count: number;
	actors: IdentityView[];
};

/**
 * What the SPA gets for a message. `raw` (the full WAMessage envelope, needed
 * server-side for retry/decrypt) is deliberately stripped — it is large and the
 * UI has no use for it.
 */
export type MessageView = {
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

/** D2 — everything the media viewer needs, all of it server-decided. */
export type MediaView = {
	state: MediaState;
	/** Only set when `state === 'failed'`. */
	error: MediaFailureReason | null;
	/** Bytes, from the WhatsApp envelope. Null when the sender omitted it. */
	size: number | null;
	mime: string | null;
	filename: string | null;
	/** True once bytes are cached locally and servable. */
	cached: boolean;
};

// `ptv` = WhatsApp video note (round bubble). Same IVideoMessage bytes as
// `video`, kept as its own stored type so a round UI can diverge later (PL-F8).
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'ptv']);

export function isMediaType(type: string): boolean {
	return MEDIA_TYPES.has(type);
}

type LongLike = { low: number; high: number; unsigned?: boolean };

/** protobufjs Longs survive JSON as `{low, high, unsigned}`. */
function toBytes(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string') {
		const n = Number.parseInt(value, 10);
		return Number.isFinite(n) ? n : null;
	}
	if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
		const { low, high } = value as LongLike;
		if (typeof low !== 'number' || typeof high !== 'number') return null;
		const n = high * 2 ** 32 + (low >>> 0);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

const ENVELOPE_KEYS: Record<string, string> = {
	image: 'imageMessage',
	video: 'videoMessage',
	audio: 'audioMessage',
	document: 'documentMessage',
	sticker: 'stickerMessage',
	ptv: 'ptvMessage'
};

/**
 * Parses size/mime/filename out of the stored envelope. This is *description*,
 * not state: the four D2 states come from the persisted `media_state` column
 * and are never inferred here.
 */
export function describeMedia(message: Message): MediaView | null {
	if (!isMediaType(message.type)) return null;

	let size: number | null = null;
	let mime: string | null = null;
	let filename: string | null = null;

	const key = ENVELOPE_KEYS[message.type];
	if (message.raw && key) {
		try {
			const parsed = JSON.parse(message.raw) as {
				message?: Record<string, Record<string, unknown> | undefined>;
			};
			const content = parsed.message?.[key];
			if (content) {
				size = toBytes(content.fileLength);
				mime = typeof content.mimetype === 'string' ? content.mimetype : null;
				filename = typeof content.fileName === 'string' ? content.fileName : null;
			}
		} catch {
			// Unparseable envelope: describe nothing, state still stands.
		}
	}

	return {
		state: message.media_state,
		error: message.media_state === 'failed' ? message.media_error : null,
		size,
		mime,
		filename,
		cached: message.media_ref !== null && message.media_state === 'ready'
	};
}

function toIdentityView(db: AppDatabase, jid: string | null): IdentityView | null {
	if (!jid) return null;
	if (jid === 'me') return { jid, display_jid: jid, name: 'You' };
	const contact = resolveContact(db, jid);
	const displayJid = contact?.phone_jid ?? jid;
	// Same resolution order as `chat-view.ts`: contact name → push name →
	// identity fallback. A phone-shaped mask must not outrank a contact name.
	const name =
		usableName(contact?.name) ?? usableName(contact?.push_name) ?? displayJid;
	return {
		jid,
		display_jid: displayJid,
		name
	};
}

function toQuoteView(db: AppDatabase, message: Message): QuoteView | null {
	if (!message.quote_target_id || !message.quote_type) return null;
	const target = getMessage(db, message.quote_target_id);
	const resolved = target?.chat_jid === message.chat_jid ? target : undefined;
	return {
		target_id: message.quote_target_id,
		resolved: Boolean(resolved),
		sender: toIdentityView(db, resolved ? (resolved.from_me ? 'me' : resolved.sender) : message.quote_sender),
		type: resolved?.type ?? message.quote_type,
		text: resolved?.text ?? message.quote_text
	};
}

function toReactionViews(db: AppDatabase, message: Message): ReactionView[] {
	const grouped = new Map<string, IdentityView[]>();
	for (const reaction of listMessageReactions(db, message.chat_jid, message.id)) {
		const actor = toIdentityView(db, reaction.actor);
		if (!actor) continue;
		const actors = grouped.get(reaction.emoji) ?? [];
		actors.push(actor);
		grouped.set(reaction.emoji, actors);
	}
	return [...grouped].map(([emoji, actors]) => ({ emoji, count: actors.length, actors }));
}

export function toMessageView(db: AppDatabase, message: Message): MessageView {
	return {
		id: message.id,
		chat_jid: message.chat_jid,
		channel: message.channel,
		from_me: message.from_me,
		sender: toIdentityView(db, message.from_me ? null : message.sender),
		ts: message.ts,
		type: message.type,
		text: message.text,
		media: describeMedia(message),
		quote: toQuoteView(db, message),
		reactions: toReactionViews(db, message)
	};
}
