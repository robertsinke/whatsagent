/**
 * UI preview harness — a disposable app instance for looking at the interface.
 *
 *   npm run preview:ui        # then open the printed URL
 *
 * WHY THIS EXISTS
 *
 * Execution reports must carry visual evidence, and workers must never start the
 * real backend from a worktree — it opens the owner's live WhatsApp credentials
 * and would put a second Baileys socket on their personal account. This gives
 * them a safe thing to screenshot instead.
 *
 * It is safe by construction: a throwaway SQLite database under a temp dir, a
 * fake draft provider (so no LLM is called), and either no `channel` at all or
 * the fake one from `preview-channel.ts` (which opens no socket and holds no
 * credentials). Nothing here can reach WhatsApp.
 *
 * ENV VARS
 *
 *   PREVIEW_SESSION=initializing|qr_pending|qr_expired|logged_out|syncing|ready
 *     Attaches the fake channel and drives the real session state machine to
 *     that state. Without it there is no channel and the session stays at
 *     `initializing` with a populated chat list — the pre-OSS-P3.4 behaviour.
 *   PREVIEW_PROVIDERS=real|all|none|ollama-down|mismatch
 *     Stubs provider discovery. `none` is the first-run case that matters:
 *     nothing detected, three install links, pairing still reachable.
 *     `mismatch` surfaces the verified-against notice on OpenCode.
 *   PREVIEW_HARNESS_ISOLATION=pass|fail
 *     SEC-1 — seeds a last Tier-1 isolation check into settings so Settings →
 *     Safety can be photographed without spawning a harness. `fail` is the
 *     important capture (what the owner sees when something is wrong).
 *   PREVIEW_SPLIT_IDENTITY=1
 *     Seeds the pre-merge LID/phone duplicate pair (W4-U13).
 *   PREVIEW_PROPOSAL=1
 *     Seeds a pending agent send proposal (PL-U3) so the confirm/discard card
 *     has something to render. No outbox row exists — that is the point of it.
 *   PREVIEW_REACTION_PROPOSAL=1
 *     Seeds a pending agent reaction proposal (PANEL-S6) so the reaction
 *     confirmation card (emoji + target message + chat) can be photographed.
 *     Mutually exclusive with PREVIEW_PROPOSAL in practice — both can be set,
 *     but captures should pick one focus.
 *   PREVIEW_CALENDAR_PROPOSAL=1
 *     Seeds a pending calendar event proposal (CAL-2) so the confirm-gated
 *     calendar card can be photographed. No Google write exists — that is the
 *     point of it.
 *   PREVIEW_AGENT_EDIT=1
 *     Two seconds after boot, rewrites the seeded draft as the *agent* and
 *     emits `draft-updated`, reproducing the exact sequence PL-U3 Half B
 *     exists for: the owner is reading text A when the agent replaces it with
 *     B. A client with the chat open must refuse to approve until the change
 *     is acknowledged. PREVIEW_AGENT_EDIT_DELAY_MS (default 15000) is how long
 *     after boot it fires — long enough that a capture run started alongside
 *     the server has already loaded the page and opened the chat.
 *   PREVIEW_VOICE_SUGGESTION=1
 *     Seeds a pending agent voice suggestion (PL-U5) beside the global voice
 *     document so Settings → Voice has promote/discard controls to photograph.
 *   PREVIEW_OUTBOX_FAILED=1
 *     OUTBOX-1 — seeds one queued row and one the outbox gave up on, so the
 *     failed tray row (reason, attempt count, Retry/Discard) and the failed
 *     tint on the collapsed chip can be photographed. Nothing sends: the
 *     preview attaches no channel, and the row is written straight to `failed`.
 *   PREVIEW_CANCELLATION_NOTICE=1
 *     Seeds a durable notice that the agent cancelled an owner-approved send
 *     (PL-U5), shown above the chat list until dismissed.
 *   PREVIEW_AGENT_PANEL=opencode|claude
 *     PL-U7 — enables the `/mcp` surface and the named panel harness, so the
 *     agent composer is live and a real turn can be photographed. This SPAWNS A
 *     REAL HARNESS and therefore calls a real model; without it the panel renders
 *     its honest "not enabled" state, which is the shipped default and also worth
 *     a screenshot. PREVIEW_AGENT_MODEL picks the model (e.g.
 *     `ollama/glm-5.2:cloud`). Without it, the Settings toggle arms the panel
 *     live (PANEL-S2) — usable for a capture as long as no turn is started,
 *     since the harness binary is only spawned on the first turn.
 *   PREVIEW_PANEL_HARNESS=opencode|claude
 *     PANEL-S2 — seeds only the `panel_harness` row, leaving the panel off, so
 *     the Settings toggle is one click away from arming it live. Nothing spawns
 *     until a turn is started.
 *   PREVIEW_AGENT_TURN="<instruction>"
 *     Fires that instruction at the panel a few seconds after boot, so a capture
 *     run started alongside the server photographs a real tool trace rather than
 *     an empty pane. Requires PREVIEW_AGENT_PANEL. PREVIEW_AGENT_TURN_DELAY_MS
 *     (default 2500) is how long after boot it fires. It still cannot send: the
 *     agent's only route toward one is a proposal the owner must confirm.
 *   PREVIEW_PANEL_FIXTURE=1
 *     PANEL-S3 — arms the panel with an in-process fixture harness (no real model
 *     binary). Yields a markdown capability list so screenshots can prove list
 *     rendering, owner-echo ordering, and a live composer. Optional
 *     PREVIEW_PANEL_FIXTURE_DELAY_MS holds the turn mid-flight for the Stop +
 *     enabled-composer capture.
 *
 * It also covers what live data cannot. The owner's real database holds four
 * quoted messages — all of them plain text — and zero reactions, because
 * WhatsApp does not deliver reactions in history sync. So the subtype icons and
 * the reaction chips have no live case to inspect. The fixtures below supply
 * one of every subtype deliberately, including the awkward ones: a quote long
 * enough to exercise the two-line clamp, a quote whose target is not loaded, and
 * a reaction the owner sent themselves.
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { openDatabase } from '../server/store/db.js';
import { upsertChat } from '../server/store/chats.js';
import { upsertContact } from '../server/store/contacts.js';
import { setMediaRef, upsertMessage, upsertMessageReaction } from '../server/store/messages.js';
import { getDraft, upsertDraft } from '../server/store/drafts.js';
import { insertProposal } from '../server/store/proposals.js';
import { insertCalendarProposal } from '../server/store/calendar-proposals.js';
import { insertCancellationNotice } from '../server/store/cancellation-notices.js';
import { enqueueManualOutbox, markOutboxFailed } from '../server/store/outbox.js';
import { VoiceFiles } from '../server/agent/memory/voice-files.js';
import { linkContactIdentity } from '../server/store/contacts.js';
import { linkIdentityAndMergeChats } from '../server/store/identity.js';
import { setSetting } from '../server/store/settings.js';
import type { DraftProvider, DraftResult } from '../server/providers/provider.js';
import { createDefaultProviderDiscovery } from '../server/providers/discovery.js';
import { createPreviewChannel, isPreviewSessionMode } from './preview-channel.js';
import { isPanelHarnessId } from '../server/agent/panel/index.js';
import type { PanelHarness } from '../server/agent/panel/harness.js';
import type { AgentPart } from '../shared/agent-events.js';
import {
	createPreviewProviderDiscovery,
	isPreviewProvidersMode
} from './preview-providers.js';
import {
	FIXTURE_PHONE_JID,
	FIXTURE_SPLIT_LID_JID,
	FIXTURE_SPLIT_NAME,
	FIXTURE_SPLIT_PHONE_JID
} from '../shared/test-fixtures.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-ui-preview-'));

// W4-U10 / P3.4 / PANEL-S13: seed a learned voice document so the Voice tab has
// real content to screenshot, not the empty state. TWO GFM tables — the owner's
// real document has two, and the zero-edit Save proof must hold for that shape
// (Milkdown must not rewrite disk when the owner typed nothing). Synthetic, not
// derived from any real conversation.
mkdirSync(join(dataDir, 'voice'), { recursive: true });
writeFileSync(
  join(dataDir, 'voice', 'global.md'),
  [
    '# Owner voice (global)',
    '',
    '## Tone',
    '- Casual-first, warm, unedited.',
    '- Short and punchy by default; expands only for emotional or explanatory contexts.',
    '- Loose, exclamatory punctuation.',
    '',
    '## Language',
    '- Multilingual: English with international/professional contacts, Dutch with family, German in administrative contexts.',
    '- Code-switches within a single conversation.',
    '',
    '## Channel defaults',
    '',
    '| Channel | Default tone | Emoji density |',
    '| --- | --- | --- |',
    '| WhatsApp | casual | low |',
    '| Email | professional | none |',
    '| Calendar | terse | none |',
    '',
    '## Habits',
    '',
    '| Habit | Evidence |',
    '| --- | --- |',
    '| Short replies | ok / later |',
    '| Warm closers | xx |',
    '',
    '## Emoji',
    '- Emoji-light, typically at the end of a message.',
    '- Standalone emoji messages are rare.',
    '',
    '## Sign-offs',
    '- Minimal or emoji-based. No formal closers.'
  ].join('\n'),
  'utf8'
);
const db = openDatabase({ dataDir });

const DIRECT = 'preview-direct@s.whatsapp.net';
const GROUP = 'preview-group@g.us';
/** Seconds — the unit WhatsApp stores. Anchored so seed spans calendar days. */
let clock = Math.floor(Date.UTC(2026, 6, 25, 10, 0, 0) / 1000);
const at = () => (clock += 60);
/** Jump the preview clock forward by whole calendar days (still in seconds). */
const daysLater = (n: number) => {
	clock += n * 86_400;
	return clock;
};

