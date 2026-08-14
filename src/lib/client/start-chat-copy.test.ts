import { describe, expect, it } from 'vitest';
import { ApiError } from './types.js';
import { phoneFailCopy, startChatFailureCopy } from './start-chat-copy.js';

describe('phoneFailCopy', () => {
	it('names a missing country code instead of calling the number invalid', () => {
		expect(phoneFailCopy('missing_country_code')).toMatch(/country code/i);
		expect(phoneFailCopy('missing_country_code')).not.toMatch(/not a number/i);
	});
});

describe('startChatFailureCopy', () => {
	it('treats 404 as not-on-WhatsApp', () => {
		expect(startChatFailureCopy(new ApiError(404, 'That number is not on WhatsApp'))).toBe(
			'That number is not on WhatsApp.'
		);
	});

	it('explains 503 in owner language', () => {
		const copy = startChatFailureCopy(
			new ApiError(503, 'Starting a chat requires the WhatsAgent app to be open')
		);
		expect(copy).toMatch(/WhatsApp isn't connected/i);
		expect(copy).not.toMatch(/503|checkRegistered|dep/i);
	});

	it('uses the shared reason for a 400 missing country code', () => {
		expect(
			startChatFailureCopy(
				new ApiError(400, 'Not a usable phone number', { reason: 'missing_country_code' })
			)
		).toBe(phoneFailCopy('missing_country_code'));
	});
});
