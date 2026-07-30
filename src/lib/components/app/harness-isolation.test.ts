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

/**
 * Orchestrator addition after SEC-1 merge. The worker filtered the known
 * `advisor` residual out of the panel tool list with a substring match, which
 * both hid it from the owner and would have waved through anything merely
 * *containing* "advisor". These pin the corrected behaviour.
 */
describe('known residuals are reported, not filtered', () => {
	it('does not fail the verdict, and does not disappear either', async () => {
		const { evaluateClaudeInitEvent } = await import(
			'../../../../server/providers/harness-isolation.js'
		);
		const result = evaluateClaudeInitEvent(
			{ tools: ['advisor', 'mcp__whatsagent__list-chats'], mcp_servers: [{ name: 'whatsagent' }] },
			'panel'
		);
		expect(result.ok).toBe(true);
		const residual = result.findings.find((f) => f.code === 'known_residual');
		expect(residual, 'the owner must still be told advisor is reachable').toBeDefined();
		expect(residual!.severity).toBe('note');
		expect(residual!.detail).toMatch(/transcript/i);
	});

	it('does not tolerate a tool that merely contains the residual name', async () => {
		const { evaluateClaudeInitEvent } = await import(
			'../../../../server/providers/harness-isolation.js'
		);
		const result = evaluateClaudeInitEvent(
			{ tools: ['advisor-exec', 'mcp__whatsagent__list-chats'], mcp_servers: [{ name: 'whatsagent' }] },
			'panel'
		);
		expect(result.ok, 'advisor-exec is not the known residual').toBe(false);
		expect(result.findings.some((f) => f.code === 'builtin_present')).toBe(true);
	});
});