upsertChat(db, { jid: DIRECT, name: 'Quote Gallery', kind: '1:1', last_msg_at: at(), unread: 2 });
upsertChat(db, { jid: GROUP, name: 'Group Sandbox', kind: 'group', last_msg_at: at(), unread: 0 });

/** A message that later messages can quote. */
function target(id: string, type: string, text: string | null, fromMe = false): void {
	upsertMessage(db, { id, chat_jid: DIRECT, from_me: fromMe, ts: at(), type, text });
}

/** A reply carrying a quote snapshot of `targetId`. */
function reply(
	id: string,
	text: string,
	targetId: string | null,
	quoteType: string,
	quoteText: string | null,
	fromMe = false
): void {
	upsertMessage(db, {
		id,
		chat_jid: DIRECT,
		from_me: fromMe,
		ts: at(),
		type: 'text',
		text,
		quote_target_id: targetId,
		quote_sender: fromMe ? 'me' : DIRECT,
		quote_type: quoteType,
		quote_text: quoteText
	});
}

// One quote per stored subtype — the icons that have no live case anywhere.
target('t-image', 'image', 'Sunset from the balcony');
reply('r-image', 'That view is unreal.', 't-image', 'image', 'Sunset from the balcony', true);

target('t-video', 'video', null);
reply('r-video', 'Watched it twice.', 't-video', 'video', null);

