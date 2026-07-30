import { describe, expect, it, vi } from 'vitest';
import { createSessionState, QR_TTL_MS } from '../server/api/session.js';
import type { SessionStatus } from '../server/api/session.js';
import {
	createPreviewChannel,
	previewChannelEvents,
	previewQrPayload,
	type PreviewSessionMode
} from './preview-channel.js';
import { createPreviewProviderDiscovery } from './preview-providers.js';

/**
 * The claim worth testing about the preview harness is "this mode reaches that
 * screen", and it needs no HTTP server: feeding the mode's events into the real
 * `SessionState` is the same derivation the app performs.
 */
function statusFor(mode: PreviewSessionMode): SessionStatus {
	const session = createSessionState({ setTimer: () => undefined, clearTimer: () => undefined });
	for (const event of previewChannelEvents(mode, 1)) session.applyChannelEvent(event);
	const status = session.get().status;
	session.dispose();
	return status;
}

describe('preview session modes', () => {
	it('reach the states whose screens OSS-P3.4 owns', () => {
		expect(statusFor('initializing')).toBe('initializing');
		expect(statusFor('qr_pending')).toBe('qr_pending');
		expect(statusFor('logged_out')).toBe('logged_out');
		expect(statusFor('syncing')).toBe('syncing');
		expect(statusFor('ready')).toBe('ready');
	});

	it('reaches qr_expired by letting the real QR TTL elapse', () => {
		vi.useFakeTimers();
		try {
			const session = createSessionState();
			for (const event of previewChannelEvents('qr_expired', 1)) session.applyChannelEvent(event);
			expect(session.get().status).toBe('qr_pending');
			vi.advanceTimersByTime(QR_TTL_MS + 1);
			expect(session.get().status).toBe('qr_expired');
			session.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it('puts a QR payload on the session that a client can render', () => {
		const session = createSessionState({ setTimer: () => undefined, clearTimer: () => undefined });
		for (const event of previewChannelEvents('qr_pending', 7)) session.applyChannelEvent(event);
		expect(session.get().qr).toBe(previewQrPayload(7));
		session.dispose();
	});

	it('says in the payload itself that it is not a real pairing code', () => {
		expect(previewQrPayload(1)).toContain('not-a-whatsapp-pairing-code');
	});
});

describe('createPreviewChannel', () => {
	it('mints a fresh QR on every start, so regenerate-pairing is not a dead button', async () => {
		const channel = createPreviewChannel('qr_pending');
		const seen: string[] = [];
		channel.onEvent((event) => {
			if (event.type === 'pairing-needed') seen.push(event.qr);
		});
		await channel.start();
		await channel.stop();
		await channel.resetAuth?.();
		await channel.start();
		expect(seen).toHaveLength(2);
		expect(seen[0]).not.toBe(seen[1]);
	});

	it('emits nothing after its listener is removed', async () => {
		const channel = createPreviewChannel('qr_pending');
		let count = 0;
		const off = channel.onEvent(() => (count += 1));
		off();
		await channel.start();
		expect(count).toBe(0);
	});
});

describe('preview provider discovery', () => {
	it('none: every provider missing, so the zero-provider screen is reachable', async () => {
		const snapshot = await createPreviewProviderDiscovery('none').snapshot();
		expect(snapshot.providers.map((p) => p.name)).toEqual(['claude', 'codex', 'ollama']);
		expect(snapshot.providers.every((p) => !p.installed)).toBe(true);
		expect(snapshot.providers.every((p) => p.unavailableReason === 'not_found')).toBe(true);
		expect(snapshot.providers.every((p) => p.path === null)).toBe(true);
	});

	it('ollama-down: a present binary with a dead daemon, matching the real shape', async () => {
		const snapshot = await createPreviewProviderDiscovery('ollama-down').snapshot();
		const ollama = snapshot.providers.find((p) => p.name === 'ollama')!;
		expect(ollama.installed).toBe(false);
		expect(ollama.unavailableReason).toBe('not_running');
		// The distinguishing detail: it still knows where the binary is.
		expect(ollama.path).toBe('/opt/homebrew/bin/ollama');
		expect(ollama.version).toBe('0.32.4');
		expect(snapshot.providers.filter((p) => p.installed).map((p) => p.name)).toEqual([
			'claude',
			'codex'
		]);
	});

	it('never fabricates a login: auth is unknown in every mode', async () => {
		for (const mode of ['all', 'none', 'ollama-down', 'mismatch'] as const) {
			const snapshot = await createPreviewProviderDiscovery(mode).snapshot();
			expect(snapshot.providers.every((p) => p.auth === 'unknown')).toBe(true);
		}
	});

	it('mismatch: OpenCode reports a version other than the pin', async () => {
		const snapshot = await createPreviewProviderDiscovery('mismatch').snapshot();
		const codex = snapshot.providers.find((p) => p.name === 'codex')!;
		expect(codex.installed).toBe(true);
		expect(codex.version).toBe('1.18.10');
	});
});
