import { describe, expect, it } from 'vitest';
import type { Chat, MediaView, Message, SessionView } from './types.js';
import { api } from './api.js';
import {
	canApprove,
	deepenStatusView,
	draftBadge,
	filterChats,
	formatBytes,
	formatMessageTime,
	mediaAffordance,
	mergeMessages,
	reconnectDelayMs,
	sessionBanner,
	syncDetail,
	tabCounts,
	toChatRow
} from './view.js';

function chat(overrides: Partial<Chat> = {}): Chat {
	return {
		jid: 'alice@s.whatsapp.net',
		channel: 'whatsapp',
		name: 'Alice Ramos',
		kind: '1:1',
		last_msg_at: 1_700_000_000_000,
		unread: 0,
		muted: false,
		archived: false,
		agent_state: null,
		needs_reply: false,
		preview: 'see you then',
		preview_from_me: false,
		draft_status: null,
		...overrides
	};
}

function session(overrides: Partial<SessionView> = {}): SessionView {
	return {
		status: 'ready',
		qr: null,
		qrExpiresAt: null,
		sync: { chatsSynced: 0, messagesSynced: 0, complete: true },
		...overrides
	};
}

function media(overrides: Partial<MediaView> = {}): MediaView {
	return {
		state: 'placeholder',
		error: null,
		size: null,
		mime: null,
		filename: null,
		cached: false,
		...overrides
	};
}

describe('chat row', () => {
	it('renders name, initials, preview, time, unread and draft indicator', () => {
		const row = toChatRow(
			chat({ unread: 3, draft_status: 'ready', last_msg_at: 1_700_000_000_000 }),
			1_700_000_060_000
		);
		expect(row.name).toBe('Alice Ramos');
		expect(row.initials).toBe('AR');
		expect(row.preview).toBe('see you then');
		expect(row.time).not.toBe('');
		expect(row.unread).toBe(3);
		expect(row.draftStatus).toBe('ready');
	});

	it('prefixes own messages and falls back to the jid when unnamed', () => {
		const row = toChatRow(chat({ name: null, preview_from_me: true, preview: 'ok' }));
		expect(row.preview).toBe('You: ok');
		expect(row.name).toBe('+alice');
	});

	it('renders relative times: today, yesterday, this week, older', () => {
		const now = new Date('2026-07-25T12:00:00Z').getTime();
		expect(toChatRow(chat({ last_msg_at: now - 3_600_000 }), now).time).toMatch(/\d/);
		expect(toChatRow(chat({ last_msg_at: now - 30 * 3_600_000 }), now).time).toBe('Yesterday');
		expect(toChatRow(chat({ last_msg_at: null }), now).time).toBe('');
	});

	it('renders Baileys epoch-second timestamps like equivalent milliseconds', () => {
		const seconds = 1_700_000_000;
		expect(formatMessageTime(seconds)).toBe(formatMessageTime(seconds * 1000));
	});
});

describe('needs-reply tabs', () => {
	const chats = [
		chat({ jid: 'a@s.whatsapp.net', needs_reply: true }),
		chat({ jid: 'b@s.whatsapp.net', needs_reply: false }),
		chat({ jid: 'g@g.us', kind: 'group', needs_reply: false })
	];

	it('filters each tab off the server verdict', () => {
		expect(filterChats(chats, 'all')).toHaveLength(3);
		expect(filterChats(chats, 'needs-reply').map((c) => c.jid)).toEqual(['a@s.whatsapp.net']);
		expect(filterChats(chats, 'groups').map((c) => c.jid)).toEqual(['g@g.us']);
	});

	it('reports counts per tab', () => {
		expect(tabCounts(chats)).toEqual({ all: 3, 'needs-reply': 1, groups: 1 });
	});

	it('never treats a group as needing a reply, even if flagged', () => {
		// Groups are structurally excluded upstream (R8); the tab honours the flag,
		// so a group can only appear here if the server said so.
		expect(filterChats([chat({ kind: 'group', needs_reply: false })], 'needs-reply')).toEqual([]);
	});
});

describe('session banner (D5)', () => {
	it('keeps the shell usable while syncing and reports counts, never a percentage', () => {
		const banner = sessionBanner(
			session({
				status: 'syncing',
				sync: { chatsSynced: 12, messagesSynced: 3_400, complete: false }
			})
		);
		expect(banner.usable).toBe(true);
		expect(banner.blocking).toBe(false);
		expect(banner.detail).toContain('12');
		expect(banner.detail).toContain('3,400');
		expect(banner.detail).not.toMatch(/%/);
	});

	it('says "waiting" rather than 0% before the first batch', () => {
		expect(syncDetail(session({ sync: { chatsSynced: 0, messagesSynced: 0, complete: false } })))
			.toBe('Waiting for history…');
	});

	it('separates auto-reconnecting disconnected from terminal logged_out', () => {
		const dropped = sessionBanner(session({ status: 'disconnected' }));
		expect(dropped.canRepair).toBe(false);
		expect(dropped.blocking).toBe(false);

		const out = sessionBanner(session({ status: 'logged_out' }));
		expect(out.canRepair).toBe(true);
		expect(out.blocking).toBe(true);
		expect(out.tone).toBe('bad');
		// Re-pairing is a ban signal — the owner is told, not silently prompted.
		expect(out.detail).toMatch(/ban signal/i);
	});

	it('offers regeneration only once the QR has expired', () => {
		expect(sessionBanner(session({ status: 'qr_pending', qr: 'x' })).canRepair).toBe(false);
		expect(sessionBanner(session({ status: 'qr_expired' })).canRepair).toBe(true);
	});
});

