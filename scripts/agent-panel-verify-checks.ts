/**
 * Per-check scoring for `agent-panel-verify.ts`.
 *
 * Mirrors the four-verdict vocabulary in `server/providers/harness-isolation.ts`
 * (`pass` | `fail` | `inconclusive` | `unavailable`). The load-bearing rule for
 * this script: a negative result without a measured turn is uninterpretable.
 * Zero parts → inconclusive for every check that depends on that turn — never
 * pass. Model-free checks (crafted MCP calls) stay pass/fail.
 */
import { PanelTurnError } from '../server/agent/panel/stream-process.js';
import type { AgentPart } from '../shared/agent-events.js';

/** Same four verdicts as {@link IsolationVerdict}. */
export type VerifyVerdict = 'pass' | 'fail' | 'inconclusive' | 'unavailable';

export type TurnFailureKind =
	| 'timeout'
	| 'spawn_failed'
	| 'process_exit'
	| 'cancelled'
	| 'provider_error'
	| 'unknown';

export type TurnFailure = {
	kind: TurnFailureKind;
	message: string;
};

export type TurnResult = {
	parts: AgentPart[];
	failure: TurnFailure | null;
};

export type CheckResult = {
	name: string;
	verdict: VerifyVerdict;
	detail: string;
	/** True when scoring required a turn that produced at least one part. */
	dependsOnTurn: boolean;
};

/**
 * Map a thrown turn error onto a failure kind. Prefer {@link PanelTurnError}
 * codes; fall back to message heuristics for provider usage-limit errors that
 * surface as plain Error (the observed 2026-07-31 Ollama cloud case).
 */
export function classifyTurnError(error: unknown): TurnFailure {
	if (error instanceof PanelTurnError) {
		return { kind: error.code, message: error.message };
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/usage[_\s-]?limit|rate[_\s-]?limit|quota|billing|credit|session limit/i.test(message)) {
		return { kind: 'provider_error', message };
	}
	if (/timed?\s*out|timeout|AbortError/i.test(message)) {
		return { kind: 'timeout', message };
	}
	if (/spawn|ENOENT|not found|EACCES/i.test(message)) {
		return { kind: 'spawn_failed', message };
	}
	return { kind: 'unknown', message };
}

export function turnProducedParts(turn: TurnResult): boolean {
	return turn.parts.length > 0;
}

/** Plain-language reason when a turn-dependent check cannot be scored. */
export function inconclusiveReasonForTurn(turn: TurnResult): string {
	const base = 'zero parts — absence is not evidence';
	if (!turn.failure) return `turn produced ${base}`;
	switch (turn.failure.kind) {
		case 'timeout':
			return `harness timed out (${turn.failure.message}); ${base}`;
		case 'spawn_failed':
			return `harness failed to spawn (${turn.failure.message}); ${base}`;
		case 'process_exit':
			return `harness exited uncleanly (${turn.failure.message}); ${base}`;
		case 'cancelled':
			return `turn cancelled (${turn.failure.message}); ${base}`;
		case 'provider_error':
			return `provider error (${turn.failure.message}); ${base}`;
		case 'unknown':
			return `turn failed (${turn.failure.message}); ${base}`;
	}
}

/** Score a check that is only meaningful when the turn produced parts. */
export function scoreTurnDependent(
	name: string,
	turn: TurnResult,
	pass: boolean,
	detail: string
): CheckResult {
	if (!turnProducedParts(turn)) {
		return {
			name,
			verdict: 'inconclusive',
			detail: inconclusiveReasonForTurn(turn),
			dependsOnTurn: true
		};
	}
	return {
		name,
		verdict: pass ? 'pass' : 'fail',
		detail,
		dependsOnTurn: true
	};
}

/** Score a check that needs no model turn (crafted MCP / dispatcher). */
export function scoreModelFree(name: string, pass: boolean, detail: string): CheckResult {
	return {
		name,
		verdict: pass ? 'pass' : 'fail',
		detail,
		dependsOnTurn: false
	};
}

/**
 * Proposal confirm path: no pending proposal means the click was never tested.
 * That is inconclusive whether or not a turn ran — fail would imply the
 * confirm path is broken.
 */
export function scoreMissingProposal(name: string, turn: TurnResult): CheckResult {
	const turnHint = turnProducedParts(turn)
		? 'turn ran but produced no proposal'
		: inconclusiveReasonForTurn(turn);
	return {
		name,
		verdict: 'inconclusive',
		detail: `no proposal to confirm — ${turnHint}`,
		dependsOnTurn: true
	};
}

export function formatCheckLine(check: CheckResult): string {
	return `${check.verdict.toUpperCase()}  ${check.name} — ${check.detail}`;
}

export type CheckSummary = {
	lines: string[];
	/** Checks that scored pass or fail (actually measured). */
	measured: CheckResult[];
	/** Checks that could not run (inconclusive / unavailable). */
	unmeasured: CheckResult[];
	/** Non-zero when any check is not a plain pass — usable as a gate. */
	exitCode: number;
	/** One-line operator summary naming what was and was not measured. */
	headline: string;
};

export function summarizeChecks(checks: CheckResult[]): CheckSummary {
	const measured = checks.filter((c) => c.verdict === 'pass' || c.verdict === 'fail');
	const unmeasured = checks.filter(
		(c) => c.verdict === 'inconclusive' || c.verdict === 'unavailable'
	);
	const lines = checks.map(formatCheckLine);
	const exitCode = checks.some((c) => c.verdict !== 'pass') ? 1 : 0;

	let headline: string;
	if (unmeasured.length === 0) {
		headline = `Measured ${measured.length}/${checks.length} checks — all scored.`;
	} else if (measured.length === 0) {
		headline = `Measured 0/${checks.length} checks — nothing could be scored (all inconclusive/unavailable).`;
	} else {
		const measuredNames = measured.map((c) => c.name).join('; ');
		const unmeasuredNames = unmeasured.map((c) => c.name).join('; ');
		headline =
			`Measured ${measured.length}/${checks.length} checks ` +
			`(scored: ${measuredNames}). ` +
			`NOT measured (${unmeasured.length}): ${unmeasuredNames}. ` +
			`Model-free passes are still valid; turn-dependent absences are not evidence.`;
	}

	return { lines, measured, unmeasured, exitCode, headline };
}
