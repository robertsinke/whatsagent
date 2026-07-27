/**
 * Shared name-vs-phone predicate. Used by the server view builders
 * (`server/api/chat-view.ts`, `server/api/message-view.ts`) and by the client
 * (`src/lib/client/view.ts` `senderLabel`) so the chat list and message
 * bubbles can never disagree about whether a label is a person's name or a
 * phone-shaped fallback.
 *
 * This module is deliberately dependency-free so it can be imported from both
 * the Node server (`tsc -p tsconfig.server.json`) and the SvelteKit client
 * bundle without dragging Node-only modules into the browser build.
 */

/**
 * Characters WhatsApp uses in privacy masks plus the usual phone separators.
 * U+2219 (∙), U+2022 (•), U+00B7 (·) are the dot characters seen in the live
 * database; space, hyphen, parentheses, dot, slash are routine separators.
 * A leading `+` is the only non-digit, non-separator token allowed on a phone.
 */
const PHONE_CHAR_CLASS = '0-9\\s().\\-/+\u2219\u2022\u00b7';

/**
 * A label that, after trimming, consists solely of digits, a leading plus and
 * the usual phone separators (including the WhatsApp privacy-mask dots). Such
 * a string is a phone number or a mask of one, not a person's name.
 *
 * Match positively on the phone shape — never implement this as "no A-Z
 * letters", which would classify a Chinese, Cyrillic, Arabic or Greek name as
 * a phone number and strip a name the chat already displays correctly.
 */
export function isPhoneShapedLabel(value: string | null | undefined): boolean {
	if (value == null) return false;
	const trimmed = value.trim();
	if (trimmed.length === 0) return false;
	// May contain only digits/plus/separators/mask-dots.
	return new RegExp(`^[${PHONE_CHAR_CLASS}]+$`).test(trimmed);
}

/**
 * A non-empty, trimmed name that is not phone-shaped. Returns the trimmed name
 * when usable, otherwise null — so callers can fall through to the next source
 * in priority order without juggling two checks.
 */
export function usableName(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (isPhoneShapedLabel(trimmed)) return null;
	return trimmed;
}