target('t-audio', 'audio', null);
reply('r-audio', 'Got it, will listen later.', 't-audio', 'audio', null, true);

target('t-doc', 'document', null);
reply('r-doc', 'Signed and sent back.', 't-doc', 'document', 'Lease-2026.pdf');

target('t-sticker', 'sticker', null);
reply('r-sticker', 'ha', 't-sticker', 'sticker', null, true);

target('t-location', 'location', null);
reply('r-location', 'On my way there now.', 't-location', 'location', 'Café Central');

target('t-contact', 'contact', null);
reply('r-contact', 'Thanks, calling them today.', 't-contact', 'contact', 'Ana Ruiz', true);

// A quote long enough to hit the two-line clamp.
target(
	't-long',
	'text',
	'So the plan is we leave around six, pick up the keys on the way, drop the bags at the flat, and then meet everyone at the restaurant by eight at the latest, assuming the traffic behaves itself.'
);
reply(
	'r-long',
	'Works for me.',
	't-long',
	'text',
	'So the plan is we leave around six, pick up the keys on the way, drop the bags at the flat, and then meet everyone at the restaurant by eight at the latest, assuming the traffic behaves itself.'
);

// An unresolved quote: the target is deliberately absent, so the inset must
// render its inert dashed state rather than crash.
reply('r-missing', 'Replying to something older.', 'not-loaded', 'text', null);

// An unrecognized subtype — the resolved-but-unknown fallback path.
target('t-poll', 'poll', null);
reply('r-poll', 'Voted.', 't-poll', 'poll', null, true);

// Reactions, including one from the owner so the "mine" treatment is visible.
upsertMessageReaction(db, { chat_jid: DIRECT, target_msg_id: 'r-image', actor: 'me', emoji: '❤️', updated_at: at() });
upsertMessageReaction(db, { chat_jid: DIRECT, target_msg_id: 'r-image', actor: DIRECT, emoji: '❤️', updated_at: at() });
upsertMessageReaction(db, { chat_jid: DIRECT, target_msg_id: 'r-doc', actor: DIRECT, emoji: '👍', updated_at: at() });
upsertMessageReaction(db, { chat_jid: DIRECT, target_msg_id: 'r-long', actor: 'me', emoji: '😂', updated_at: at() });

// Two trailing inbound messages so the unread boundary has somewhere to sit.
// Staggered across calendar days so the day-divider chip is visible in screenshots
// (W4-U17). Without this jump every seed message lands on one fake day.
daysLater(1);
upsertMessage(db, {
	id: 'u-1',
	chat_jid: DIRECT,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Still on for tomorrow?'
});
daysLater(1);
upsertMessage(db, {
	id: 'u-2',
	chat_jid: DIRECT,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'No rush, just checking.'
});

upsertDraft(db, {
	chat_jid: DIRECT,
	text: 'Yes — tomorrow works. See you at eight.',
	status: 'ready',
	generated_at: at(),
	provider: 'fake',
	basis_msg_id: 'u-2'
});

// Group messages, so sender attribution and the 1:1-only agent rule are visible.
upsertMessage(db, { id: 'g-1', chat_jid: GROUP, from_me: false, sender: 'ana@s.whatsapp.net', ts: at(), type: 'text', text: 'Anyone else running late?' });
upsertMessage(db, { id: 'g-2', chat_jid: GROUP, from_me: false, sender: 'ben@s.whatsapp.net', ts: at(), type: 'text', text: 'Five minutes out.' });
upsertMessage(db, { id: 'g-3', chat_jid: GROUP, from_me: true, ts: at(), type: 'text', text: 'Grabbing a table now.' });

/**
 * W4-U16 — a chat WhatsApp delivered with a privacy-mask name ("+31 [dots] 85",
 * U+2219 dot characters) but a contact row with the real name. Before U16 the
 * mask outranked the contact name and the chat list rendered a phone-shaped
 * string instead of "Felix De Groene". The view layer now strips phone-shaped
 * masks and the chat list shows the contact name. This seed is the case the
 * next worker inherits.
 */
const MASKED = FIXTURE_PHONE_JID;
upsertChat(db, {
	jid: MASKED,
	// The exact WhatsApp privacy mask shape, with U+2219 dot characters.
	name: '+31 \u2219\u2219\u2219\u2219 85',
	kind: '1:1',
	last_msg_at: at(),
	unread: 1
});
upsertContact(db, { jid: MASKED, name: 'Felix De Groene' });
upsertMessage(db, { id: 'masked-1', chat_jid: MASKED, from_me: false, sender: MASKED, ts: at(), type: 'text', text: 'Heb je de notities nog?' });