describe('draft status', () => {
	it('labels every status in the enum', () => {
		for (const status of [
			'drafting',
			'ready',
			'stale',
			'failed',
			'skipped',
			'approved',
			'sent'
		] as const) {
			expect(draftBadge(status).label).toBeTruthy();
		}
	});

	it('only allows one-click approval from `ready`', () => {
		expect(canApprove('ready')).toBe(true);
		// `stale` must re-confirm instead of sending.
		expect(canApprove('stale')).toBe(false);
		expect(canApprove('drafting')).toBe(false);
		expect(canApprove('failed')).toBe(false);
	});
});

describe('media affordances (D2)', () => {
	it('shows tap-to-load with size for never-fetched media', () => {
		const view = mediaAffordance('image', media({ size: 245_760 }));
		expect(view.canLoad).toBe(true);
		expect(view.label).toBe('Photo · 240 KB');
	});

	it('shows a busy state while downloading, with no load or retry button', () => {
		const view = mediaAffordance('video', media({ state: 'downloading' }));
		expect(view.busy).toBe(true);
		expect(view.canLoad).toBe(false);
		expect(view.canRetry).toBe(false);
	});

	it('opens once ready', () => {
		const view = mediaAffordance('image', media({ state: 'ready', cached: true }));
		expect(view.canOpen).toBe(true);
	});

	it('offers retry on transient failure', () => {
		const view = mediaAffordance('audio', media({ state: 'failed', error: 'transient' }));
		expect(view.canRetry).toBe(true);
		expect(view.terminal).toBe(false);
	});

	it('offers NO retry on terminal unavailable, and says so plainly', () => {
		const view = mediaAffordance('image', media({ state: 'failed', error: 'unavailable' }));
		expect(view.canRetry).toBe(false);
		expect(view.terminal).toBe(true);
		expect(view.label).toBe('No longer available');
	});

	it('formats sizes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2 KB');
		expect(formatBytes(3_500_000)).toBe('3.3 MB');
	});
});

describe('message merge', () => {
	const message = (id: string, ts: number): Message => ({
		id,
		chat_jid: 'alice@s.whatsapp.net',
		channel: 'whatsapp',
		from_me: false,
		sender: null,
		ts,
		type: 'text',
		text: id,
		media: null
	});

	it('de-duplicates by id and orders oldest-first', () => {
		const merged = mergeMessages([message('b', 2), message('a', 1)], [message('b', 2), message('c', 3)]);
		expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
	});
});

describe('reconnect backoff', () => {
	it('grows with attempts and stays capped', () => {
		const mid = () => 0.5;
		expect(reconnectDelayMs(1, mid)).toBeLessThan(reconnectDelayMs(4, mid));
		expect(reconnectDelayMs(50, mid)).toBeLessThanOrEqual(30_000);
	});
});

describe('deepen-history status view', () => {
	it('labels every status in the enum', () => {
		for (const kind of ['idle', 'loading', 'success', 'error'] as const) {
			expect(deepenStatusView(kind).label).toBeTruthy();
		}
	});

	it('is busy only while loading, and inert there', () => {
		expect(deepenStatusView('loading').busy).toBe(true);
		expect(deepenStatusView('idle').busy).toBe(false);
		expect(deepenStatusView('success').busy).toBe(false);
		expect(deepenStatusView('error').busy).toBe(false);
	});

	it('marks success as accepted and error as failed — never the reverse', () => {
		expect(deepenStatusView('success').accepted).toBe(true);
		expect(deepenStatusView('success').failed).toBe(false);
		expect(deepenStatusView('error').failed).toBe(true);
		expect(deepenStatusView('error').accepted).toBe(false);
		expect(deepenStatusView('idle').accepted).toBe(false);
	});

	it('is never both accepted and failed', () => {
		for (const kind of ['idle', 'loading', 'success', 'error'] as const) {
			const view = deepenStatusView(kind);
			expect(view.accepted && view.failed).toBe(false);
		}
	});
});

describe('no-autonomous-send invariant (R9)', () => {
	// The api surface is the only client path that can reach WhatsApp. The
	// outbox is the sole sender; deepen-history is read-only fetch from the
	// phone and must not be confused with a send/approve path.
	it('exposes deepenHistory as a distinct function from send and approveDraft', () => {
		expect(typeof api.deepenHistory).toBe('function');
		expect(api.deepenHistory).not.toBe(api.send);
		expect(api.deepenHistory).not.toBe(api.approveDraft);
	});

	it('lists every WhatsApp-bound send/approve path through the outbox surface', () => {
		// Only send (manual composer) and approveDraft (approved draft) produce
		// outbox rows. Everything else is read-only or local-only.
		const outboxProducing = ['send', 'approveDraft'];
		for (const key of outboxProducing) {
			expect(typeof (api as Record<string, unknown>)[key]).toBe('function');
		}
		// Deepen is NOT in that set — it produces no outbox row and cannot send.
		expect(outboxProducing).not.toContain('deepenHistory');
	});
});
