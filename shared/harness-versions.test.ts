import { describe, expect, it } from 'vitest';
import {
	VERIFIED_HARNESS_VERSIONS,
	versionMismatchNotice,
	versionsMismatch
} from './harness-versions.js';

describe('VERIFIED_HARNESS_VERSIONS', () => {
	it('pins the versions prose previously only mentioned', () => {
		expect(VERIFIED_HARNESS_VERSIONS.claude).toBe('2.1.220');
		expect(VERIFIED_HARNESS_VERSIONS.codex).toBe('1.18.9');
		expect(VERIFIED_HARNESS_VERSIONS.ollama).toBe('0.32.4');
	});
});

describe('versionsMismatch', () => {
	it('is true only when a detected version differs from the pin', () => {
		expect(versionsMismatch('1.18.10', '1.18.9')).toBe(true);
		expect(versionsMismatch('1.18.9', '1.18.9')).toBe(false);
		expect(versionsMismatch(null, '1.18.9')).toBe(false);
		expect(versionsMismatch('', '1.18.9')).toBe(false);
	});

	it('formats a plain information notice', () => {
		expect(versionMismatchNotice('1.18.9', '1.18.10')).toBe(
			'Verified against 1.18.9, you have 1.18.10.'
		);
	});
});