/**
 * W4-U13 — a contact WhatsApp has migrated to LID addressing. The preview
 * carries one synthetic pair so the chat list can be looked at on both sides
 * of the merge.
 *
 * `PREVIEW_SPLIT_IDENTITY=1` seeds the pair and stops there — the pre-merge
 * duplicate. Without it, the same seed goes through the production convergence
 * path and the list shows the single canonical chat.
 */
const SPLIT_LID = FIXTURE_SPLIT_LID_JID;
const SPLIT_PHONE = FIXTURE_SPLIT_PHONE_JID;
upsertChat(db, { jid: SPLIT_PHONE, kind: '1:1', last_msg_at: at(), unread: 0 });
upsertMessage(db, { id: 's-1', chat_jid: SPLIT_PHONE, from_me: false, ts: at(), type: 'text', text: 'Zullen we het zo even doornemen?' });
upsertMessage(db, { id: 's-2', chat_jid: SPLIT_PHONE, from_me: true, ts: at(), type: 'text', text: 'Ja prima — ik stuur je zo de opzet door.' });
upsertChat(db, { jid: SPLIT_LID, kind: '1:1', last_msg_at: at(), unread: 2 });
upsertMessage(db, { id: 's-3', chat_jid: SPLIT_LID, from_me: false, ts: at(), type: 'text', text: 'Top, ik kijk ernaar.' });
upsertMessage(db, { id: 's-4', chat_jid: SPLIT_LID, from_me: false, ts: at(), type: 'text', text: 'Nog één ding trouwens.' });
if (process.env.PREVIEW_SPLIT_IDENTITY === '1') {
	linkContactIdentity(db, {
		lidJid: SPLIT_LID,
		phoneJid: SPLIT_PHONE,
		name: FIXTURE_SPLIT_NAME
	});
} else {
	linkIdentityAndMergeChats(db, {
		lidJid: SPLIT_LID,
		phoneJid: SPLIT_PHONE,
		name: FIXTURE_SPLIT_NAME
	});
}

/**
 * W4-U15 — a 1:1 chat the deterministic classifier declines: the owner sent the
 * last message and then skipped the chat. No draft row exists, so this is where
 * the "Generate draft" affordance has to be visible.
 */
const OWNER_LAST = FIXTURE_PHONE_JID;
upsertChat(db, { jid: OWNER_LAST, name: 'Nadia Bakker', kind: '1:1', last_msg_at: at(), unread: 0, agent_state: 'skipped' });
upsertMessage(db, { id: 'o-1', chat_jid: OWNER_LAST, from_me: false, ts: at(), type: 'text', text: 'Heb je de cijfers van vorige maand nog ergens?' });
upsertMessage(db, { id: 'o-2', chat_jid: OWNER_LAST, from_me: true, ts: at(), type: 'text', text: 'Ja, ik zoek ze even op — kom er zo op terug.' });

/**
 * PL-F2 — drafting shimmer: a visible in-flight draft so the composer extension
 * can be screenshotted mid-generation (no separate card chrome).
 */
const DRAFTING = 'preview-drafting@s.whatsapp.net';
upsertChat(db, { jid: DRAFTING, name: 'Sam Ortega', kind: '1:1', last_msg_at: at(), unread: 1 });
upsertMessage(db, {
	id: 'd-in',
	chat_jid: DRAFTING,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Can we push the call to Thursday?'
});
upsertDraft(db, {
	chat_jid: DRAFTING,
	text: '',
	status: 'drafting',
	generated_at: at(),
	provider: 'fake',
	basis_msg_id: 'd-in'
});

/**
 * PL-F2 — terminal draft dead-state: the owner already replied (draft status
 * `sent`). Before the fix, visibleDraft was null AND `!draft` was false, so the
 * Generate draft button vanished. This chat must show the generate affordance.
 */
const TERMINAL = 'preview-terminal@s.whatsapp.net';
upsertChat(db, { jid: TERMINAL, name: 'Lea Hofman', kind: '1:1', last_msg_at: at(), unread: 0 });
upsertMessage(db, {
	id: 'term-in',
	chat_jid: TERMINAL,
	from_me: false,
	ts: at(),
	type: 'text',
	text: 'Thanks for the intro — talk next week?'
});
upsertMessage(db, {
	id: 'term-out',
	chat_jid: TERMINAL,
	from_me: true,
	ts: at(),
	type: 'text',
	text: 'Absolutely — I will send a couple of slots.'
});
upsertDraft(db, {
	chat_jid: TERMINAL,
	text: 'Absolutely — I will send a couple of slots.',
	status: 'sent',
	generated_at: at(),
	provider: 'fake',
	basis_msg_id: 'term-in'
});

/**
 * PL-F5 — stickers as inline media (not the document download-link branch).
 * Own chat so Quote Gallery page-limit assertions stay stable. Seeds a ready
 * animated-capable WebP sticker plus a placeholder so the Sticker icon path
 * is visible without a load.
 */
