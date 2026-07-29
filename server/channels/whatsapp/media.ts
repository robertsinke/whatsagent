import {
	BufferJSON,
	downloadMediaMessage,
	type WAMessage
} from 'baileys';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AppDatabase } from '../../store/db.js';
import {
	getMessage,
	setMediaRef,
	setMediaState,
	type MediaFailureReason
} from '../../store/messages.js';

export type MediaDownloader = (
	message: WAMessage,
	type: 'buffer',
	options: Record<string, unknown>,
	ctx?: {
		reuploadRequest: (msg: WAMessage) => Promise<WAMessage>;
		logger: { info: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
	}
) => Promise<Buffer>;

export type DownloadMediaOptions = {
	/** App-data directory (same root as the SQLite DB). */
	dataDir: string;
	/** Injected for tests; defaults to Baileys `downloadMediaMessage`. */
	download?: MediaDownloader;
	/** Phone reupload when CDN returns 404/410. */
	reuploadRequest?: (msg: WAMessage) => Promise<WAMessage>;
};

export type DownloadMediaResult = {
	mediaRef: string;
	bytes: number;
};

const noopLogger = {
	info: () => undefined,
	error: () => undefined
};

/** Raised by `downloadAndCacheMedia`; carries the persisted D2 failure reason. */
export class MediaDownloadFailure extends Error {
	readonly reason: MediaFailureReason;

	constructor(reason: MediaFailureReason, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'MediaDownloadFailure';
		this.reason = reason;
		this.cause = cause;
	}
}

function statusCodeOf(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const candidate = error as {
		status?: number;
		statusCode?: number;
		output?: { statusCode?: number };
	};
	return candidate.output?.statusCode ?? candidate.statusCode ?? candidate.status;
}

/**
 * D2 — `unavailable` (terminal) vs `transient` (retriable), off a concrete
 * Baileys signal rather than a guess.
 *
 * Baileys wraps media failures in `Boom`, and maps the phone's reupload verdict
 * onto HTTP-ish status codes in `MEDIA_RETRY_STATUS_MAP`
 * (`baileys/lib/Utils/messages-media.js`): NOT_FOUND → 404, DECRYPTION_ERROR →
 * 412, GENERAL_ERROR → 418; a reupload response missing ciphertext is also 404.
 * CDN fetches throw `Boom('Failed to fetch stream from …', { statusCode })`.
 * So 404/410 means the bytes are gone WhatsApp-side — everything else
 * (412 decrypt, 418, 5xx, socket errors) is treated as transient and retriable.
 */
export function classifyMediaFailure(error: unknown): MediaFailureReason {
	const status = statusCodeOf(error);
	return status === 404 || status === 410 ? 'unavailable' : 'transient';
}

/**
 * On-demand media download: reads the full WAMessage envelope from `messages.raw`,
 * downloads via Baileys (with optional reupload), caches under `{dataDir}/media/`,
 * and writes `messages.media_ref` to the relative path.
 */
export async function downloadAndCacheMedia(
	db: AppDatabase,
	messageId: string,
	options: DownloadMediaOptions
): Promise<DownloadMediaResult> {
	const stored = getMessage(db, messageId);
	if (!stored) throw new Error(`Unknown message: ${messageId}`);
	if (!stored.raw) throw new Error(`Message ${messageId} has no raw envelope`);

	const envelope = JSON.parse(stored.raw, BufferJSON.reviver) as WAMessage;
	const download = options.download ?? (downloadMediaMessage as unknown as MediaDownloader);

	const ctx = options.reuploadRequest
		? { reuploadRequest: options.reuploadRequest, logger: noopLogger }
		: undefined;

	// D2: the state machine is persisted at every step so the UI never guesses.
	setMediaState(db, messageId, 'downloading');

	let buffer: Buffer;
	try {
		buffer = await download(envelope, 'buffer', {}, ctx);
	} catch (error) {
		const reason = classifyMediaFailure(error);
		setMediaState(db, messageId, 'failed', reason);
		throw new MediaDownloadFailure(reason, error);
	}

	const mediaDir = join(options.dataDir, 'media');
	const ext = extensionForType(stored.type);
	const cacheId = createHash('sha256').update(messageId).digest('hex');
	const relativeRef = join('media', `${cacheId}${ext}`);
	const absolutePath = resolve(options.dataDir, relativeRef);
	const resolvedMediaDir = resolve(mediaDir);
	const relativeToMedia = relative(resolvedMediaDir, absolutePath);
	if (relativeToMedia.startsWith('..') || relativeToMedia.includes('/../')) {
		setMediaState(db, messageId, 'failed', 'transient');
		throw new MediaDownloadFailure('transient', new Error('Unsafe media cache path'));
	}

	try {
		mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
		writeFileSync(absolutePath, buffer, { mode: 0o600 });
	} catch (error) {
		// Local IO — always retriable.
		setMediaState(db, messageId, 'failed', 'transient');
		throw new MediaDownloadFailure('transient', error);
	}

	setMediaRef(db, messageId, relativeRef);

	return { mediaRef: relativeRef, bytes: buffer.byteLength };
}

function extensionForType(type: string): string {
	switch (type) {
		case 'image':
			return '.jpg';
		case 'video':
		case 'ptv':
			return '.mp4';
		case 'audio':
			return '.ogg';
		case 'sticker':
			return '.webp';
		case 'document':
			return '.bin';
		default:
			return '.bin';
	}
}
