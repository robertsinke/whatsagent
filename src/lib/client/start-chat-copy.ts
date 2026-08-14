import type { PhoneFailReason } from '../../../shared/phone.js';
import { ApiError } from './types.js';

/**
 * Inline validation copy. Must agree with `normalizePhone` — the button
 * enablement uses the same reasons. Country code is mandatory; we never
 * guess one.
 */
export function phoneFailCopy(reason: PhoneFailReason): string {
	switch (reason) {
		case 'empty':
			return 'Enter a phone number with a country code.';
		case 'too_short':
			return 'That number is too short.';
		case 'too_long':
			return 'That number is too long.';
		case 'missing_country_code':
			return 'Include the country code (for example +31). No country is assumed.';
		case 'not_a_number':
			return "That doesn't look like a phone number.";
	}
}

/**
 * Owner-facing copy for every failure `POST /api/chats` can return.
 * `created: false` is not a failure — the caller navigates instead.
 */
export function startChatFailureCopy(error: unknown): string {
	if (!(error instanceof ApiError)) {
		return 'Could not start the chat. Try again.';
	}
	if (error.status === 404) {
		return 'That number is not on WhatsApp.';
	}
	if (error.status === 503) {
		return "WhatsApp isn't connected, so this app can't confirm the number exists. Open WhatsAgent with WhatsApp linked and try again.";
	}
	if (error.status === 502) {
		return "Couldn't check the number with WhatsApp. Try again in a moment.";
	}
	if (error.status === 409) {
		return 'Too many empty chats are already open.';
	}
	if (error.status === 400) {
		const reason = error.body.reason;
		if (
			reason === 'empty' ||
			reason === 'too_short' ||
			reason === 'too_long' ||
			reason === 'missing_country_code' ||
			reason === 'not_a_number'
		) {
			return phoneFailCopy(reason);
		}
		return 'Not a usable phone number. Include the country code — no country is assumed.';
	}
	return error.message || 'Could not start the chat. Try again.';
}
