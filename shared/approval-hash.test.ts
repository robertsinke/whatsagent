import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	approvalHashMatches,
	describeTextSource,
	hashApprovalText,
	sha256Hex
} from './approval-hash.js';

/**
 * The point of these tests is agreement, not novelty: the client hashes what it
 * rendered and the server hashes what it stored, and an approval is refused
 * when the two disagree. A wrong-but-consistent digest would still "pass" a
 * round-trip test, so every case here is checked against `node:crypto`, which
 * the shared module itself may not import.
 */
describe('sha256Hex', () => {
	it('matches the published vectors', () => {
		expect(sha256Hex('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it.each([
		'',
		'a',
		'hey — are we still on for tomorrow?',
		'🙃 emoji and “smart quotes”',
		'x'.repeat(55), // one byte under a padding block boundary
		'x'.repeat(56), // exactly at it — length spills into a second block
		'x'.repeat(64),
		'x'.repeat(1000),
		'line one\nline two\ttabbed'
	])('agrees with node:crypto for %j', (input) => {
		expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
	});
});

describe('hashApprovalText', () => {
	it('ignores surrounding whitespace, since every send path trims', () => {
		expect(hashApprovalText('  hello  ')).toBe(hashApprovalText('hello'));
	});

	it('changes for any change the owner could have seen', () => {
		expect(hashApprovalText('see you at 8')).not.toBe(hashApprovalText('see you at 9'));
		expect(hashApprovalText('ok')).not.toBe(hashApprovalText('Ok'));
	});
});

describe('approvalHashMatches', () => {
	it('is false for a missing or empty hash — absence is never a match', () => {
		expect(approvalHashMatches('hello', undefined)).toBe(false);
		expect(approvalHashMatches('hello', '')).toBe(false);
	});

	it('matches case-insensitively on the hex, and on the trimmed text', () => {
		const hash = hashApprovalText('hello');
		expect(approvalHashMatches('hello', hash)).toBe(true);
		expect(approvalHashMatches(' hello ', hash.toUpperCase())).toBe(true);
		expect(approvalHashMatches('hello!', hash)).toBe(false);
	});
});

describe('describeTextSource', () => {
	it('names the agent specifically, so the re-confirm copy is honest', () => {
		expect(describeTextSource('agent')).toMatch(/agent/i);
		expect(describeTextSource('owner')).not.toMatch(/agent/i);
		expect(describeTextSource(null)).not.toMatch(/agent/i);
	});
});
