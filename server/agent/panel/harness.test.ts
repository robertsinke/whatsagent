import { describe, expect, it } from 'vitest';
import {
	buildPanelPrompt,
	MAX_CHARS_PER_FIELD,
	MAX_HISTORY_TURNS,
	normalizeToolName,
	parseToolPayload,
	renderHistory,
	toToolState,
	type PanelTurnSummary
} from './harness.js';

describe('normalizeToolName', () => {
	// The two prefixes are not guesses — both were read off real transcripts, and
	// the thing worth pinning is that the kebab-case action name survives intact
	// in each. A harness that sanitized `refine-draft` to `refine_draft` would
	// leave the panel showing a name no registry action has.
	it('strips the opencode prefix and keeps the kebab-case action name', () => {
		expect(normalizeToolName('whatsagent_refine-draft')).toBe('refine-draft');
		expect(normalizeToolName('whatsagent_mark-read')).toBe('mark-read');
	});

	it('strips the claude prefix', () => {
		expect(normalizeToolName('mcp__whatsagent__refine-draft')).toBe('refine-draft');
		expect(normalizeToolName('mcp__whatsagent__propose-send')).toBe('propose-send');
	});

	it('passes an unrecognised name through unchanged', () => {
		// A built-in should never appear (both configs disable them), but showing
		// its real name beats showing a mangled one and beats showing nothing.
		expect(normalizeToolName('read')).toBe('read');
		expect(normalizeToolName('mcp__other__thing')).toBe('mcp__other__thing');
		expect(normalizeToolName('')).toBe('');
	});

	it('prefers the longer prefix so the claude form is not half-stripped', () => {
		// `mcp__whatsagent__x` also contains `whatsagent_`; matching that first
		// would yield `_x`.
		expect(normalizeToolName('mcp__whatsagent__x')).toBe('x');
	});
});

describe('renderHistory', () => {
	const turn = (n: number): PanelTurnSummary => ({ prompt: `ask ${n}`, reply: `reply ${n}` });

	it('is empty for a first turn', () => {
		expect(renderHistory([])).toBe('');
	});

	it('keeps only the most recent turns, oldest first', () => {
		const many = Array.from({ length: MAX_HISTORY_TURNS + 4 }, (_, i) => turn(i));
		const rendered = renderHistory(many);
		expect(rendered).not.toContain('ask 0');
		expect(rendered).toContain(`ask ${MAX_HISTORY_TURNS + 3}`);
		// Oldest retained turn comes before the newest in the rendered text.
		expect(rendered.indexOf('ask 4')).toBeLessThan(rendered.indexOf(`ask ${MAX_HISTORY_TURNS + 3}`));
		expect(rendered.match(/Owner:/g)).toHaveLength(MAX_HISTORY_TURNS);
	});

	it('marks truncation instead of silently cutting a field', () => {
		const rendered = renderHistory([{ prompt: 'a'.repeat(MAX_CHARS_PER_FIELD + 50), reply: 'ok' }]);
		expect(rendered).toContain('[truncated]');
		// The whole point: the model can see it is reading a summary.
		expect(rendered).not.toContain('a'.repeat(MAX_CHARS_PER_FIELD + 1));
	});
});

describe('buildPanelPrompt', () => {
	it('puts the owner text last, after any history', () => {
		const prompt = buildPanelPrompt({
			sessionId: 's',
			messageId: 'm',
			text: 'do the thing',
			history: [{ prompt: 'earlier', reply: 'done' }]
		});
		expect(prompt.indexOf('earlier')).toBeLessThan(prompt.indexOf('do the thing'));
		expect(prompt.endsWith('Owner: do the thing')).toBe(true);
	});
});

describe('parseToolPayload', () => {
	it('parses the JSON body the MCP surface returns', () => {
		expect(parseToolPayload('{"jid":"a@s.whatsapp.net","unread":0}')).toEqual({
			jid: 'a@s.whatsapp.net',
			unread: 0
		});
	});

	it('keeps a non-JSON string as-is rather than throwing', () => {
		expect(parseToolPayload('not json')).toBe('not json');
		expect(parseToolPayload('{broken')).toBe('{broken');
	});

	it('passes through non-strings', () => {
		expect(parseToolPayload({ already: 'object' })).toEqual({ already: 'object' });
		expect(parseToolPayload(undefined)).toBeUndefined();
	});
});

describe('toToolState', () => {
	it('maps the statuses both harnesses actually emit', () => {
		expect(toToolState('completed')).toBe('complete');
		expect(toToolState('error')).toBe('error');
		expect(toToolState('running')).toBe('running');
	});

	it('falls back to pending for anything unrecognised', () => {
		// A new status must not become `complete` by accident — that would show a
		// still-running call as finished.
		expect(toToolState('something-new')).toBe('pending');
		expect(toToolState(undefined)).toBe('pending');
	});
});
