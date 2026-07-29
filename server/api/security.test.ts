import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
	bearerTokensEqual,
	buildAllowedOrigins,
	extractBearerToken,
	validateHostAndBearer,
	validateLoopbackHost,
	validateOriginAndHost
} from './security.js';

function req(headers: Record<string, string | undefined>): IncomingMessage {
	return { headers } as IncomingMessage;
}

describe('validateLoopbackHost', () => {
	it('accepts localhost / 127.0.0.1 / ::1', () => {
		expect(validateLoopbackHost(req({ host: '127.0.0.1:8787' }))).toEqual({ ok: true });
		expect(validateLoopbackHost(req({ host: 'localhost:8787' }))).toEqual({ ok: true });
		expect(validateLoopbackHost(req({ host: '[::1]:8787' }))).toEqual({ ok: true });
	});

	it('rejects a non-loopback Host', () => {
		expect(validateLoopbackHost(req({ host: 'evil.example:8787' }))).toEqual({
			ok: false,
			reason: 'Host is not loopback'
		});
	});
});

describe('validateOriginAndHost (browser path)', () => {
	const origins = buildAllowedOrigins(8787);

	it('still requires Origin after the shared Host check', () => {
		expect(validateOriginAndHost(req({ host: '127.0.0.1:8787' }), origins)).toEqual({
			ok: false,
			reason: 'missing Origin'
		});
	});

	it('accepts loopback Host + allowed Origin', () => {
		expect(
			validateOriginAndHost(
				req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }),
				origins
			)
		).toEqual({ ok: true });
	});
});

describe('validateHostAndBearer (MCP path)', () => {
	const token = 'a'.repeat(64);

	it('rejects non-loopback Host even with a valid bearer', () => {
		const result = validateHostAndBearer(
			req({
				host: 'evil.example:8787',
				authorization: `Bearer ${token}`
			}),
			token
		);
		expect(result).toEqual({
			ok: false,
			reason: 'Host is not loopback',
			status: 403
		});
	});

	it('rejects missing and wrong tokens identically (401)', () => {
		const missing = validateHostAndBearer(req({ host: '127.0.0.1:8787' }), token);
		const wrong = validateHostAndBearer(
			req({ host: '127.0.0.1:8787', authorization: 'Bearer wrong-token-value-here' }),
			token
		);
		expect(missing).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
		expect(wrong).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
	});

	it('accepts loopback Host + matching bearer', () => {
		expect(
			validateHostAndBearer(
				req({ host: '127.0.0.1:8787', authorization: `Bearer ${token}` }),
				token
			)
		).toEqual({ ok: true });
	});
});

describe('bearer token helpers', () => {
	it('extractBearerToken parses Authorization', () => {
		expect(extractBearerToken(req({ authorization: 'Bearer secret' }))).toBe('secret');
		expect(extractBearerToken(req({}))).toBeNull();
		expect(extractBearerToken(req({ authorization: 'Basic x' }))).toBeNull();
	});

	it('bearerTokensEqual is length-safe', () => {
		expect(bearerTokensEqual('abcd', 'abcd')).toBe(true);
		expect(bearerTokensEqual('abcd', 'abce')).toBe(false);
		expect(bearerTokensEqual('abcd', 'abc')).toBe(false);
	});
});
