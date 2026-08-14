import { describe, expect, it } from 'vitest';
import {
	FIXTURE_MAX_E164,
	FIXTURE_PHONE,
	FIXTURE_UK_PHONE,
	FIXTURE_US_PHONE
} from './test-fixtures.js';
import { normalizePhone, phoneToJid } from './phone.js';

describe('normalizePhone', () => {
	it('strips the separators an owner actually types', () => {
		const cases: Array<[string, string]> = [
			['+31 6 1234 5678', FIXTURE_PHONE],
			['+1 (555) 000-0001', FIXTURE_US_PHONE],
			['+1.555.000.0001', FIXTURE_US_PHONE],
			[`  +${FIXTURE_UK_PHONE}  `, FIXTURE_UK_PHONE],
			[FIXTURE_PHONE, FIXTURE_PHONE]
		];
		for (const [raw, e164] of cases) {
			expect(normalizePhone(raw), raw).toEqual({ ok: true, e164 });
		}
	});

	it('rejects a bare national number rather than guessing a country', () => {
		// Leading trunk prefix — the country is genuinely unknown here, and
		// assuming one messages a stranger.
		expect(normalizePhone('06 1234 5678')).toEqual({ ok: false, reason: 'not_a_number' });
		expect(normalizePhone('(020) 7946 0958')).toEqual({ ok: false, reason: 'not_a_number' });
	});

	it('rejects empty input', () => {
		expect(normalizePhone('')).toEqual({ ok: false, reason: 'empty' });
		expect(normalizePhone('   ')).toEqual({ ok: false, reason: 'empty' });
		expect(normalizePhone('+')).toEqual({ ok: false, reason: 'empty' });
	});

	it('enforces the E.164 length bounds', () => {
		expect(normalizePhone('123456')).toEqual({ ok: false, reason: 'too_short' });
		expect(normalizePhone('1234567')).toEqual({ ok: true, e164: '1234567' });
		expect(normalizePhone(FIXTURE_MAX_E164)).toEqual({ ok: true, e164: FIXTURE_MAX_E164 });
		expect(normalizePhone(`${FIXTURE_MAX_E164}9`)).toEqual({ ok: false, reason: 'too_long' });
	});

	it('rejects anything that is not a number', () => {
		expect(normalizePhone('call alice')).toEqual({ ok: false, reason: 'not_a_number' });
		expect(normalizePhone(`+${FIXTURE_PHONE}@s.whatsapp.net`)).toEqual({
			ok: false,
			reason: 'not_a_number'
		});
		expect(normalizePhone(`++${FIXTURE_PHONE}`)).toEqual({ ok: false, reason: 'not_a_number' });
		expect(normalizePhone('31 61234567x')).toEqual({ ok: false, reason: 'not_a_number' });
	});
});

describe('phoneToJid', () => {
	it('builds a phone-addressed WhatsApp jid', () => {
		expect(phoneToJid(FIXTURE_PHONE)).toBe(`${FIXTURE_PHONE}@s.whatsapp.net`);
	});
});
