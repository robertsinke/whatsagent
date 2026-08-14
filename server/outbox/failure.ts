import { WhatsAppDisconnectedError } from '../channels/whatsapp/send.js';

/**
 * OUTBOX-1 — what a failed send attempt means.
 *
 * - `offline`  the send never left this process: there is no socket. No packet
 *              reached WhatsApp, so this costs no attempt (see below).
 * - `terminal` WhatsApp (or Baileys' own payload validation) rejected the
 *              request in a way a repeat cannot change. Fail the row now.
 * - `transient` everything else. Retry with backoff, up to the cap.
 */
export type SendFailureKind = 'offline' | 'terminal' | 'transient';

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
 * 4xx codes that are NOT a rejection of the payload. Baileys reuses the HTTP
 * status space for connection lifecycle (`DisconnectReason`), so a bare
 * "4xx means terminal" rule would permanently fail every row queued across a
 * reconnect. Sources, all in `node_modules/baileys/lib`:
 *   408 timedOut / connectionLost   — `Utils/generics.js` query timeout
 *   411 multideviceMismatch, 428 connectionClosed (`Socket/socket.js`),
 *   440 connectionReplaced          — the socket went away mid-send
 *   429                             — rate limited; backing off is the answer
 */
const TRANSIENT_STATUS = new Set([408, 411, 428, 429, 440]);

/**
 * Classify a throw from {@link import('../channels/whatsapp/send.js').WhatsAppSendTransport}.
 *
 * Deliberate polarity: **unknown means retry**, mirroring the pacer's dry-run
 * default. Guessing "terminal" on an unrecognised error silently drops a real
 * message the owner approved; guessing "transient" costs at most `maxAttempts`
 * attempts, because the cap — not this function — is what bounds the traffic.
 *
 * Concretely, the send path's own throw sites are:
 *   `Boom('Connection Closed', { statusCode: 428 })`            → transient
 *   `Boom('All encryptions failed', { statusCode: 500 })`       → transient
 *   `Boom('Not authenticated')` (no status)                     → transient
 *   `Boom('no content in message', { statusCode: 400 })` and the
 *   other `Utils/messages.js` 400s for a malformed payload      → terminal
 *
 * Note what is NOT here: "this address is not on WhatsApp". Baileys' send does
 * not check registration and does not reject an unregistered JID — reachability
 * is checked once, before enqueue, by `start-chat` via `onWhatsApp`. So the
 * undeliverable-address case is caught by the attempt cap, not by a status
 * code; bounded-then-`failed` is what keeps it off the wire.
 */
export function classifySendFailure(error: unknown): SendFailureKind {
	if (error instanceof WhatsAppDisconnectedError) return 'offline';
	const status = statusCodeOf(error);
	if (status === undefined) return 'transient';
	if (TRANSIENT_STATUS.has(status)) return 'transient';
	return status >= 400 && status < 500 ? 'terminal' : 'transient';
}

/**
 * Exponential backoff on the attempt count, capped. `attempts` is the number of
 * attempts already made including the one that just failed, so the first retry
 * waits exactly `baseMs` — the fixed 5s the outbox used before this, which is
 * the right delay for the overwhelmingly common case (a socket blip) and keeps
 * the pacer's existing retry timing unchanged for it.
 */
export function retryDelayMs(attempts: number, baseMs: number, maxMs: number): number {
	const exponent = Math.max(0, attempts - 1);
	const raw = baseMs * 2 ** Math.min(exponent, 20);
	return Math.min(Math.max(raw, baseMs), maxMs);
}

/** Owner-facing failure reason; trimmed so one bad throw cannot bloat a row. */
export function failureMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (!collapsed) return 'Send failed';
	return collapsed.length > 300 ? `${collapsed.slice(0, 299)}…` : collapsed;
}
