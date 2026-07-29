import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type AllowedOrigins = ReadonlySet<string>;

/**
 * Build the set of origins the SPA is allowed to call from.
 * Bound to loopback only — never include LAN / 0.0.0.0 hosts.
 */
export function buildAllowedOrigins(port: number): AllowedOrigins {
	return new Set([
		`http://localhost:${port}`,
		`http://127.0.0.1:${port}`,
		// Vite's fixed development origin. The proxy preserves the incoming
		// Origin, so a foreign page remains foreign and is rejected here.
		'http://localhost:5173',
		'http://127.0.0.1:5173'
	]);
}

function isLoopbackHost(host: string): boolean {
	const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * DNS-rebinding half of the mutating-request defense. Both the browser Origin
 * path and the MCP bearer path require this — neither may relax it.
 */
export function validateLoopbackHost(
	req: IncomingMessage
): { ok: true } | { ok: false; reason: string } {
	const host = req.headers.host;
	if (!host || typeof host !== 'string') {
		return { ok: false, reason: 'missing Host' };
	}
	if (!isLoopbackHost(host)) {
		return { ok: false, reason: 'Host is not loopback' };
	}
	return { ok: true };
}

/**
 * Localhost CSRF / DNS-rebinding defense for mutating REST and WS upgrade.
 * Requires BOTH:
 * - Host is a loopback name (rejects rebinding to a public Host)
 * - Origin is present and exactly matches an allowed app origin
 */
export function validateOriginAndHost(
	req: IncomingMessage,
	allowedOrigins: AllowedOrigins
): { ok: true } | { ok: false; reason: string } {
	const hostCheck = validateLoopbackHost(req);
	if (!hostCheck.ok) return hostCheck;

	const origin = req.headers.origin;
	if (!origin || typeof origin !== 'string') {
		return { ok: false, reason: 'missing Origin' };
	}
	if (!allowedOrigins.has(origin)) {
		return { ok: false, reason: 'Origin not allowed' };
	}

	return { ok: true };
}

/**
 * Non-browser auth path for the MCP surface. Shares the loopback Host check
 * with {@link validateOriginAndHost}; replaces only the Origin requirement
 * with a bearer token. Missing and wrong tokens fail identically.
 */
export function validateHostAndBearer(
	req: IncomingMessage,
	expectedToken: string
): { ok: true } | { ok: false; reason: string; status: 401 | 403 } {
	const hostCheck = validateLoopbackHost(req);
	if (!hostCheck.ok) {
		return { ok: false, reason: hostCheck.reason, status: 403 };
	}

	const presented = extractBearerToken(req);
	if (!presented || !bearerTokensEqual(presented, expectedToken)) {
		return { ok: false, reason: 'unauthorized', status: 401 };
	}
	return { ok: true };
}

/** Parse `Authorization: Bearer <token>`. Returns null when absent or malformed. */
export function extractBearerToken(req: IncomingMessage): string | null {
	const header = req.headers.authorization;
	if (!header || typeof header !== 'string') return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	return match?.[1] ?? null;
}

/**
 * Constant-time compare. Length mismatch still runs a dummy compare so the
 * failure mode does not advertise token length via timing.
 */
export function bearerTokensEqual(presented: string, expected: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(expected);
	if (a.length !== b.length) {
		timingSafeEqual(a, a);
		return false;
	}
	return timingSafeEqual(a, b);
}

export function isMutatingMethod(method: string): boolean {
	return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
