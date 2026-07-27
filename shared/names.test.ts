import { describe, expect, it } from 'vitest';
import { isPhoneShapedLabel, usableName } from './names.js';
import { FIXTURE_OWNER_PHONE } from './test-fixtures.js';

describe('isPhoneShapedLabel', () => {
	it('rejects a WhatsApp privacy mask of any of the three dot characters', () => {
		// U+2219 ∙ is the dot WhatsApp uses in the live database; U+2022 • and
		// U+00B7 · are its siblings. A naive "no A-Z letters" test would pass
		// these too — this pins the positive phone-shape match.
		expect(isPhoneShapedLabel('+31 \u2219\u2219\u2219\u2219 85')).toBe(true);
		expect(isPhoneShapedLabel('+31 \u2022\u2022 29')).toBe(true);
		expect(isPhoneShapedLabel('+31 \u00b7 12')).toBe(true);
	});

	it('accepts a bare number with separators and a leading plus', () => {
		expect(isPhoneShapedLabel('+31 6 1234 5678')).toBe(true);
		expect(isPhoneShapedLabel('(020) 555-1234')).toBe(true);
		expect(isPhoneShapedLabel(`+${FIXTURE_OWNER_PHONE}`)).toBe(true);
		expect(isPhoneShapedLabel('020-555-1234')).toBe(true);
	});

	it('does not classify a Latin-script person name as a phone', () => {
		expect(isPhoneShapedLabel('Felix De Groene')).toBe(false);
		expect(isPhoneShapedLabel('Robert')).toBe(false);
	});

	it('does not classify non-Latin names as phones (the headline trap)', () => {
		// A naive "no A-Z letters" test would return true for all of these and
		// strip a name the chat already displays. This pins Chinese, Cyrillic,
		// Arabic and Greek so a future refactor cannot regress it.
		expect(isPhoneShapedLabel('李明')).toBe(false); // Chinese
		expect(isPhoneShapedLabel('Александр')).toBe(false); // Cyrillic
		expect(isPhoneShapedLabel('محمد')).toBe(false); // Arabic
		expect(isPhoneShapedLabel('Αλέξανδρος')).toBe(false); // Greek
	});

	it('returns false for null/undefined/empty/whitespace', () => {
		expect(isPhoneShapedLabel(null)).toBe(false);
		expect(isPhoneShapedLabel(undefined)).toBe(false);
		expect(isPhoneShapedLabel('')).toBe(false);
		expect(isPhoneShapedLabel('   ')).toBe(false);
	});
});

describe('usableName', () => {
	it('returns a trimmed name', () => {
		expect(usableName('  Felix De Groene  ')).toBe('Felix De Groene');
	});

	it('returns null for a mask, so callers fall through to the next source', () => {
		expect(usableName('+31 \u2219\u2219\u2219\u2219 85')).toBeNull();
		expect(usableName(`+${FIXTURE_OWNER_PHONE}`)).toBeNull();
	});

	it('returns null for null/undefined/empty/whitespace', () => {
		expect(usableName(null)).toBeNull();
		expect(usableName(undefined)).toBeNull();
		expect(usableName('')).toBeNull();
		expect(usableName('   ')).toBeNull();
	});

	it('preserves non-Latin names', () => {
		expect(usableName('李明')).toBe('李明');
		expect(usableName('  Александр  ')).toBe('Александр');
		expect(usableName('محمد')).toBe('محمد');
	});
});