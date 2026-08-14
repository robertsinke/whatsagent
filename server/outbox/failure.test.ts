import { describe, expect, it } from 'vitest';
import { Boom } from '@hapi/boom';
import { WhatsAppDisconnectedError } from '../channels/whatsapp/send.js';
import { classifySendFailure, failureMessage, retryDelayMs } from './failure.js';

describe('classifySendFailure', () => {
	it('treats a missing socket as offline, not as a failed attempt', () => {
		expect(classifySendFailure(new WhatsAppDisconnectedError())).toBe('offline');
	});

	it('retries the send path’s own connection and encryption throws', () => {
		// The literal throw sites in baileys' send path.
		expect(classifySendFailure(new Boom('Connection Closed', { statusCode: 428 }))).toBe(
			'transient'
		);
		expect(classifySendFailure(new Boom('All encryptions failed', { statusCode: 500 }))).toBe(
			'transient'
		);
		expect(classifySendFailure(new Boom('Not authenticated'))).toBe('transient');
	});

	it('fails a rejected payload terminally', () => {
		// `Utils/messages.js` throws these for content baileys will not build.
		expect(classifySendFailure(new Boom('no content in message', { statusCode: 400 }))).toBe(
			'terminal'
		);
		expect(classifySendFailure(new Boom('gone', { statusCode: 404 }))).toBe('terminal');
	});

	it('keeps timeouts and rate limits retryable even though they are 4xx', () => {
		// Baileys reuses the HTTP status space for connection lifecycle, so a bare
		// "4xx is terminal" rule would permanently fail rows across a reconnect.
		for (const status of [408, 411, 428, 429, 440]) {
			expect(classifySendFailure(new Boom('lifecycle', { statusCode: status }))).toBe('transient');
		}
	});

	it('retries an unrecognised error rather than dropping the owner’s message', () => {
		// Fail-safe polarity: the attempt cap bounds the traffic, so an unknown
		// error costs at most `maxAttempts` — guessing terminal costs a real send.
		expect(classifySendFailure(new Error('something odd'))).toBe('transient');
		expect(classifySendFailure('not even an error')).toBe('transient');
	});

	it('reads a nested Boom status the same way Boom exposes it', () => {
		expect(classifySendFailure({ output: { statusCode: 400 } })).toBe('terminal');
	});
});

describe('retryDelayMs', () => {
	it('waits exactly the base delay on the first retry, then doubles', () => {
		expect(retryDelayMs(1, 5_000, 300_000)).toBe(5_000);
		expect(retryDelayMs(2, 5_000, 300_000)).toBe(10_000);
		expect(retryDelayMs(3, 5_000, 300_000)).toBe(20_000);
		expect(retryDelayMs(4, 5_000, 300_000)).toBe(40_000);
	});

	it('never exceeds the ceiling or drops below the base', () => {
		expect(retryDelayMs(40, 5_000, 300_000)).toBe(300_000);
		expect(retryDelayMs(0, 5_000, 300_000)).toBe(5_000);
	});
});

describe('failureMessage', () => {
	it('collapses whitespace and caps the stored reason', () => {
		expect(failureMessage(new Error('  socket\n  closed  '))).toBe('socket closed');
		expect(failureMessage(new Error('x'.repeat(500)))).toHaveLength(300);
		expect(failureMessage(new Error('   '))).toBe('Send failed');
	});
});
