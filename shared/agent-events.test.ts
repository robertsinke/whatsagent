import { describe, expect, it } from 'vitest';
import {
	isKnownAgentPartKind,
	mergeAgentText,
	upsertAgentPart,
	type AgentPart
} from './agent-events.js';

describe('isKnownAgentPartKind', () => {
	it('accepts the closed set and rejects unknown kinds', () => {
		expect(isKnownAgentPartKind('text')).toBe(true);
		expect(isKnownAgentPartKind('tool')).toBe(true);
		expect(isKnownAgentPartKind('step-start')).toBe(true);
		expect(isKnownAgentPartKind('step-finish')).toBe(true);
		expect(isKnownAgentPartKind('reasoning')).toBe(false);
		expect(isKnownAgentPartKind('')).toBe(false);
	});
});

describe('mergeAgentText', () => {
	it('appends a delta when the snapshot has not advanced', () => {
		expect(mergeAgentText('Hel', 'Hel', 'lo')).toBe('Hello');
	});

	it('prefers a longer snapshot over an older one (out-of-order)', () => {
		expect(mergeAgentText('Hello', 'Hel', undefined)).toBe('Hello');
		expect(mergeAgentText('Hello world', 'Hello', ' world')).toBe('Hello world');
	});

	it('skips a duplicate delta with an unchanged snapshot', () => {
		expect(mergeAgentText('Hello', 'Hello', 'lo')).toBe('Hello');
	});

	it('trusts a snapshot that already absorbed the delta', () => {
		expect(mergeAgentText('Hel', 'Hello', 'lo')).toBe('Hello');
	});
});

describe('upsertAgentPart', () => {
	const base = {
		sessionId: 's1',
		messageId: 'm1',
		partId: 'p1'
	} as const;

	it('creates a missing part and appends deltas onto it', () => {
		let parts: AgentPart[] = [];
		parts = upsertAgentPart(parts, { ...base, kind: 'text', text: 'Hi' }, 'Hi');
		parts = upsertAgentPart(parts, { ...base, kind: 'text', text: 'Hi' }, ' there');
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ kind: 'text', text: 'Hi there' });
	});

	it('updates tool state in place without losing prior output on incomplete payloads', () => {
		let parts: AgentPart[] = [];
		parts = upsertAgentPart(parts, {
			...base,
			kind: 'tool',
			name: 'draft',
			input: { jid: 'x' },
			state: 'running'
		});
		parts = upsertAgentPart(parts, {
			...base,
			kind: 'tool',
			name: 'draft',
			input: { jid: 'x' },
			state: 'complete',
			output: { text: 'ok' }
		});
		expect(parts[0]).toMatchObject({
			kind: 'tool',
			state: 'complete',
			output: { text: 'ok' }
		});
	});
});
