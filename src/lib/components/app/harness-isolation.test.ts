import { describe, expect, it } from 'vitest';
import {
	parseIsolationStoreView,
	pinnedFor,
	verdictLabel
} from './harness-isolation.js';
import { VERIFIED_HARNESS_VERSIONS } from '../../../../shared/harness-versions.js';

describe('harness-isolation client helpers', () => {
	it('parses a store blob', () => {
		const store = parseIsolationStoreView(
			JSON.stringify({
				claude: {
					drafting: {
						harness: 'claude',
						verdict: 'pass',
						summary: 'ok',
						checkedAt: 1
					}
				}
			})
		);
		expect(store.claude?.drafting?.verdict).toBe('pass');
	});

	it('pins match shared versions', () => {
		expect(pinnedFor('claude')).toBe(VERIFIED_HARNESS_VERSIONS.claude);
		expect(pinnedFor('codex')).toBe(VERIFIED_HARNESS_VERSIONS.codex);
	});

	it('uses plain-language verdict labels', () => {
		expect(verdictLabel('pass')).toContain('Nothing extra');
		expect(verdictLabel('fail')).toContain('Something extra');
		expect(verdictLabel(undefined)).toContain('Not checked');
	});
});
