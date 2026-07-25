import type { MediaFailureReason, MediaState, Message } from '../store/messages.js';

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
	sender: string | null;
	ts: number;
	type: string;
	text: string | null;
	media: MediaView | null;
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

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

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
	sticker: 'stickerMessage'
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

export function toMessageView(message: Message): MessageView {
	return {
		id: message.id,
		chat_jid: message.chat_jid,
		channel: message.channel,
		from_me: message.from_me,
		sender: message.sender,
		ts: message.ts,
		type: message.type,
		text: message.text,
		media: describeMedia(message)
	};
}
