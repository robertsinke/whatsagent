import { describe, expect, it } from 'vitest';
import {
	VERIFIED_HARNESS_VERSIONS,
	versionMismatchNotice,
	versionsMismatch
} from './harness-versions.js';

describe('VERIFIED_HARNESS_VERSIONS', () => {
	/**
	 * Deliberately a tautology, and worth keeping as one: it is a tripwire, not a
	 * behaviour test. Changing a pin means editing it here too, which is a second
	 * deliberate act asking "did you actually re-measure?" — see the evidence
	 * commands in the header of `harness-versions.ts`. A pin that could drift on
	 * one silent edit is the stale comment this file replaced.
	 */
	it('pins the versions prose previously only mentioned', () => {
		expect(VERIFIED_HARNESS_VERSIONS.claude).toBe('2.1.220');
		// Bumped 2026-07-31 after Tier-2 passes on both surfaces (drafting, panel).
		expect(VERIFIED_HARNESS_VERSIONS.codex).toBe('1.18.10');
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
