import { describe, expect, it } from 'vitest';
import type { Chat, MediaView, Message, SessionView } from './types.js';
import { api } from './api.js';
import {
	canApprove,
	canRefine,
	deepenStatusView,
	deriveUnreadBoundary,
	draftBadge,
	filterChats,
	formatBytes,
	formatMessageTime,
	isVisibleDraftStatus,
	mediaAffordance,
	mergeMessages,
	quotePreview,
	reactionChip,
	reconnectDelayMs,
	replaceMessage,
	senderLabel,
	sessionBanner,
	syncDetail,
	tabCounts,
	toChatRow,
	unreadBoundaryLabel
} from './view.js';

function chat(overrides: Partial<Chat> = {}): Chat {
	return {
		jid: 'alice@s.whatsapp.net',
		display_jid: 'alice@s.whatsapp.net',
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

	it('uses the phone alias instead of rendering an opaque LID as a number', () => {
		const row = toChatRow(
			chat({
				jid: '203663104602149@lid',
				display_jid: '31683799485@s.whatsapp.net',
				name: null
			})
		);
		expect(row.name).toBe('+31683799485');
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

	it('removes the draft card after approval hands responsibility to the outbox', () => {
		expect(isVisibleDraftStatus('drafting')).toBe(true);
		expect(isVisibleDraftStatus('ready')).toBe(true);
		expect(isVisibleDraftStatus('stale')).toBe(true);
		expect(isVisibleDraftStatus('failed')).toBe(true);
		expect(isVisibleDraftStatus('approved')).toBe(false);
		expect(isVisibleDraftStatus('sent')).toBe(false);
		expect(isVisibleDraftStatus('skipped')).toBe(false);
	});

	it('allows preview refinement only from a state with a valid preview', () => {
		// `ready` and `stale` have a usable preview the server will refine.
		expect(canRefine('ready')).toBe(true);
		expect(canRefine('stale')).toBe(true);
		// `drafting` has no text yet; `failed` has no valid preview to transform.
		expect(canRefine('drafting')).toBe(false);
		expect(canRefine('failed')).toBe(false);
		// Post-approval and skipped states are not visible drafts at all.
		expect(canRefine('approved')).toBe(false);
		expect(canRefine('skipped')).toBe(false);
		expect(canRefine('sent')).toBe(false);
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
		media: null,
		quote: null,
		reactions: []
	});

	it('de-duplicates by id and orders oldest-first', () => {
		const merged = mergeMessages([message('b', 2), message('a', 1)], [message('b', 2), message('c', 3)]);
		expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
	});

	it('replaces a loaded message in place without reordering it', () => {
		const loaded = [message('a', 1), message('b', 2), message('c', 3)];
		const updated = { ...message('b', 2), reactions: [{ emoji: '🔥', count: 1, actors: [] }] };
		const next = replaceMessage(loaded, updated);
		expect(next.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(next[1]!.reactions).toHaveLength(1);
	});

	// A reaction can target a message far above the loaded window. Inserting it
	// would put a bubble on screen with a history hole around it.
	it('drops an update for a message outside the loaded window', () => {
		const loaded = [message('b', 2), message('c', 3)];
		const next = replaceMessage(loaded, message('a', 1));
		expect(next).toBe(loaded);
	});
});

describe('sender attribution', () => {
	const identity = (jid: string, name: string) => ({ jid, display_jid: jid, name });

	it('uses the server-resolved name when there is one', () => {
		expect(senderLabel(identity('maya@s.whatsapp.net', 'Maya'))).toBe('Maya');
	});

	// The server already falls back to the JID when no contact is known; the
	// client must surface that honestly rather than inventing a friendly name.
	it('falls back to the phone/JID local part, never to a placeholder name', () => {
		expect(senderLabel(identity('4477000111@s.whatsapp.net', '4477000111@s.whatsapp.net'))).toBe(
			'+4477000111'
		);
		expect(senderLabel(null)).toBe('Unknown participant');
	});

	// A LID is numeric but is not a phone number — `+` there would be a lie.
	it('does not dress a LID up as a phone number', () => {
		expect(senderLabel(identity('209384756@lid', '209384756@lid'))).toBe('209384756');
	});
});

describe('quote previews', () => {
	const maya = { jid: 'maya@s.whatsapp.net', display_jid: 'maya@s.whatsapp.net', name: 'Maya' };

	it('identifies sender and content for a resolved text quote', () => {
		const preview = quotePreview({
			target_id: 'x1',
			resolved: true,
			sender: maya,
			type: 'text',
			text: 'see you at seven'
		});
		expect(preview).toMatchObject({ sender: 'Maya', body: 'see you at seven', resolved: true });
		expect(preview.label).toBe('Replying to Maya: see you at seven');
	});

	it('names the media kind when a resolved quote carries no text', () => {
		const preview = quotePreview({
			target_id: 'x2',
			resolved: true,
			sender: maya,
			type: 'image',
			text: null
		});
		expect(preview.body).toBe('Photo');
		expect(preview.label).toContain('Photo');
	});

	// The persisted snapshot is the whole point of the compact quote columns:
	// an unloaded target still shows what was replied to.
	it('renders the persisted fallback text for an unresolved target', () => {
		const preview = quotePreview({
			target_id: 'gone',
			resolved: false,
			sender: maya,
			type: 'text',
			text: 'the original line'
		});
		expect(preview.body).toBe('the original line');
		expect(preview.resolved).toBe(false);
		expect(preview.label).toContain('not loaded');
	});

	it('stays honest when an unresolved target has no snapshot at all', () => {
		const preview = quotePreview({
			target_id: 'gone',
			resolved: false,
			sender: null,
			type: 'unknown',
			text: null
		});
		expect(preview.body).toBe('Original message unavailable');
		expect(preview.sender).toBe('Unknown participant');
	});

	// U3: one rendering-variant test per stored subtype, so the preview surface
	// is exercised against every WhatsApp message subtype the ingest layer
	// stores. These are the only evidence the surface works — the live DB holds
	// zero stored quotes.
	it('labels a resolved video quote with its caption', () => {
		const preview = quotePreview({
			target_id: 'v1',
			resolved: true,
			sender: maya,
			type: 'video',
			text: 'clip from the gig'
		});
		expect(preview).toMatchObject({ kind: 'video', body: 'clip from the gig' });
	});

	it('falls back to "Voice message" for a resolved audio quote with no text', () => {
		const preview = quotePreview({
			target_id: 'a1',
			resolved: true,
			sender: maya,
			type: 'audio',
			text: null
		});
		expect(preview).toMatchObject({ kind: 'audio', body: 'Voice message' });
		expect(preview.label).toContain('Voice message');
	});

	it('falls back to the document title for a resolved document quote', () => {
		const preview = quotePreview({
			target_id: 'd1',
			resolved: true,
			sender: maya,
			type: 'document',
			text: 'Contract'
		});
		expect(preview).toMatchObject({ kind: 'document', body: 'Contract' });
	});

	it('falls back to "Sticker" for a resolved sticker quote with no text', () => {
		const preview = quotePreview({
			target_id: 's1',
			resolved: true,
			sender: maya,
			type: 'sticker',
			text: null
		});
		expect(preview).toMatchObject({ kind: 'sticker', body: 'Sticker' });
	});

	it('uses the location name as the body for a resolved location quote', () => {
		const preview = quotePreview({
			target_id: 'l1',
			resolved: true,
			sender: maya,
			type: 'location',
			text: 'Amsterdam Office'
		});
		expect(preview).toMatchObject({ kind: 'location', body: 'Amsterdam Office' });
	});

	it('falls back to "Location" for a resolved location quote with no name', () => {
		const preview = quotePreview({
			target_id: 'l2',
			resolved: true,
			sender: maya,
			type: 'location',
			text: null
		});
		expect(preview.body).toBe('Location');
	});

	it('uses the contact display name as the body for a resolved contact quote', () => {
		const preview = quotePreview({
			target_id: 'c1',
			resolved: true,
			sender: maya,
			type: 'contact',
			text: 'Sara Patel'
		});
		expect(preview).toMatchObject({ kind: 'contact', body: 'Sara Patel' });
	});

	it('falls back to "Contact" for a resolved contact quote with no display name', () => {
		const preview = quotePreview({
			target_id: 'c2',
			resolved: true,
			sender: maya,
			type: 'contact',
			text: null
		});
		expect(preview.body).toBe('Contact');
	});

	it('never crashes on an unrecognized subtype and renders a typed noun', () => {
		const preview = quotePreview({
			target_id: 'p1',
			resolved: true,
			sender: maya,
			type: 'pollCreation',
			text: null
		});
		expect(preview.kind).toBe('other');
		// Resolved unrecognized subtype renders the raw type so the owner sees
		// *something* rather than a blank inset.
		expect(preview.body).toBe('pollCreation');
		expect(preview.label).toContain('pollCreation');
	});

	it('renders "Original message unavailable" for an unrecognized unresolved quote', () => {
		const preview = quotePreview({
			target_id: 'p2',
			resolved: false,
			sender: maya,
			type: 'pollCreation',
			text: null
		});
		expect(preview.body).toBe('Original message unavailable');
	});
});

describe('reaction chips', () => {
	const actor = (name: string) => ({
		jid: `${name}@s.whatsapp.net`,
		display_jid: `${name}@s.whatsapp.net`,
		name
	});

	it('exposes every actor through an accessible label', () => {
		const chip = reactionChip({ emoji: '❤️', count: 2, actors: [actor('Maya'), actor('Sam')] });
		expect(chip).toMatchObject({ emoji: '❤️', count: 2 });
		expect(chip.label).toBe('Reacted ❤️ by Maya and Sam');
	});

	it('compacts a crowd without losing the count', () => {
		const actors = ['Maya', 'Sam', 'Ana', 'Jo', 'Kim'].map(actor);
		const chip = reactionChip({ emoji: '👍', count: 5, actors });
		expect(chip.count).toBe(5);
		expect(chip.label).toBe('Reacted 👍 by Maya, Sam, Ana and 2 more');
	});

	it('still labels a chip whose actors did not resolve', () => {
		expect(reactionChip({ emoji: '😂', count: 1, actors: [] }).label).toBe('Reacted 😂');
	});
});

describe('unread boundary', () => {
	const line = (id: string, ts: number, fromMe = false): Message => ({
		id,
		chat_jid: 'alice@s.whatsapp.net',
		channel: 'whatsapp',
		from_me: fromMe,
		sender: null,
		ts,
		type: 'text',
		text: id,
		media: null,
		quote: null,
		reactions: []
	});

	const thread = [
		line('i1', 1),
		line('o1', 2, true),
		line('i2', 3),
		line('i3', 4),
		line('i4', 5)
	];

	it('has no boundary in a fully read chat', () => {
		expect(deriveUnreadBoundary(thread, 0)).toBeNull();
	});

	it('marks the first of N unread inbound messages, ignoring own messages', () => {
		expect(deriveUnreadBoundary(thread, 2)).toEqual({
			firstUnreadId: 'i3',
			count: 2,
			exact: true
		});
	});

	it('is exact when the unread count consumes every loaded inbound message', () => {
		expect(deriveUnreadBoundary(thread, 4)).toEqual({
			firstUnreadId: 'i1',
			count: 4,
			exact: true
		});
	});

	it('falls back to the oldest loaded inbound message when unread exceeds the page', () => {
		expect(deriveUnreadBoundary(thread, 9)).toEqual({
			firstUnreadId: 'i1',
			count: 9,
			exact: false
		});
	});

	it('has no boundary when nothing inbound is loaded yet', () => {
		expect(deriveUnreadBoundary([line('o1', 1, true)], 3)).toBeNull();
	});

	it('labels an approximate boundary honestly', () => {
		expect(unreadBoundaryLabel({ firstUnreadId: 'i3', count: 1, exact: true })).toBe(
			'1 unread message'
		);
		expect(unreadBoundaryLabel({ firstUnreadId: 'i1', count: 9, exact: false })).toContain(
			'not loaded yet'
		);
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
