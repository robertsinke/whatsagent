import { describe, expect, it } from 'vitest';
import type { ChannelEvent } from '../channels/channel.js';
import { createSessionState, type SessionView } from './session.js';

type Harness = {
	session: ReturnType<typeof createSessionState>;
	views: SessionView[];
	advance: (ms: number) => void;
	feed: (...events: ChannelEvent[]) => void;
};

/** Fake clock + timer so QR rotation/expiry is deterministic and leak-free. */
function harness(qrTtlMs = 60_000, initialSyncComplete = false): Harness {
	let clock = 1_000_000;
	let nextHandle = 1;
	const timers = new Map<number, { fireAt: number; fn: () => void }>();
	const views: SessionView[] = [];

	const session = createSessionState({
		qrTtlMs,
		initialSyncComplete,
		now: () => clock,
		onChange: (view) => views.push(view),
		setTimer: (fn, ms) => {
			const handle = nextHandle++;
			timers.set(handle, { fireAt: clock + ms, fn });
			return handle;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		}
	});

	return {
		session,
		views,
		advance(ms) {
			clock += ms;
			for (const [handle, timer] of [...timers]) {
				if (timer.fireAt <= clock) {
					timers.delete(handle);
					timer.fn();
				}
			}
		},
		feed(...events) {
			for (const event of events) session.applyChannelEvent(event);
		}
	};
}

describe('session status derivation (D5)', () => {
	it('starts as initializing and stays there while the socket connects', () => {
		const h = harness();
		expect(h.session.get().status).toBe('initializing');
		h.feed({ type: 'connection', state: 'connecting' });
		expect(h.session.get().status).toBe('initializing');
	});

	it('shows qr_pending with the payload and an expiry, per rotation', () => {
		const h = harness();
		h.feed({ type: 'pairing-needed', qr: 'qr-1' });

		const first = h.session.get();
		expect(first.status).toBe('qr_pending');
		expect(first.qr).toBe('qr-1');
		expect(first.qrExpiresAt).not.toBeNull();

		// Rotation ~20s later: a fresh push, not a poll — new payload, new deadline.
		h.advance(19_000);
		h.feed({ type: 'pairing-needed', qr: 'qr-2' });
		const second = h.session.get();
		expect(second.status).toBe('qr_pending');
		expect(second.qr).toBe('qr-2');
		expect(second.qrExpiresAt).toBeGreaterThan(first.qrExpiresAt!);

		// The first QR's expiry timer was cleared, so it cannot fire us to expired.
		h.advance(19_500);
		expect(h.session.get().status).toBe('qr_pending');
	});

	it('goes to qr_expired when a QR is not refreshed within its TTL', () => {
		const h = harness();
		h.feed({ type: 'pairing-needed', qr: 'qr-1' });
		h.advance(60_000);

		const view = h.session.get();
		expect(view.status).toBe('qr_expired');
		expect(view.qr).toBeNull();
		expect(view.qrExpiresAt).toBeNull();
	});

	it('reads a reconnect after a shown QR as pairing (phone scanned)', () => {
		const h = harness();
		h.feed({ type: 'pairing-needed', qr: 'qr-1' }, { type: 'connection', state: 'connecting' });
		expect(h.session.get().status).toBe('pairing');
	});

	it('is syncing while history lands, then ready — with counts and no total', () => {
		const h = harness();
		h.feed({ type: 'connection', state: 'connected' });
		expect(h.session.get().status).toBe('syncing');

		h.feed({ type: 'sync-progress', progress: 20, isLatest: false, chats: 4, messages: 120 });
		h.feed({ type: 'sync-progress', progress: 60, isLatest: false, chats: 3, messages: 80 });

		let view = h.session.get();
		expect(view.status).toBe('syncing');
		expect(view.sync).toEqual({ chatsSynced: 7, messagesSynced: 200, complete: false });
		// No total, anywhere — a percentage would be fabricated.
		expect(Object.keys(view.sync)).not.toContain('total');

		h.feed({ type: 'sync-progress', progress: 100, isLatest: true, chats: 1, messages: 10 });
		view = h.session.get();
		expect(view.status).toBe('ready');
		expect(view.sync).toEqual({ chatsSynced: 8, messagesSynced: 210, complete: true });
	});

	it('connects straight to ready when sync already completed', () => {
		const h = harness();
		h.feed(
			{ type: 'connection', state: 'connected' },
			{ type: 'sync-progress', progress: 100, isLatest: true, chats: 2, messages: 5 },
			{ type: 'connection', state: 'disconnected' },
			{ type: 'connection', state: 'connected' }
		);
		expect(h.session.get().status).toBe('ready');
	});

	it('restores prior sync completion and connects straight to ready after restart', () => {
		const h = harness(60_000, true);
		h.feed({ type: 'connection', state: 'connected' });
		expect(h.session.get()).toMatchObject({
			status: 'ready',
			sync: { complete: true }
		});
	});

	it('separates disconnected (auto-reconnects) from logged_out (terminal)', () => {
		const h = harness();
		h.feed({ type: 'connection', state: 'connected' }, { type: 'connection', state: 'disconnected' });
		expect(h.session.get().status).toBe('disconnected');

		h.feed({ type: 'connection', state: 'connecting' });
		expect(h.session.get().status).toBe('initializing');
	});

	it('keeps logged_out terminal against trailing transport events', () => {
		const h = harness();
		h.feed(
			{ type: 'connection', state: 'connected' },
			{ type: 'sync-progress', progress: 100, isLatest: true, chats: 2, messages: 5 },
			{ type: 'logged-out' },
			{ type: 'connection', state: 'disconnected' },
			{ type: 'connection', state: 'connecting' }
		);
		expect(h.session.get().status).toBe('logged_out');

		// Only a fresh QR (the owner re-pairing) breaks out of it.
		h.feed({ type: 'pairing-needed', qr: 'qr-new' });
		expect(h.session.get().status).toBe('qr_pending');
		expect(h.session.get().sync).toEqual({
			chatsSynced: 0,
			messagesSynced: 0,
			complete: false
		});
	});

	it('clears the live QR when the socket opens', () => {
		const h = harness();
		h.feed({ type: 'pairing-needed', qr: 'qr-1' }, { type: 'connection', state: 'connected' });
		const view = h.session.get();
		expect(view.qr).toBeNull();
		expect(view.qrExpiresAt).toBeNull();
	});

	it('pushes a view on every transition', () => {
		const h = harness();
		h.feed({ type: 'pairing-needed', qr: 'qr-1' }, { type: 'connection', state: 'connected' });
		expect(h.views.map((v) => v.status)).toEqual(['qr_pending', 'syncing']);
	});
});
