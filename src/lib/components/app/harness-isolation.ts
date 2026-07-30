/**
 * Client-side view of the last SEC-1 harness isolation check.
 * Types mirror `server/providers/harness-isolation.ts` without importing Node.
 */
import { VERIFIED_HARNESS_VERSIONS } from '../../../../shared/harness-versions.js';

export type IsolationHarness = 'claude' | 'codex';
export type IsolationSurface = 'drafting' | 'panel';
export type IsolationVerdict = 'pass' | 'fail' | 'inconclusive' | 'unavailable';

export type IsolationReportView = {
	harness: IsolationHarness;
	binary: string;
	surface: IsolationSurface;
	tier: 1 | 2;
	tier1Strength: 'realized-surface' | 'resolved-config-only';
	pinnedVersion: string;
	detectedVersion: string | null;
	verdict: IsolationVerdict;
	summary: string;
	checkedAt: number;
	findings: Array<{ code: string; detail: string }>;
};

export type IsolationStoreView = Partial<
	Record<IsolationHarness, Partial<Record<IsolationSurface, IsolationReportView>>>
>;

export const ISOLATION_HARNESS_ROWS: ReadonlyArray<{
	harness: IsolationHarness;
	title: string;
	binary: string;
}> = [
	{ harness: 'claude', title: 'Claude Code', binary: 'claude' },
	{ harness: 'codex', title: 'OpenCode', binary: 'opencode' }
];

export function parseIsolationStoreView(raw: string | undefined | null): IsolationStoreView {
	if (!raw?.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed as IsolationStoreView;
	} catch {
		return {};
	}
}

export function pinnedFor(harness: IsolationHarness): string {
	return VERIFIED_HARNESS_VERSIONS[harness];
}

export function formatCheckedAt(ms: number | undefined): string {
	if (!ms) return 'Never checked';
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return 'Unknown time';
	}
}

export function verdictLabel(verdict: IsolationVerdict | undefined): string {
	if (!verdict) return 'Not checked yet';
	if (verdict === 'pass') return 'Nothing extra is reachable';
	if (verdict === 'fail') return 'Something extra may be reachable';
	if (verdict === 'inconclusive') return 'Inconclusive';
	return 'Harness unavailable';
}