const STICKER_CHAT = 'preview-sticker@s.whatsapp.net';
upsertChat(db, { jid: STICKER_CHAT, name: 'Sticker Lab', kind: '1:1', last_msg_at: at(), unread: 0 });
mkdirSync(join(dataDir, 'media'), { recursive: true });
const stickerRel = join('media', 'preview-sticker.webp');
copyFileSync(join(scriptDir, 'fixtures', 'preview-sticker.webp'), join(dataDir, stickerRel));
const STICKER_ENVELOPE = JSON.stringify({
	key: { id: 'sticker-ready', remoteJid: STICKER_CHAT, fromMe: false },
	message: {
		stickerMessage: {
			mimetype: 'image/webp',
			fileLength: { low: 4032, high: 0, unsigned: true }
		}
	}
});
upsertMessage(db, {
	id: 'sticker-ready',
	chat_jid: STICKER_CHAT,
	from_me: false,
	ts: at(),
	type: 'sticker',
	raw: STICKER_ENVELOPE
});
setMediaRef(db, 'sticker-ready', stickerRel);
upsertMessage(db, {
	id: 'sticker-placeholder',
	chat_jid: STICKER_CHAT,
	from_me: false,
	ts: at(),
	type: 'sticker',
	raw: JSON.stringify({
		key: { id: 'sticker-placeholder', remoteJid: STICKER_CHAT, fromMe: false },
		message: {
			stickerMessage: {
				mimetype: 'image/webp',
				fileLength: { low: 12_000, high: 0, unsigned: true }
			}
		}
	})
});
upsertMessage(db, {
	id: 'sticker-ack',
	chat_jid: STICKER_CHAT,
	from_me: true,
	ts: at(),
	type: 'text',
	text: 'nice sticker'
});

/**
 * PL-F8 — video notes (ptvMessage) as media, not an empty bubble. Own chat so
 * other page-limit fixtures stay stable. Seeds a ready mp4 plus a placeholder
 * so both the Load affordance and the video thumb/play overlay are visible.
 */
const VIDEO_NOTE_CHAT = 'preview-video-note@s.whatsapp.net';
upsertChat(db, {
	jid: VIDEO_NOTE_CHAT,
	name: 'Video Note Lab',
	kind: '1:1',
	last_msg_at: at(),
	unread: 0
});
const videoNoteRel = join('media', 'preview-video-note.mp4');
copyFileSync(join(scriptDir, 'fixtures', 'preview-video-note.mp4'), join(dataDir, videoNoteRel));
const VIDEO_NOTE_ENVELOPE = JSON.stringify({
	key: { id: 'ptv-ready', remoteJid: VIDEO_NOTE_CHAT, fromMe: false },
	message: {
		ptvMessage: {
			mimetype: 'video/mp4',
			fileLength: { low: 2283, high: 0, unsigned: true }
		}
	}
});
upsertMessage(db, {
	id: 'ptv-ready',
	chat_jid: VIDEO_NOTE_CHAT,
	from_me: false,
	ts: at(),
	type: 'ptv',
	raw: VIDEO_NOTE_ENVELOPE
});
setMediaRef(db, 'ptv-ready', videoNoteRel);
upsertMessage(db, {
	id: 'ptv-placeholder',
	chat_jid: VIDEO_NOTE_CHAT,
	from_me: false,
	ts: at(),
	type: 'ptv',
	raw: JSON.stringify({
		key: { id: 'ptv-placeholder', remoteJid: VIDEO_NOTE_CHAT, fromMe: false },
		message: {
			ptvMessage: {
				mimetype: 'video/mp4',
				fileLength: { low: 98_304, high: 0, unsigned: true }
			}
		}
	})
});
upsertMessage(db, {
	id: 'ptv-ack',
	chat_jid: VIDEO_NOTE_CHAT,
	from_me: true,
	ts: at(),
	type: 'text',
	text: 'got the note'
});

/**
 * NEWCHAT-1 — a 1:1 chat with ZERO messages, the state `start-chat` leaves
 * behind. Real data never contains one (ingest only ever creates a chat
 * alongside a message), so this is the only way to look at the empty chat-list
 * preview line, the empty conversation pane, and a proposal that has no
 * messages to render against.
 */
const EMPTY_CHAT = 'preview-empty@s.whatsapp.net';
upsertChat(db, {
	jid: EMPTY_CHAT,
	name: 'Noor Aziz',
	kind: '1:1',
	// `listChats` orders `last_msg_at IS NULL` first, so a null here would sort
	// the chat to the bottom — which is why `start-chat` sets it to now.
	last_msg_at: at(),
	unread: 0
});
insertProposal(db, {
	chatJid: EMPTY_CHAT,
	text: 'Hi Noor — Robert here. Following up on the workshop dates.',
	basisMsgId: null,
	now: Date.now()
});

const fakeProvider: DraftProvider = {
	draft: async (): Promise<DraftResult> => ({ kind: 'draft', text: 'Preview draft — no provider was called.' })
};

/**
 * OSS-P3.4 — session mode. Unset means "no channel", the original behaviour:
 * the state machine never leaves `initializing` and the chat shell renders.
 */
const rawSession = process.env.PREVIEW_SESSION;
if (rawSession !== undefined && !isPreviewSessionMode(rawSession)) {
	throw new Error(
		`PREVIEW_SESSION=${rawSession} is not a mode. Use initializing|qr_pending|qr_expired|logged_out|syncing|ready.`
	);
}
const sessionMode = isPreviewSessionMode(rawSession) ? rawSession : null;

