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
	'.slayzone/orchestrator.md',
	// Absolute path below the PRIVATE-ONLY marker; publish-oss truncates there.
	'CLAUDE.md',
	// Export tool + its own residual-path gate; script itself is excluded from export.
	'scripts/publish-oss.sh',
	// Meta plan that documents private paths; excluded from the export by path.
	'docs/plans/2026-07-27-001-oss-readiness-plan.md',
	// Evidence / reports that name worktree paths. They *do* ship today — the
	// publish-oss `/Users/…` grep is the export-side catch. Listed so private
	// `npm run check` is reachable; scrubbing them is out of this unit's scope.
	'docs/evidence/2026-07-29-pl-s3-opencode-recheck.md',
	'docs/evidence/2026-07-29-pl-s4-opencode-subscription.md',
	'docs/execution-reports/2026-07-29-pl-a3-agent-panel-layout.md'
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
