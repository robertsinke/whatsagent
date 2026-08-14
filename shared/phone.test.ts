import { describe, expect, it } from 'vitest';
import { normalizePhone, phoneToJid } from './phone.js';

describe('normalizePhone', () => {
	it('strips the separators an owner actually types', () => {
		const cases: Array<[string, string]> = [
			['+31 6 1234 5678', '31612345678'],
			['+1 (555) 123-4567', '15551234567'],
			['+1.555.123.4567', '15551234567'],
			['  +447700900123  ', '447700900123'],
			['31612345678', '31612345678']
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
		expect(normalizePhone('123456789012345')).toEqual({ ok: true, e164: '123456789012345' });
		expect(normalizePhone('1234567890123456')).toEqual({ ok: false, reason: 'too_long' });
	});

	it('rejects anything that is not a number', () => {
		expect(normalizePhone('call alice')).toEqual({ ok: false, reason: 'not_a_number' });
		expect(normalizePhone('+31612345678@s.whatsapp.net')).toEqual({
			ok: false,
			reason: 'not_a_number'
		});
		expect(normalizePhone('++31612345678')).toEqual({ ok: false, reason: 'not_a_number' });
		expect(normalizePhone('31 61234567x')).toEqual({ ok: false, reason: 'not_a_number' });
	});
});

describe('phoneToJid', () => {
	it('builds a phone-addressed WhatsApp jid', () => {
		expect(phoneToJid('31612345678')).toBe('31612345678@s.whatsapp.net');
	});
});
