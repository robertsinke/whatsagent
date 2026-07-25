import { BufferJSON, type WAMessage, type WAMessageKey } from 'baileys';
import type { AppDatabase } from '../../store/db.js';
import { getMessage, listMessages } from '../../store/messages.js';

export type FetchMessageHistoryFn = (
	count: number,
	oldestMsgKey: WAMessageKey,
	oldestMsgTimestamp: number
) => Promise<string>;

export type DeepenHistoryResult =
	| { requested: true; sessionId: string; oldestMsgId: string }
	| { requested: false; reason: 'no-messages' | 'missing-raw-key' };

/**
 * Ask the phone for older messages in a chat (Baileys `fetchMessageHistory`).
 * Results arrive later via `messaging-history.set` and are ingested normally.
 * Used by U10 voice bootstrap when initial sync depth is thin.
 */
export async function deepenChatHistory(
	db: AppDatabase,
	fetchMessageHistory: FetchMessageHistoryFn,
	chatJid: string,
	count = 50
): Promise<DeepenHistoryResult> {
	const messages = listMessages(db, chatJid);
	if (messages.length === 0) {
		return { requested: false, reason: 'no-messages' };
	}

	const oldest = messages[0]!;
	let key: WAMessageKey | undefined;
	let timestamp = oldest.ts;

	if (oldest.raw) {
		try {
			const envelope = JSON.parse(oldest.raw, BufferJSON.reviver) as WAMessage;
			key = envelope.key;
			const ts = envelope.messageTimestamp;
			if (typeof ts === 'number') timestamp = ts;
			else if (ts && typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
				timestamp = (ts as { toNumber: () => number }).toNumber();
			}
		} catch {
			key = undefined;
		}
	}

	if (!key?.id || !key.remoteJid) {
		// Fall back to a synthetic key from the stored row when raw is missing.
		key = {
			id: oldest.id,
			remoteJid: chatJid,
			fromMe: oldest.from_me
		};
	}

	if (!key.id || !key.remoteJid) {
		return { requested: false, reason: 'missing-raw-key' };
	}

	const sessionId = await fetchMessageHistory(count, key, timestamp);
	return { requested: true, sessionId, oldestMsgId: key.id };
}
