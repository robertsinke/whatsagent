import { describe, expect, it } from 'vitest';
import type {
	AgentPart,
	AgentToolPart
} from '../../../../shared/agent-events.js';
import {
	groupTurns,
	hasActiveSessions,
	isTurnInFlight,
	panelEmptyState,
	toolArgSummary,
	toolResultSummary,
	toolStateLabel
} from './agent-panel.js';

function text(partId: string, text: string): AgentPart {
	return { kind: 'text', sessionId: 's', messageId: 'm', partId, text };
}

function tool(
	partId: string,
	overrides: Partial<AgentToolPart> = {}
): AgentToolPart {
	return {
		kind: 'tool',
		sessionId: 's',
		messageId: 'm',
		partId,
		name: 'open_chat',
		input: { jid: 'preview-direct@s.whatsapp.net' },
		state: 'complete',
		output: { opened: 'preview-direct@s.whatsapp.net' },
		...overrides
	};
}

function stepStart(partId: string): AgentPart {
	return { kind: 'step-start', sessionId: 's', messageId: 'm', partId };
}
function stepFinish(partId: string): AgentPart {
	return { kind: 'step-finish', sessionId: 's', messageId: 'm', partId };
}

describe('groupTurns', () => {
	it('wraps parts between step-start and step-finish into one turn', () => {
		const turns = groupTurns([
			stepStart('step-1'),
			tool('t-1'),
			text('txt-1', 'Opened chat.'),
			stepFinish('step-1-end')
		]);
		expect(turns).toHaveLength(1);
		// step-start / step-finish are markers, not body parts — only the tool
		// and text fall inside the turn.
		expect(turns[0]!.parts).toHaveLength(2);
		expect(turns[0]!.inFlight).toBe(false);
		expect(turns[0]!.id).toBe('step-1');
	});

	it('marks a turn in-flight when step-finish has not arrived', () => {
		const turns = groupTurns([stepStart('step-1'), tool('t-1')]);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.inFlight).toBe(true);
	});

	it('collects parts outside any step into a stray turn rather than dropping them', () => {
		const turns = groupTurns([tool('t-1'), text('txt-1', 'hi')]);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.parts).toHaveLength(2);
		expect(turns[0]!.inFlight).toBe(false);
	});

	it('flushes stray parts into their own turn before a step-start, not merged into it', () => {
		const turns = groupTurns([text('stray', 'pre'), stepStart('step-1'), tool('t-1')]);
		expect(turns).toHaveLength(2);
		expect(turns[0]!.parts).toEqual([text('stray', 'pre')]);
		expect(turns[1]!.parts).toEqual([tool('t-1')]);
		expect(turns[1]!.inFlight).toBe(true);
	});

	it('renders a step-finish with no open step as a closed stray turn', () => {
		const turns = groupTurns([stepFinish('orphan-end')]);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.inFlight).toBe(false);
	});

	it('preserves part order within a turn', () => {
		const turns = groupTurns([
			stepStart('step-1'),
			tool('t-1', { name: 'open_chat' }),
			text('txt-1', 'a'),
			text('txt-2', 'b'),
			stepFinish('step-1-end')
		]);
		expect(turns[0]!.parts.map((p) => p.partId)).toEqual(['t-1', 'txt-1', 'txt-2']);
	});

	it('returns an empty array for no parts', () => {
		expect(groupTurns([])).toEqual([]);
	});
});

describe('toolStateLabel', () => {
	it('maps each lifecycle state to a concise human word', () => {
		expect(toolStateLabel('pending')).toBe('queued');
		expect(toolStateLabel('running')).toBe('running');
		expect(toolStateLabel('complete')).toBe('done');
		expect(toolStateLabel('error')).toBe('failed');
	});
});

describe('toolArgSummary', () => {
	it('picks the jid out of a structured input', () => {
		expect(toolArgSummary({ jid: 'preview@s.whatsapp.net', extra: 1 })).toBe(
			'preview@s.whatsapp.net'
		);
	});

	it('falls back to other common keys when jid is absent', () => {
		expect(toolArgSummary({ name: 'shorten' })).toBe('shorten');
		expect(toolArgSummary({ intent: 'warmer' })).toBe('warmer');
	});

	it('returns the string unchanged for a scalar input', () => {
		expect(toolArgSummary('hello')).toBe('hello');
		expect(toolArgSummary(42)).toBe('42');
	});

	it('returns empty when there is nothing concise to show', () => {
		expect(toolArgSummary(null)).toBe('');
		expect(toolArgSummary(undefined)).toBe('');
		expect(toolArgSummary({ verbose: { nested: true } })).toBe('');
		expect(toolArgSummary({})).toBe('');
	});

	it('skips empty-string values', () => {
		expect(toolArgSummary({ jid: '', name: 'fallback' })).toBe('fallback');
	});
});

