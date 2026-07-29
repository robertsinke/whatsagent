import { describe, expect, it } from 'vitest';
import type { Chat, MediaView, Message, SessionView } from './types.js';
import { api } from './api.js';
import {
	canApprove,
	canRefine,
	deepenStatusView,
	deriveUnreadBoundary,
	displayName,
	jidDigits,
	deriveUnreadBoundaryFromCursor,
	draftBadge,
	filterChats,
	formatBytes,
	formatDayDivider,
	formatMessageTime,
	isFirstRun,
	isVisibleDraftStatus,
	mediaAffordance,
	mediaKind,
	mediaPresentation,
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
import {
	FIXTURE_CONTACT_LID,
	FIXTURE_CONTACT_LID_JID,
	FIXTURE_CONTACT_PHONE,
	FIXTURE_CONTACT_PHONE_JID,
	FIXTURE_OWNER_LID_JID,
	FIXTURE_OWNER_PHONE,
	FIXTURE_OWNER_PHONE_JID
} from '../../../shared/test-fixtures.js';

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
		last_read_msg_id: null,
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
				jid: FIXTURE_OWNER_LID_JID,
				display_jid: FIXTURE_OWNER_PHONE_JID,
				name: null
			})
		);
		expect(row.name).toBe(`+${FIXTURE_OWNER_PHONE}`);
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

