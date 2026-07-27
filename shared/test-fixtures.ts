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
