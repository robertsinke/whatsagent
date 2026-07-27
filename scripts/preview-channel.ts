/**
 * A fake `Channel` for the UI preview harness — the only way to look at the
 * first-run screens without a WhatsApp account.
 *
 * WHY THIS EXISTS
 *
 * `scripts/ui-preview.ts` deliberately passes no `channel` to `createApp`, so
 * `session.applyChannelEvent` is never called, `SessionState.status` stays at
 * its constructor default `initializing`, and the preview always renders the
 * populated chat shell. The pairing and first-run screens were unreachable.
 *
 * Starting a real channel is not the fix: it opens the owner's live WhatsApp
 * credentials and puts a second Baileys socket on their personal account, which
 * is the primary account-ban risk.
 *
 * `CreateAppOptions.channel` accepts any `Channel` — a four-method interface —
 * so a fake one emitting the same `ChannelEvent`s drives the *real* session
 * state machine through the *real* code path, with no socket, no credentials,
 * and no production code changed.
 *
 * The QR payload is synthetic. It encodes into a real, scannable QR *image*,
 * but the string is not a WhatsApp pairing code: scanning it with a phone does
 * nothing at all.
 */
import type { Channel, ChannelEvent, ChannelEventListener } from '../server/channels/channel.js';

/**
 * Session states the harness can reach. These are the states whose screens
 * OSS-P3.4 owns, plus `ready` for a baseline chat shell.
 *
 * `qr_expired` is not an event — the session state machine flips `qr_pending`
 * to it when the QR's TTL (`QR_TTL_MS`, 60s) elapses. So the mode emits a QR
 * and the state arrives a minute later, with no server change needed.
 */
export type PreviewSessionMode =
	| 'initializing'
	| 'qr_pending'
	| 'qr_expired'
	| 'logged_out'
	| 'syncing'
	| 'ready';

export const PREVIEW_SESSION_MODES: readonly PreviewSessionMode[] = [
	'initializing',
	'qr_pending',
	'qr_expired',
	'logged_out',
	'syncing',
	'ready'
];

export function isPreviewSessionMode(value: string | undefined): value is PreviewSessionMode {
	return value !== undefined && (PREVIEW_SESSION_MODES as readonly string[]).includes(value);
}

/**
 * Clearly-synthetic pairing payload. Shaped loosely like Baileys' comma-joined
 * QR string so the encoded image has realistic density, but every field says
 * what it is. `nonce` makes each `start()` mint a *fresh* code — otherwise the
 * regenerate affordance (`POST /api/session/pair`, which does stop → start)
 * would be a dead button in the preview.
 */
export function previewQrPayload(nonce: number): string {
	return [
		`2@PREVIEW-${nonce}`,
		'this-is-not-a-whatsapp-pairing-code',
		'scanning-it-does-nothing',
		'ui-preview-harness'
	].join(',');
}

/**
 * The event sequence a mode replays. Exported separately from the channel so a
 * test can feed it straight into `createSessionState` and assert the status it
 * produces — the assertion that actually matters here is "this mode reaches
 * that screen", and it needs no HTTP server.
 */
export function previewChannelEvents(mode: PreviewSessionMode, nonce: number): ChannelEvent[] {
	switch (mode) {
		case 'initializing':
			// A socket that is dialling and has not produced a QR yet. This is where
			// a genuinely empty app sits for its first seconds, so first-run has to
			// look right here too — not only once a QR exists.
			return [{ type: 'connection', state: 'connecting' }];
		case 'qr_pending':
		case 'qr_expired':
			return [
				{ type: 'connection', state: 'connecting' },
				{ type: 'pairing-needed', qr: previewQrPayload(nonce) }
			];
		case 'logged_out':
			return [{ type: 'logged-out' }];
		case 'syncing':
			return [
				{ type: 'connection', state: 'connected' },
				{ type: 'sync-progress', progress: null, isLatest: false, chats: 37, messages: 1_204 }
			];
		case 'ready':
			// Sync batch first: `onConnected` picks `ready` vs `syncing` from the
			// already-accumulated completion flag.
			return [
				{ type: 'sync-progress', progress: null, isLatest: true, chats: 42, messages: 3_150 },
				{ type: 'connection', state: 'connected' }
			];
	}
}

/**
 * A `Channel` that opens no socket. `start()` replays its mode's events into
 * every registered listener; `resetAuth()` and `stop()` are no-ops that exist
 * so `regeneratePairing` works end to end.
 */
export function createPreviewChannel(mode: PreviewSessionMode): Channel {
	const listeners = new Set<ChannelEventListener>();
	let nonce = 0;

	return {
		async start() {
			nonce += 1;
			for (const event of previewChannelEvents(mode, nonce)) {
				for (const listener of listeners) listener(event);
			}
		},
		async stop() {
			// Nothing to close — there is no socket.
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async resetAuth() {
			// No stored credentials exist; the next start() mints a fresh QR anyway.
		}
	};
}
