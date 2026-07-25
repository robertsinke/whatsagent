import type { ChannelEvent } from '../channels/channel.js';

/**
 * D5 — the view-level session state the UI renders.
 *
 * Derived from U3's transport-level `ChannelConnectionState`
 * (`connecting | connected | disconnected`) plus QR rotation, the terminal
 * `logged-out` channel event, and history-sync batches. The transport enum is
 * deliberately NOT widened; this lives at the API layer.
 */
export type SessionStatus =
	| 'initializing'
	| 'qr_pending'
	| 'qr_expired'
	| 'pairing'
	| 'syncing'
	| 'ready'
	| 'disconnected'
	| 'logged_out';

/**
 * Sync progress is INDETERMINATE by construction. Baileys never says how many
 * chats or messages are coming, so there is no total and no percentage — only
 * monotonic counts and a `complete` flag.
 */
export type SyncView = {
	chatsSynced: number;
	messagesSynced: number;
	complete: boolean;
};

export type SessionView = {
	status: SessionStatus;
	/** Current QR payload — only ever non-null in `qr_pending`. */
	qr: string | null;
	/** Epoch ms this QR stops being scannable; null when no QR is live. */
	qrExpiresAt: number | null;
	sync: SyncView;
};

/** WhatsApp rotates the pairing QR at roughly this cadence. */
export const QR_TTL_MS = 20_000;

export type SessionStateOptions = {
	qrTtlMs?: number;
	now?: () => number;
	/** Called on every state transition — wire to the WS EventBus. */
	onChange?: (view: SessionView) => void;
	/** Injected for tests; defaults to `setTimeout`. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

export type SessionState = {
	get(): SessionView;
	/** Feed transport/channel events straight through. */
	applyChannelEvent(event: ChannelEvent): void;
	/** Clear timers (test teardown / app close) — otherwise the process hangs. */
	dispose(): void;
};

export function createSessionState(options: SessionStateOptions = {}): SessionState {
	const qrTtlMs = options.qrTtlMs ?? QR_TTL_MS;
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

	let status: SessionStatus = 'initializing';
	let qr: string | null = null;
	let qrExpiresAt: number | null = null;
	let sync: SyncView = { chatsSynced: 0, messagesSynced: 0, complete: false };
	/** A QR was shown this connect attempt — lets us call `connecting` "pairing". */
	let sawQr = false;
	let expiryTimer: unknown;

	function view(): SessionView {
		return { status, qr, qrExpiresAt, sync: { ...sync } };
	}

	function emit(): void {
		options.onChange?.(view());
	}

	function clearExpiryTimer(): void {
		if (expiryTimer !== undefined) {
			clearTimer(expiryTimer);
			expiryTimer = undefined;
		}
	}

	function clearQr(): void {
		clearExpiryTimer();
		qr = null;
		qrExpiresAt = null;
	}

	function transition(next: SessionStatus): void {
		if (status === next) return;
		status = next;
		emit();
	}

	function onQr(payload: string): void {
		// Each rotation is a fresh push, never a poll (D5).
		const freshPairing = status === 'logged_out';
		clearExpiryTimer();
		if (freshPairing) {
			sync = { chatsSynced: 0, messagesSynced: 0, complete: false };
		}
		sawQr = true;
		qr = payload;
		qrExpiresAt = now() + qrTtlMs;
		status = 'qr_pending';
		emit();
		expiryTimer = setTimer(() => {
			expiryTimer = undefined;
			if (status !== 'qr_pending') return;
			qr = null;
			qrExpiresAt = null;
			status = 'qr_expired';
			emit();
		}, qrTtlMs);
	}

	function onConnected(): void {
		clearQr();
		sawQr = false;
		transition(sync.complete ? 'ready' : 'syncing');
	}

	function onDisconnected(): void {
		// `logged_out` is terminal: a trailing transport close must not downgrade it
		// to the auto-reconnecting `disconnected`.
		if (status === 'logged_out') return;
		clearQr();
		transition('disconnected');
	}

	function onConnecting(): void {
		if (status === 'logged_out') return;
		// A QR was on screen and the socket is re-handshaking ⇒ the phone scanned it.
		transition(sawQr ? 'pairing' : 'initializing');
	}

	function onLoggedOut(): void {
		clearQr();
		sawQr = false;
		status = 'logged_out';
		emit();
	}

	function onSyncBatch(batch: { chats: number; messages: number; isLatest: boolean }): void {
		sync = {
			chatsSynced: sync.chatsSynced + batch.chats,
			messagesSynced: sync.messagesSynced + batch.messages,
			complete: sync.complete || batch.isLatest
		};
		// The shell stays usable while syncing — this only re-labels the indicator.
		if (status === 'syncing' && sync.complete) {
			status = 'ready';
		} else if (status === 'ready' && !sync.complete) {
			status = 'syncing';
		}
		emit();
	}

	return {
		get: view,
		applyChannelEvent(event) {
			switch (event.type) {
				case 'pairing-needed':
					onQr(event.qr);
					return;
				case 'logged-out':
					onLoggedOut();
					return;
				case 'sync-progress':
					onSyncBatch({
						chats: event.chats,
						messages: event.messages,
						isLatest: event.isLatest
					});
					return;
				case 'connection':
					if (event.state === 'connected') onConnected();
					else if (event.state === 'connecting') onConnecting();
					else onDisconnected();
					return;
				default:
					return;
			}
		},
		dispose: clearExpiryTimer
	};
}