describe('toolResultSummary', () => {
	it('surfaces the error string on an error state, never swallowing it', () => {
		expect(toolResultSummary(tool('t', { state: 'error', error: 'chat not found' }))).toBe(
			'chat not found'
		);
	});

	it('returns a default for an error with no error string', () => {
		expect(toolResultSummary(tool('t', { state: 'error' }))).toBe('error');
	});

	it('shows nothing for a pending or running tool — the state label carries it', () => {
		expect(toolResultSummary(tool('t', { state: 'pending' }))).toBe('');
		expect(toolResultSummary(tool('t', { state: 'running' }))).toBe('');
	});

	it('picks a legible scalar out of a structured output for a complete tool', () => {
		expect(
			toolResultSummary(tool('t', { state: 'complete', output: { opened: 'preview@s.whatsapp.net' } }))
		).toBe('preview@s.whatsapp.net');
	});

	it('returns empty for a complete tool with no concise output', () => {
		expect(toolResultSummary(tool('t', { state: 'complete', output: { ok: true } }))).toBe('');
	});
});

describe('isTurnInFlight', () => {
	it('is true while the step is open', () => {
		const turns = groupTurns([stepStart('s'), tool('t')]);
		expect(isTurnInFlight(turns[0]!)).toBe(true);
	});

	it('is false once the step finishes and all tools complete', () => {
		const turns = groupTurns([stepStart('s'), tool('t'), stepFinish('e')]);
		expect(isTurnInFlight(turns[0]!)).toBe(false);
	});

	it('is true when a tool is still pending even in a closed stray turn', () => {
		const turns = groupTurns([tool('t', { state: 'pending' })]);
		expect(isTurnInFlight(turns[0]!)).toBe(true);
	});

	it('is true when a tool is still running in a closed stray turn', () => {
		const turns = groupTurns([tool('t', { state: 'running' })]);
		expect(isTurnInFlight(turns[0]!)).toBe(true);
	});
});

describe('hasActiveSessions', () => {
	it('is false when there are no sessions — the normal resting state', () => {
		expect(hasActiveSessions({})).toBe(false);
	});

	it('is true once a session exists with parts', () => {
		expect(hasActiveSessions({ s: { parts: [text('t', 'hi')] } })).toBe(true);
	});

	it('is true for a session whose parts list is empty (a step-start with no body yet)', () => {
		expect(hasActiveSessions({ s: { parts: [stepStart('s')] } })).toBe(true);
	});
});
/**
 * PANEL-S1 — the copy is the feature here. The shipped empty state told the
 * owner to "start the app with WHATSAGENT_MCP=1", which a double-clicked .app
 * can never receive and which would not have been sufficient anyway. These
 * assertions are the regression guard on that: no variant may point at an env
 * var, and every not-running variant must name the place the owner can act.
 */
describe('panelEmptyState (PANEL-S1)', () => {
	const idle = panelEmptyState({ available: true, restartRequired: false });
	const restart = panelEmptyState({ available: false, restartRequired: true });
	const off = panelEmptyState({ available: false, restartRequired: false });

	it('shows the idle copy when the panel is running', () => {
		expect(idle.state).toBe('idle');
		expect(idle.title).toBe('Agent is idle');
		expect(idle.placeholder).toMatch(/Ask the agent/);
	});

	it('asks for a restart when the setting is on but this process is not', () => {
		expect(restart.state).toBe('restart-required');
		expect(restart.title).toMatch(/[Rr]estart/);
		expect(restart.body).toMatch(/Settings/);
		expect(restart.body).toMatch(/[Rr]estart|reopen/);
	});

	it('points an unconfigured owner at Settings, not at a harness they have to guess', () => {
		expect(off.state).toBe('not-configured');
		expect(off.body).toMatch(/Settings/);
		// R9 is worth restating exactly where the owner decides to turn this on.
		expect(off.body).toMatch(/never send/);
	});

	it('`available` wins over a stale restart flag', () => {
		// Both true is reachable for one paint: the status refetch that clears
		// restartRequired can land after the panel is already running.
		expect(panelEmptyState({ available: true, restartRequired: true }).state).toBe('idle');
	});

	it('never mentions the env var again, in any variant', () => {
		for (const variant of [idle, restart, off]) {
			const all = `${variant.title} ${variant.body} ${variant.placeholder}`;
			expect(all).not.toMatch(/WHATSAGENT_MCP/);
			expect(all).not.toMatch(/MCP/);
		}
	});

	it('gives every variant a distinct, non-empty composer placeholder', () => {
		const placeholders = [idle, restart, off].map((v) => v.placeholder);
		expect(new Set(placeholders).size).toBe(3);
		for (const placeholder of placeholders) expect(placeholder.length).toBeGreaterThan(0);
	});
});
