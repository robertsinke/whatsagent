/**
 * Synthetic WhatsApp identifiers for tests and preview seeds.
 *
 * Phones use the reserved NL range 316000000xx (plus the long-standing
 * 31612345678 mask). LIDs are clearly-fake 15-digit values starting at
 * 100000000000001. Every 11–15 digit run that appears anywhere in the
 * tree and is not a leak must be exportable from this file — the durable gate
 * (`scripts/check-no-private-data.mjs`) allowlists exactly the digit runs that
 * appear here.
 *
 * Production code must not import this module.
 */

/**
 * Relative paths allowed to contain the *runtime* home-directory prefix.
 * Parsed by `scripts/check-no-private-data.mjs`. Paths only — never put the
 * home path string itself here (that would make this file an instance of what
 * the gate blocks). Reasons recorded per group; OSS export strips or truncates
 * the private-tree holders, and `publish-oss.sh` still greps the staged tree.
 */
export const PRIVATE_DATA_HOME_PATH_ALLOWLIST = [
	// Private orchestration symlinks whose git blob is an absolute path into
	// ~/.agents/scripts/slayzone/. publish-oss deletes .githooks/ before publish.
	// Deliberate allowlist (not a silent skip): local hook wiring, not shippable
	// content — see OSS-P1.8 execution report.
	'.githooks/pre-commit',
	'.githooks/reference-transaction',
	// Same shape under .slayzone/ — also stripped from the public export.
	'.slayzone/attach-worker-briefing.sh',
	'.slayzone/check-hooks.sh',
	'.slayzone/config.example.sh',
	'.slayzone/emit-role-brief.sh',
	'.slayzone/finish-task.sh',
	'.slayzone/intercept-task-done.sh',
	'.slayzone/lib.sh',
	'.slayzone/require-visual-evidence.sh',
	'.slayzone/wave-done-ping.sh',
	// Absolute hook command paths; .claude/ is stripped from the export.
	'.claude/settings.json',
	// Names worktree roots / role-file paths; .slayzone/ stripped from export.
	// Both role briefs became symlinks into the shared agent templates on
	// 2026-07-31 (the slayzone-meta migration), so their git blob is now an
	// absolute home path. `.slayzone` is stripped by publish-oss, so these never
	// ship — allowlisting is honest here, per the note further down.
	'.slayzone/orchestrator.md',
	'.slayzone/worker.md',
	// The local addenda name this project's worktree root, which is a home path
	// by nature. Same reasoning: stripped before export.
	'.slayzone/orchestrator-local.md',
	'.slayzone/worker-local.md',
	// Absolute path below the PRIVATE-ONLY marker; publish-oss truncates there.
	'CLAUDE.md',
	// Export tool + its own residual-path gate; script itself is excluded from export.
	'scripts/publish-oss.sh',
	// Meta plan that documents private paths; excluded from the export by path.
	'docs/plans/2026-07-27-001-oss-readiness-plan.md'
	// Three 2026-07-29 evidence / execution-report files used to sit here. They
	// were SCRUBBED instead (2026-07-31) and the entries removed, because unlike
	// everything above them they are NOT in publish-oss.sh's EXCLUDE_PATHS — they
	// ship. Allowlisting a path that ships makes the gate green on private main
	// while leaving the leak in the published tree, which is the only tree where
	// it matters. An allowlist entry is honest for a path the export strips, and
	// dishonest for one it does not.
] as const;

/** Classic privacy-mask / placeholder phone used across the suite. */
export const FIXTURE_PHONE = '31612345678';

/** Zero-suffix reserved phone used by event-bus tests. */
export const FIXTURE_EVENTS_PHONE = '31600000000';

/** Owner-shaped phone / LID pair (replaces live owner identifiers in tests). */
export const FIXTURE_OWNER_PHONE = '31600000001';
export const FIXTURE_OWNER_LID = '100000000000001';

/**
 * Contact phone / LID pair for dual-jid search and display tests.
 * `31600000002` is also the fidelity-fixture participant number.
 */
export const FIXTURE_CONTACT_PHONE = '31600000002';
export const FIXTURE_CONTACT_LID = '100000000000002';

/** vCard number embedded in `message-fidelity.json`. */
export const FIXTURE_VCARD_PHONE = '31600000003';

/** Split-identity pair (LID migration / chat-merge tests and preview seed). */
export const FIXTURE_SPLIT_PHONE = '31600000004';
export const FIXTURE_SPLIT_LID = '100000000000003';

/** Standalone LID chat used in own-send / index ingest tests. */
export const FIXTURE_CHAT_LID = '100000000000004';

/** Group JID local parts (`{phone}-{ts}@g.us`). */
export const FIXTURE_GROUP_PHONE = '31600000005';
export const FIXTURE_GROUP_TS = '1000000001';

/** Alt phone for incidental lid-mapping update coverage. */
export const FIXTURE_ALT_PHONE = '31600000006';

/**
 * NEWCHAT-1 — phone-normalization table values. Reserved/unassigned ranges
 * (US 555, UK 07700 900xxx drama range), never dialable.
 */
export const FIXTURE_US_PHONE = '15550000001';
export const FIXTURE_UK_PHONE = '447700900001';
/** The E.164 ceiling — exactly 15 digits, for the length-bound test. */
export const FIXTURE_MAX_E164 = '999999999999999';

/** NEWCHAT-1 — start-chat dedupe pair (a person known only under a LID). */
export const FIXTURE_NEWCHAT_LID = '100000000000005';
/** LID WhatsApp itself reports back from a number lookup. */
export const FIXTURE_NEWCHAT_REPORTED_LID = '100000000000006';

/** Display names — not real contacts. */
export const FIXTURE_OWNER_NAME = 'Alex';
export const FIXTURE_SPLIT_NAME = 'Casey Quinn';
export const FIXTURE_SPLIT_NAME_SHORT = 'Casey';

export const FIXTURE_PHONE_JID = `${FIXTURE_PHONE}@s.whatsapp.net`;
export const FIXTURE_OWNER_PHONE_JID = `${FIXTURE_OWNER_PHONE}@s.whatsapp.net`;
export const FIXTURE_OWNER_LID_JID = `${FIXTURE_OWNER_LID}@lid`;
export const FIXTURE_CONTACT_PHONE_JID = `${FIXTURE_CONTACT_PHONE}@s.whatsapp.net`;
export const FIXTURE_CONTACT_LID_JID = `${FIXTURE_CONTACT_LID}@lid`;
export const FIXTURE_SPLIT_PHONE_JID = `${FIXTURE_SPLIT_PHONE}@s.whatsapp.net`;
export const FIXTURE_SPLIT_LID_JID = `${FIXTURE_SPLIT_LID}@lid`;
export const FIXTURE_CHAT_LID_JID = `${FIXTURE_CHAT_LID}@lid`;
export const FIXTURE_ALT_PHONE_JID = `${FIXTURE_ALT_PHONE}@s.whatsapp.net`;
export const FIXTURE_GROUP_JID = `${FIXTURE_GROUP_PHONE}-${FIXTURE_GROUP_TS}@g.us`;