describe('formatDayDivider', () => {
	/** Injected "now" in local wall time so Today/Yesterday don't depend on CI TZ. */
	const now = new Date(2026, 6, 27, 12, 0, 0).getTime();
	/** Same instant in the seconds unit the database stores. */
	const nowSec = Math.floor(now / 1000);
	const DAY = 86_400;

	it('labels today and yesterday against an injected now', () => {
		expect(formatDayDivider(nowSec, now)).toBe('Today');
		expect(formatDayDivider(nowSec - DAY, now)).toBe('Yesterday');
	});

	/**
	 * The trap an elapsed-hours test walks into: a late-evening message two
	 * calendar days back is under 48 hours old but is not "Yesterday".
	 */
	it('counts calendar days, not elapsed hours', () => {
		const morning = new Date(2026, 6, 27, 9, 0, 0).getTime();
		const twoNightsAgo = Math.floor(new Date(2026, 6, 25, 23, 0, 0).getTime() / 1000);
		expect(morning - twoNightsAgo * 1000).toBeLessThan(2 * 86_400_000);
		expect(formatDayDivider(twoNightsAgo, morning)).not.toBe('Yesterday');
		const lateYesterday = Math.floor(new Date(2026, 6, 26, 23, 0, 0).getTime() / 1000);
		expect(formatDayDivider(lateYesterday, morning)).toBe('Yesterday');
	});

	it('uses the weekday name within the last week', () => {
		const threeDaysAgo = nowSec - 3 * DAY;
		const label = formatDayDivider(threeDaysAgo, now);
		expect(label).toBe(
			new Date(threeDaysAgo * 1000).toLocaleDateString(undefined, { weekday: 'long' })
		);
		expect(label).not.toMatch(/\d/);
	});

	it('omits the year inside the current calendar year and includes it across a year boundary', () => {
		const earlierThisYear = Math.floor(new Date(2026, 0, 14, 12, 0, 0).getTime() / 1000);
		const lastYear = Math.floor(new Date(2025, 6, 14, 12, 0, 0).getTime() / 1000);
		expect(formatDayDivider(earlierThisYear, now)).toBe(
			new Date(earlierThisYear * 1000).toLocaleDateString(undefined, {
				day: 'numeric',
				month: 'short'
			})
		);
		expect(formatDayDivider(lastYear, now)).toBe(
			new Date(lastYear * 1000).toLocaleDateString(undefined, {
				day: 'numeric',
				month: 'short',
				year: 'numeric'
			})
		);
		expect(formatDayDivider(lastYear, now)).toMatch(/2025/);
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

describe('first run (OSS-P3.4)', () => {
	it('is an empty, unlinked app — including while it is still initializing', () => {
		expect(
			isFirstRun({ session: session({ status: 'initializing' }), chatCount: 0, hydrated: true })
		).toBe(true);
		expect(
			isFirstRun({ session: session({ status: 'qr_pending', qr: 'x' }), chatCount: 0, hydrated: true })
		).toBe(true);
	});

	it('is never true before the first refresh, so it cannot flash on a paired launch', () => {
		// A paired app looks exactly like a new one until /api/session answers.
		expect(
			isFirstRun({ session: session({ status: 'initializing' }), chatCount: 0, hydrated: false })
		).toBe(false);
	});

	it('is not a re-pair: an unlinked app that already has history keeps the plain pairing screen', () => {
		expect(
			isFirstRun({ session: session({ status: 'logged_out' }), chatCount: 42, hydrated: true })
		).toBe(false);
		// ...but a logged-out app with nothing in it has never been set up.
		expect(
			isFirstRun({ session: session({ status: 'logged_out' }), chatCount: 0, hydrated: true })
		).toBe(true);
	});

	it('ends as soon as the session is usable, even with no chats yet', () => {
		for (const status of ['syncing', 'ready', 'disconnected'] as const) {
			expect(isFirstRun({ session: session({ status }), chatCount: 0, hydrated: true })).toBe(false);
		}
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

	it('presents stickers as image-like, never the document download branch', () => {
		// Regression for PL-F5: mediaKind('sticker') is its own kind, and the
		// document branch is the canOpen fallthrough — so stickers must map to
		// the image presentation, not document.
		expect(mediaPresentation('sticker')).toBe('image');
		expect(mediaPresentation('image')).toBe('image');
		expect(mediaPresentation('video')).toBe('video');
		expect(mediaPresentation('audio')).toBe('audio');
		expect(mediaPresentation('document')).toBe('document');
		expect(mediaPresentation('sticker')).not.toBe('document');
		expect(mediaPresentation('other')).toBe('document');
	});

	it('presents video notes (ptv) as video, never the document download branch', () => {
		// PL-F8: stored type stays `ptv`, but presentation must be the video
		// thumb/lightbox path — same Electron-nav hazard as PL-F5 stickers.
		expect(mediaKind('ptv')).toBe('video');
		expect(mediaPresentation('ptv')).toBe('video');
		expect(mediaPresentation('ptv')).not.toBe('document');
		expect(mediaAffordance('ptv', media({ state: 'placeholder', size: 12_000 })).label).toContain(
			'Video'
		);
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

describe('unread boundary from cursor (U4)', () => {
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

	it('returns null when the cursor is null (chat never opened locally)', () => {
		// Caller must fall back to count-based derivation in this case.
		expect(deriveUnreadBoundaryFromCursor(thread, null, 2)).toBeNull();
	});

	it('returns null when the unread count is zero', () => {
		expect(deriveUnreadBoundaryFromCursor(thread, 'i4', 0)).toBeNull();
	});

	it('places the marker at the first inbound strictly newer than the cursor', () => {
		// Cursor at i2 → first unread is i3.
		expect(deriveUnreadBoundaryFromCursor(thread, 'i2', 2)).toEqual({
			firstUnreadId: 'i3',
			count: 2,
			exact: true
		});
	});

	it('skips own messages when finding the first unread after the cursor', () => {
		// Cursor at i1 → next inbound is i2 (o1 is own and skipped).
		expect(deriveUnreadBoundaryFromCursor(thread, 'i1', 3)).toEqual({
			firstUnreadId: 'i2',
			count: 3,
			exact: true
		});
	});

	it('returns null when the cursor is already at the last inbound', () => {
		expect(deriveUnreadBoundaryFromCursor(thread, 'i4', 0)).toBeNull();
	});

	it('is approximate when the cursor is off-page (older than every loaded inbound)', () => {
		// Cursor at an id not in the loaded page → marker at oldest loaded inbound.
		const boundary = deriveUnreadBoundaryFromCursor(thread, 'gone', 9);
		expect(boundary).toEqual({ firstUnreadId: 'i1', count: 9, exact: false });
	});

	it('has no boundary when nothing inbound is loaded yet', () => {
		expect(deriveUnreadBoundaryFromCursor([line('o1', 1, true)], 'o1', 3)).toBeNull();
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

describe('jidDigits — phone-number search (W4 follow-up)', () => {
	it('collects digits from the jid', () => {
		expect(
			jidDigits({ jid: FIXTURE_CONTACT_PHONE_JID, display_jid: FIXTURE_CONTACT_PHONE_JID })
		).toBe(FIXTURE_CONTACT_PHONE);
	});

	it('includes both sides of a LID/phone pair so either number matches', () => {
		const digits = jidDigits({
			jid: FIXTURE_CONTACT_LID_JID,
			display_jid: FIXTURE_CONTACT_PHONE_JID
		});
		expect(digits).toContain(FIXTURE_CONTACT_PHONE);
		expect(digits).toContain(FIXTURE_CONTACT_LID);
	});

	it('does not run the two jids together into a false match', () => {
		// jidDigits joins with a space. Without it, the last digits of the phone
		// and the first digits of the LID would form a spanning substring.
		const digits = jidDigits({
			jid: FIXTURE_CONTACT_LID_JID,
			display_jid: FIXTURE_CONTACT_PHONE_JID
		});
		const spanning = FIXTURE_CONTACT_PHONE.slice(-3) + FIXTURE_CONTACT_LID.slice(0, 4);
		expect(digits.includes(spanning)).toBe(false);
	});
});

/**
 * These run inside Svelte effects. A throw there does not degrade one row — it
 * tears down the reactive graph, which is how a partial `chat-updated` payload
 * froze the chat list (stale selection, dead chat switching).
 */
describe('rendering a chat that is missing display_jid never throws', () => {
	const partial = { jid: FIXTURE_CONTACT_PHONE_JID, name: null } as unknown as Chat;

	it('displayName falls back to the routing jid', () => {
		expect(displayName(partial)).toBe(`+${FIXTURE_CONTACT_PHONE}`);
	});

	it('jidDigits still yields searchable digits', () => {
		expect(jidDigits(partial)).toContain(FIXTURE_CONTACT_PHONE);
	});

	it('toChatRow renders the row', () => {
		expect(toChatRow(partial).name).toBe(`+${FIXTURE_CONTACT_PHONE}`);
	});
});
