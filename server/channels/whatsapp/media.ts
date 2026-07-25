import {
	BufferJSON,
	downloadMediaMessage,
	type WAMessage
} from 'baileys';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase } from '../../store/db.js';
import { getMessage, upsertMessage } from '../../store/messages.js';

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

	const buffer = await download(envelope, 'buffer', {}, ctx);

	const mediaDir = join(options.dataDir, 'media');
	mkdirSync(mediaDir, { recursive: true, mode: 0o700 });

	const ext = extensionForType(stored.type);
	const relativeRef = join('media', `${messageId}${ext}`);
	const absolutePath = join(options.dataDir, relativeRef);
	writeFileSync(absolutePath, buffer, { mode: 0o600 });

	upsertMessage(db, {
		id: stored.id,
		chat_jid: stored.chat_jid,
		channel: stored.channel,
		from_me: stored.from_me,
		sender: stored.sender,
		ts: stored.ts,
		type: stored.type,
		text: stored.text,
		media_ref: relativeRef,
		raw: stored.raw
	});

	return { mediaRef: relativeRef, bytes: buffer.byteLength };
}

function extensionForType(type: string): string {
	switch (type) {
		case 'image':
			return '.jpg';
		case 'video':
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