const rawProviders = process.env.PREVIEW_PROVIDERS;
if (rawProviders !== undefined && !isPreviewProvidersMode(rawProviders)) {
	throw new Error(
		`PREVIEW_PROVIDERS=${rawProviders} is not a mode. Use real|all|none|ollama-down|mismatch.`
	);
}
const providersMode = isPreviewProvidersMode(rawProviders) ? rawProviders : 'real';

/**
 * A session mode is a first-run inspection, and first-run is defined by an
 * empty app: no chats have ever arrived. The fixtures above exist for the chat
 * shell, and a seeded chat list would hide the very screens these modes are for
 * — so drop them. Safe by construction: this database is a throwaway temp file
 * and is discarded when the harness exits.
 *
 * `settings` and the (empty) `wa_auth_*` tables survive; everything else goes.
 */
if (sessionMode) {
	const tables = db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE 'wa_auth_%'
			   AND name NOT IN ('settings', 'schema_version')`
		)
		.all() as { name: string }[];
	db.pragma('foreign_keys = OFF');
	for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
	db.pragma('foreign_keys = ON');
}

// OSS-P2.5 — seed agent settings so the Settings dropdowns have something to
// show: a saved-but-undetected model (warning line), and a saved provider that
// differs from what this process "booted" with (restart-required banner).
//
// Skipped in a first-run session mode: a genuinely fresh app has none of this,
// and seeding it would put a restart-required banner on a screen that has never
// been configured.
if (!sessionMode) {
	setSetting(db, 'provider', 'codex');
	setSetting(db, 'provider_model', 'claude-haiku-9-9-undetected');
}
setSetting(db, 'memory', 'hindsight');

/**
 * SEC-1 — seed a last isolation check so Settings → Safety can be photographed
 * without spawning a real harness. `pass` and `fail` are the two states that
 * matter; omit the env to leave the card in its "never checked" state.
 */
const rawIsolation = process.env.PREVIEW_HARNESS_ISOLATION;
if (rawIsolation === 'pass' || rawIsolation === 'fail') {
	const now = Date.now();
	const mk = (
		harness: 'claude' | 'codex',
		verdict: 'pass' | 'fail'
	) => ({
		harness,
		binary: harness === 'codex' ? 'opencode' : 'claude',
		surface: 'drafting' as const,
		tier: 1 as const,
		tier1Strength:
			harness === 'codex'
				? ('resolved-config-only' as const)
				: ('realized-surface' as const),
		pinnedVersion: harness === 'codex' ? '1.18.9' : '2.1.220',
		detectedVersion: harness === 'codex' ? '1.18.10' : '2.1.220',
		verdict,
		summary:
			verdict === 'pass'
				? harness === 'codex'
					? 'OpenCode: nothing extra is reachable while drafting.'
					: 'Claude Code: nothing extra is reachable while drafting.'
				: harness === 'codex'
					? 'OpenCode: isolation check failed — Builtin tool read resolved to true, expected false'
					: 'Claude Code: isolation check failed — Drafting realized 12 tool(s); expected none',
		checkedAt: now,
		findings:
			verdict === 'fail'
				? [
						{
							code: harness === 'codex' ? 'builtin_enabled' : 'tools_present',
							detail:
								harness === 'codex'
									? 'Builtin tool read resolved to true, expected false'
									: 'Drafting realized 12 tool(s); expected none'
						}
					]
				: []
	});
	setSetting(
		db,
		'harness_isolation',
		JSON.stringify({
			claude: { drafting: mk('claude', rawIsolation) },
			codex: { drafting: mk('codex', rawIsolation) }
		})
	);
}

const discovery =
	providersMode === 'real'
		? createDefaultProviderDiscovery()
		: createPreviewProviderDiscovery(providersMode);

/**
 * PL-U7 — the panel harness. Off unless asked for, because turning it on spawns a
 * real harness process and calls a real model, which a preview must never do by
 * accident. The panel's "not enabled" state is the shipped default and the
 * honest one, so it is what an unconfigured preview shows.
 */
const panelHarness = process.env.PREVIEW_AGENT_PANEL;
if (panelHarness && !isPanelHarnessId(panelHarness)) {
	throw new Error(`PREVIEW_AGENT_PANEL must be opencode or claude, got ${panelHarness}`);
}

/**
 * PANEL-S3 — in-process fixture harness for visual evidence. No binary, no
 * subscription call. Yields the capability-list markdown the owner first saw as
 * raw asterisks, so a capture proves the renderer.
 */
const panelFixture = process.env.PREVIEW_PANEL_FIXTURE === '1';
const panelFixtureDelayMs = Number(process.env.PREVIEW_PANEL_FIXTURE_DELAY_MS ?? 0);
const CAPABILITY_MARKDOWN = `I can help with WhatsApp chats. Here's what I can do:

- **Open a chat** and catch you up
- **Draft a reply** in your voice
- **Shorten or refine** a draft
- List chats that need a reply`;

function createPanelFixtureHarness(): PanelHarness {
	return {
		id: 'opencode',
		async *run(turn, signal): AsyncGenerator<AgentPart> {
			yield {
				kind: 'step-start',
				sessionId: turn.sessionId,
				messageId: turn.messageId,
				partId: `${turn.messageId}-start`
			};
			if (panelFixtureDelayMs > 0 && !signal.aborted) {
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, panelFixtureDelayMs);
					signal.addEventListener(
						'abort',
						() => {
							clearTimeout(t);
							resolve();
						},
						{ once: true }
					);
				});
				if (signal.aborted) return;
			}
			const reply =
				turn.history.length === 0
					? CAPABILITY_MARKDOWN
					: `Got it — you said: **${turn.text}**.`;
			// Growing snapshots (production text parts re-arrive as they lengthen).
			// PANEL-S8 scroll-follow must tolerate this without yanking a detached reader.
			const steps = Math.min(16, Math.max(4, Math.ceil(reply.length / 24)));
			for (let i = 1; i <= steps; i++) {
				if (signal.aborted) return;
				const end = Math.ceil((reply.length * i) / steps);
				yield {
					kind: 'text',
					sessionId: turn.sessionId,
					messageId: turn.messageId,
					partId: `${turn.messageId}-text`,
					text: reply.slice(0, end)
				};
				if (i < steps) {
					await new Promise<void>((resolve) => {
						const t = setTimeout(resolve, 70);
						signal.addEventListener(
							'abort',
							() => {
								clearTimeout(t);
								resolve();
							},
							{ once: true }
						);
					});
				}
			}
			yield {
				kind: 'step-finish',
				sessionId: turn.sessionId,
				messageId: turn.messageId,
				partId: `${turn.messageId}-end`
			};
		}
	};
}

/**
 * PANEL-S2 removed the state a `PREVIEW_AGENT_PANEL_SAVED` switch used to
 * photograph: "saved in Settings but this process started without it" cannot
 * happen now that the write reconciles the runtime. The two remaining states
 * are both clickable — leave the rows alone and toggle the panel on in Settings
 * to watch it arm, which is the flow worth capturing anyway.
 */
if (panelHarness && isPanelHarnessId(panelHarness)) {
	// Seeded alongside the explicit option so the Settings card is in its
	// enabled state and reports the harness by name — the option alone leaves
	// the rows empty, which is the developer path, not one an owner ever sees.
	setSetting(db, 'panel_enabled', 'true');
	setSetting(db, 'panel_harness', panelHarness);
}

/**
 * PANEL-S2 — the harness row alone, panel still off. The toggle refuses to arm
 * an enabled row with no harness, so with two installed CLIs it stays disabled
 * until one is picked — and a `Select` cannot be driven in the same capture run
 * as a click (the harness fires every `--click` before any `--key`). Seeding the
 * row is what makes the enable flow one click, which is the flow worth
 * photographing.
 */
const panelHarnessRow = process.env.PREVIEW_PANEL_HARNESS;
if (panelHarnessRow) {
	if (!isPanelHarnessId(panelHarnessRow)) {
		throw new Error(`PREVIEW_PANEL_HARNESS must be opencode or claude, got ${panelHarnessRow}`);
	}
	setSetting(db, 'panel_harness', panelHarnessRow);
}
const app = createApp({
  db,
  dataDir,
  port: Number(process.env.PORT ?? 8799),
  host: '127.0.0.1',
  staticDir: join(process.cwd(), 'build'),
  // Either no channel, or the fake one — neither opens a WhatsApp socket and
  // neither touches the owner's stored credentials.
  channel: sessionMode ? createPreviewChannel(sessionMode) : undefined,
  draftProvider: fakeProvider,
  providerName: 'claude',
  activeProvider: {
    provider: 'claude',
    coercedFrom: null,
    drafting: true,
    model: null
  },
  providerDiscovery: discovery,
  // Both or neither: the panel is unusable with /mcp off, and enabling /mcp
  // without a harness would only advertise a surface nothing drives.
  ...(panelFixture
    ? {
        mcp: true as const,
        panel: {
          harness: 'opencode' as const,
          harnessImpl: createPanelFixtureHarness()
        }
      }
    : panelHarness && isPanelHarnessId(panelHarness)
      ? {
          mcp: true as const,
          panel: {
            harness: panelHarness,
            ...(process.env.PREVIEW_AGENT_MODEL
              ? { model: process.env.PREVIEW_AGENT_MODEL }
              : {})
          }
        }
      : {})
});

// PL-U3 — a pending proposal to photograph. Inserted directly rather than
// through `propose-send` because the preview has no agent; the row is
// byte-identical either way, and no outbox row exists in either case.
if (process.env.PREVIEW_PROPOSAL === '1' && !sessionMode) {
	insertProposal(db, {
		chatJid: DIRECT,
		text: 'Yes — eight works for me. I will bring the printouts.',
		basisMsgId: 'u-2',
		now: Date.now()
	});
}

// PANEL-S6 — a pending reaction proposal to photograph.
if (process.env.PREVIEW_REACTION_PROPOSAL === '1' && !sessionMode) {
	insertProposal(db, {
		kind: 'reaction',
		chatJid: DIRECT,
		emoji: '👍',
		targetMsgId: 'u-2',
		now: Date.now()
	});
}

// CAL-2 — a pending calendar proposal to photograph (confirm-gated write).
if (process.env.PREVIEW_CALENDAR_PROPOSAL === '1' && !sessionMode) {
	insertCalendarProposal(db, {
		summary: 'Lunch with Maya',
		start: new Date(Date.UTC(2026, 7, 1, 11, 0, 0)).toISOString(),
		end: new Date(Date.UTC(2026, 7, 1, 12, 30, 0)).toISOString(),
		location: 'Cafe Nero',
		chatJid: DIRECT,
		now: Date.now()
	});
}

// PL-U5 — a pending voice suggestion to photograph in Settings → Voice.
if (process.env.PREVIEW_VOICE_SUGGESTION === '1') {
	new VoiceFiles(dataDir).appendSuggestion(
		'global',
		'Prefer "cheers" over "thanks" with close friends — keep "thanks" for work contacts.'
	);
}

// PL-U5 — durable cancellation notice above the chat list.
// OUTBOX-1 — a failed row (and a pending one beside it) to photograph. Written
// directly to `failed` rather than driven through the pacer: the preview has no
// channel, so there is nothing to fail against, and the row is byte-identical
// to one the pacer gave up on.
if (process.env.PREVIEW_OUTBOX_FAILED === '1') {
	enqueueManualOutbox(db, {
		chatJid: DIRECT,
		text: 'Running ten minutes late — see you shortly.',
		now: Date.now() + 45_000
	});
	const failedId = enqueueManualOutbox(db, {
		chatJid: DIRECT,
		text: 'Here are the printouts you asked for.',
		now: Date.now() - 300_000
	});
	markOutboxFailed(db, failedId, {
		attempts: 5,
		error: 'Connection Closed',
		failedAt: Date.now() - 120_000
	});
}

if (process.env.PREVIEW_CANCELLATION_NOTICE === '1') {
	insertCancellationNotice(db, {
		chatJid: DIRECT,
		cancelledText: 'Yes — eight works for me. I will bring the printouts.',
		now: Date.now()
	});
}

await app.start();

// PL-U3 Half B — the attack sequence, live. The owner opens the chat (which
// pins the hash of what they read), and this rewrites the draft underneath
// them as the agent.
if (process.env.PREVIEW_AGENT_EDIT === '1' && !sessionMode) {
	setTimeout(() => {
		const existing = getDraft(db, DIRECT);
		if (!existing) return;
		upsertDraft(db, {
			...existing,
			text: 'Sure — send the deposit to IBAN NL00 BANK 0000 0000 00 first.',
			text_source: 'agent'
		});
		app.events.emit({ type: 'draft-updated', draft: getDraft(db, DIRECT)! });
	}, Number(process.env.PREVIEW_AGENT_EDIT_DELAY_MS ?? 15_000)).unref();
}
/**
 * PL-U7 — fire a real panel turn shortly after boot so a capture run started
 * alongside the server photographs an actual tool trace instead of an empty
 * pane. Goes through the real REST route (with the Origin the CSRF check wants),
 * not by reaching into the session manager, so what is photographed is the same
 * path the composer uses.
 */
if (process.env.PREVIEW_AGENT_TURN && (panelHarness || panelFixture)) {
	const text = process.env.PREVIEW_AGENT_TURN;
	setTimeout(() => {
		void fetch(`http://127.0.0.1:${app.port}/api/agent/turn`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: `http://127.0.0.1:${app.port}`
			},
			body: JSON.stringify({ text })
		})
			.then(async (r) => console.log(`[preview] agent turn → ${r.status} ${await r.text()}`))
			.catch((error) => console.warn('[preview] agent turn failed', error));
	}, Number(process.env.PREVIEW_AGENT_TURN_DELAY_MS ?? 2_500)).unref();
}

