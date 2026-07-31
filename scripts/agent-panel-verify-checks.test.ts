import { describe, expect, it } from 'vitest';
import { PanelTurnError } from '../server/agent/panel/stream-process.js';
import type { AgentPart } from '../shared/agent-events.js';
import {
	classifyTurnError,
	formatCheckLine,
	inconclusiveReasonForTurn,
	scoreMissingProposal,
	scoreModelFree,
	scoreTurnDependent,
	summarizeChecks,
	type TurnResult
} from './agent-panel-verify-checks.js';

const emptyTurn: TurnResult = { parts: [], failure: null };
const timedOutTurn: TurnResult = {
	parts: [],
	failure: { kind: 'timeout', message: 'opencode timed out' }
};
const providerTurn: TurnResult = {
	parts: [],
	failure: { kind: 'provider_error', message: 'session usage limit' }
};
const toolPart = {
	kind: 'tool',
	sessionId: 's',
	messageId: 'm',
	partId: 't1',
	name: 'list-chats',
	input: {},
	state: 'complete'
} as AgentPart;
const textPart = {
	kind: 'text',
	sessionId: 's',
	messageId: 'm',
	partId: 'x1',
	text: 'hello'
} as AgentPart;
const liveTurn: TurnResult = { parts: [toolPart, textPart], failure: null };

describe('classifyTurnError', () => {
	it('preserves PanelTurnError codes', () => {
		expect(classifyTurnError(new PanelTurnError('timeout', 'opencode timed out'))).toEqual({
			kind: 'timeout',
			message: 'opencode timed out'
		});
		expect(classifyTurnError(new PanelTurnError('spawn_failed', 'ENOENT'))).toEqual({
			kind: 'spawn_failed',
			message: 'ENOENT'
		});
	});

	it('detects provider usage-limit errors from plain messages', () => {
		expect(classifyTurnError(new Error('Ollama cloud session usage limit reached'))).toMatchObject({
			kind: 'provider_error'
		});
	});

	it('detects timeout wording without PanelTurnError', () => {
		expect(classifyTurnError(new Error('opencode timed out'))).toMatchObject({ kind: 'timeout' });
	});
});

describe('scoreTurnDependent', () => {
	it('reports inconclusive — not pass — when a turn produced zero parts', () => {
		const check = scoreTurnDependent(
			'the decoy marker does NOT come back (built-in tools are off)',
			emptyTurn,
			true, // would have been a false pass under the old boolean scorer
			'marker absent'
		);
		expect(check.verdict).toBe('inconclusive');
		expect(check.detail).toMatch(/zero parts/);
		expect(formatCheckLine(check)).toMatch(/^INCONCLUSIVE/);
	});

	it('names a harness timeout distinctly from a silent empty turn', () => {
		const check = scoreTurnDependent('send is not reachable', timedOutTurn, true, 'no send');
		expect(check.verdict).toBe('inconclusive');
		expect(check.detail).toMatch(/harness timed out/);
		expect(check.detail).toMatch(/opencode timed out/);
	});

	it('names a provider error distinctly from a harness timeout', () => {
		const check = scoreTurnDependent('tool names are bare', providerTurn, true, 'no tools');
		expect(check.verdict).toBe('inconclusive');
		expect(check.detail).toMatch(/provider error/);
		expect(check.detail).not.toMatch(/harness timed out/);
	});

	it('scores pass/fail normally once the turn produced parts', () => {
		expect(
			scoreTurnDependent('a real turn produces tool calls and text', liveTurn, true, '1 tool, 1 text')
				.verdict
		).toBe('pass');
		expect(
			scoreTurnDependent('a real turn produces tool calls and text', liveTurn, false, '0 tools').verdict
		).toBe('fail');
	});
});

describe('scoreModelFree', () => {
	it('keeps model-free checks as plain pass/fail', () => {
		expect(
			scoreModelFree('a crafted `send` call is refused by the dispatcher', true, 'http 200, refused')
				.verdict
		).toBe('pass');
		expect(scoreModelFree('and STILL creates zero outbox rows', true, 'outbox rows=0').verdict).toBe(
			'pass'
		);
		expect(scoreModelFree('a crafted `send` call is refused by the dispatcher', false, 'no refusal').verdict).toBe(
			'fail'
		);
	});
});

describe('scoreMissingProposal', () => {
	it('is inconclusive when there is nothing to confirm', () => {
		expect(scoreMissingProposal('proposal through to click', emptyTurn).verdict).toBe('inconclusive');
		expect(scoreMissingProposal('proposal through to click', liveTurn).verdict).toBe('inconclusive');
	});
});

describe('summarizeChecks', () => {
	it('exits non-zero when any check is inconclusive', () => {
		const summary = summarizeChecks([
			scoreModelFree('a crafted `send` call is refused by the dispatcher', true, 'refused'),
			scoreModelFree('and STILL creates zero outbox rows', true, 'outbox rows=0'),
			scoreTurnDependent('decoy marker does NOT come back', timedOutTurn, true, 'absent'),
			scoreTurnDependent('`send` is not reachable from a model turn at all', timedOutTurn, true, 'no send')
		]);
		expect(summary.exitCode).toBe(1);
		expect(summary.measured).toHaveLength(2);
		expect(summary.unmeasured).toHaveLength(2);
		expect(summary.headline).toMatch(/Measured 2\/4/);
		expect(summary.headline).toMatch(/NOT measured/);
		expect(summary.headline).toMatch(/Model-free passes are still valid/);
	});

	it('exits zero only when every check is a plain pass', () => {
		const summary = summarizeChecks([
			scoreModelFree('crafted send refused', true, 'ok'),
			scoreTurnDependent('real turn', liveTurn, true, 'ok')
		]);
		expect(summary.exitCode).toBe(0);
		expect(summary.unmeasured).toHaveLength(0);
	});

	it('exits non-zero on fail as well', () => {
		expect(
			summarizeChecks([scoreModelFree('crafted send refused', false, 'not refused')]).exitCode
		).toBe(1);
	});
});

describe('inconclusiveReasonForTurn', () => {
	it('mentions absence is not evidence', () => {
		expect(inconclusiveReasonForTurn(emptyTurn)).toMatch(/absence is not evidence/);
		expect(inconclusiveReasonForTurn(timedOutTurn)).toMatch(/absence is not evidence/);
	});
});
