/**
 * Phone-number normalization shared by both sides.
 *
 * The UI needs it to enable its "start chat" affordance and show inline
 * validation; the server needs it because it must not trust the UI. Keep this
 * file dependency-free (no Node built-ins, nothing from `$lib`) — it bundles
 * for the browser.
 *
 * ## A country code is mandatory and there is NO default country
 *
 * This is a safety decision, not a validation nicety. A bare national number is
 * ambiguous, and resolving that ambiguity by assuming a country means messaging
 * a stranger — an outbound WhatsApp message to a person who never contacted the
 * owner, from the owner's own account. So a national-looking number is rejected
 * and the owner is asked to type the country code, rather than guessed at.
 */

export type PhoneParse =
	| { ok: true; e164: string } // digits only, no leading '+'
	| { ok: false; reason: 'empty' | 'too_short' | 'too_long' | 'not_a_number' };

/** E.164 caps the whole number, country code included, at 15 digits. */
const MAX_E164_DIGITS = 15;

/**
 * Shortest plausible international number (country code + subscriber). Below
 * this, the input is either a national number missing its country code or a
 * typo; either way it is not something to guess at.
 */
const MIN_E164_DIGITS = 7;

/** Separators an owner will realistically paste or type. */
const SEPARATORS = /[\s\-(). ‐-―]/g;

/**
 * Parse a typed or pasted number into bare E.164 digits.
 *
 * Accepts a single leading `+`, spaces, dashes, dots, parentheses and non-break
 * spaces. Everything else — letters, a second `+`, `00` prefixes we cannot
 * safely resolve — is `not_a_number`.
 */
export function normalizePhone(raw: string): PhoneParse {
	if (typeof raw !== 'string') return { ok: false, reason: 'not_a_number' };
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, reason: 'empty' };

	const hasPlus = trimmed.startsWith('+');
	const body = hasPlus ? trimmed.slice(1) : trimmed;
	const stripped = body.replace(SEPARATORS, '');
	if (!stripped) return { ok: false, reason: 'empty' };
	if (!/^[0-9]+$/.test(stripped)) return { ok: false, reason: 'not_a_number' };

	if (stripped.length < MIN_E164_DIGITS) return { ok: false, reason: 'too_short' };
	if (stripped.length > MAX_E164_DIGITS) return { ok: false, reason: 'too_long' };

	// A leading 0 is a trunk prefix — a national number. There is no default
	// country, so this cannot be completed into an international number here.
	if (stripped.startsWith('0')) return { ok: false, reason: 'not_a_number' };

	return { ok: true, e164: stripped };
}

/** WhatsApp phone-addressed JID for bare E.164 digits. */
export function phoneToJid(e164: string): string {
	return `${e164}@s.whatsapp.net`;
}
