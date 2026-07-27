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
 * It is safe by construction: a throwaway SQLite database under a temp dir, no
 * `channel` passed to `createApp` (so no WhatsApp socket is ever opened), and a
 * fake draft provider (so no LLM is called). Nothing here can reach WhatsApp.
 *
 * It also covers what live data cannot. The owner's real database holds four
 * quoted messages — all of them plain text — and zero reactions, because
 * WhatsApp does not deliver reactions in history sync. So the subtype icons and
 * the reaction chips have no live case to inspect. The fixtures below supply
 * one of every subtype deliberately, including the awkward ones: a quote long
 * enough to exercise the two-line clamp, a quote whose target is not loaded, and
 * a reaction the owner sent themselves.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { openDatabase } from '../server/store/db.js';
import { upsertChat } from '../server/store/chats.js';
import { upsertContact } from '../server/store/contacts.js';
import { upsertMessage, upsertMessageReaction } from '../server/store/messages.js';
import { upsertDraft } from '../server/store/drafts.js';
import { linkContactIdentity } from '../server/store/contacts.js';
import { linkIdentityAndMergeChats } from '../server/store/identity.js';
import type { DraftProvider, DraftResult } from '../server/providers/provider.js';

const dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-ui-preview-'));

// W4-U10: seed a learned voice document so the new Voice tab has real content
// to screenshot, not the empty state. Synthetic, not derived from any real
// conversation — the inspector is read-only and the file is a Hindsight mirror.
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
const MASKED = '31612345678@s.whatsapp.net';
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
 * W4-U13 — a contact WhatsApp has migrated to LID addressing. The owner's real
 * data now contains four of these; the preview carries one so the chat list can
 * be looked at on both sides of the merge.
 *
 * `PREVIEW_SPLIT_IDENTITY=1` seeds the pair and stops there — the duplicate the
 * owner actually saw. Without it, the same seed goes through the production
 * convergence path and the list shows the single canonical chat.
 */
const SPLIT_LID = '27599493410860@lid';
const SPLIT_PHONE = '31618155142@s.whatsapp.net';
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
		name: 'Quinten Muller'
	});
} else {
	linkIdentityAndMergeChats(db, {
		lidJid: SPLIT_LID,
		phoneJid: SPLIT_PHONE,
		name: 'Quinten Muller'
	});
}

/**
 * W4-U15 — a 1:1 chat the deterministic classifier declines: the owner sent the
 * last message and then skipped the chat. No draft row exists, so this is where
 * the "Generate draft" affordance has to be visible.
 */
const OWNER_LAST = '31612345678@s.whatsapp.net';
upsertChat(db, { jid: OWNER_LAST, name: 'Nadia Bakker', kind: '1:1', last_msg_at: at(), unread: 0, agent_state: 'skipped' });
upsertMessage(db, { id: 'o-1', chat_jid: OWNER_LAST, from_me: false, ts: at(), type: 'text', text: 'Heb je de cijfers van vorige maand nog ergens?' });
upsertMessage(db, { id: 'o-2', chat_jid: OWNER_LAST, from_me: true, ts: at(), type: 'text', text: 'Ja, ik zoek ze even op — kom er zo op terug.' });

const fakeProvider: DraftProvider = {
	draft: async (): Promise<DraftResult> => ({ kind: 'draft', text: 'Preview draft — no provider was called.' })
};

const app = createApp({
  db,
  dataDir,
  port: Number(process.env.PORT ?? 8799),
  host: '127.0.0.1',
  staticDir: join(process.cwd(), 'build'),
  // No `channel`: nothing here opens a WhatsApp socket.
  draftProvider: fakeProvider,
  providerName: 'fake'
});

await app.start();
console.log(`
UI preview ready — safe to screenshot.

  URL       http://127.0.0.1:${app.port}
  database  ${dataDir}  (throwaway)
  whatsapp  not connected — no channel was started
  provider  fake — no LLM is called

Open "Quote Gallery" for every quote subtype, the reaction chips, and the
unread boundary. "Group Sandbox" covers group sender attribution.
"Felix De Groene" is the W4-U16 masked-name case — the chat list must show
the contact name, not "+31 [dots] 85".

Capture with:
  slay tasks browser new http://127.0.0.1:${app.port}
  slay tasks browser screenshot -o /tmp/<name>.png

Ctrl-C to stop. The temp database is discarded with it.
`);