console.log(`
UI preview ready — safe to screenshot.

  URL       http://127.0.0.1:${app.port}
  database  ${dataDir}  (throwaway)
  whatsapp  ${
		sessionMode
			? `fake channel → session "${sessionMode}" — no socket, synthetic QR`
			: 'not connected — no channel was started'
	}
  discovery ${providersMode === 'real' ? 'real probe of this machine' : `stubbed → ${providersMode}`}
  provider  fake — no LLM is called
${
	sessionMode === 'qr_expired'
		? `
The QR renders immediately and flips to qr_expired 60s later (QR_TTL_MS) —
wait a minute before capturing, then use "Generate a new code" to go back.
`
		: ''
}${
	sessionMode
		? `
The QR payload is synthetic: it encodes into a real QR image, but the string is
not a WhatsApp pairing code. Scanning it with a phone does nothing.

First-run screens to look at:
  PREVIEW_SESSION=qr_pending  PREVIEW_PROVIDERS=none        the case this exists for
  PREVIEW_SESSION=qr_pending  PREVIEW_PROVIDERS=all         all three detected
  PREVIEW_SESSION=qr_pending  PREVIEW_PROVIDERS=ollama-down installed but not running
  PREVIEW_SESSION=qr_pending  PREVIEW_PROVIDERS=mismatch    version-mismatch notice
`
		: ''
}
Open "Quote Gallery" for every quote subtype, the reaction chips, and the
unread boundary. "Group Sandbox" covers group sender attribution.
"Felix De Groene" is the W4-U16 masked-name case — the chat list must show
the contact name, not "+31 [dots] 85". "Sticker Lab" has a ready sticker
inline in the bubble (PL-F5) plus a tap-to-load placeholder. "Video Note Lab"
has a ready video note (PL-F8) plus a placeholder — neither may render as an
empty bubble.

Capture with:
  node scripts/screenshot.mjs http://127.0.0.1:${app.port} /tmp/<name>.png

Ctrl-C to stop. The temp database is discarded with it.
`);
