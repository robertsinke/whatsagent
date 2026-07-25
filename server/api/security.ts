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
 * Localhost CSRF / DNS-rebinding defense for mutating REST and WS upgrade.
 * Requires BOTH:
 * - Host is a loopback name (rejects rebinding to a public Host)
 * - Origin is present and exactly matches an allowed app origin
 */
export function validateOriginAndHost(
	req: IncomingMessage,
	allowedOrigins: AllowedOrigins
): { ok: true } | { ok: false; reason: string } {
	const host = req.headers.host;
	if (!host || typeof host !== 'string') {
		return { ok: false, reason: 'missing Host' };
	}
	if (!isLoopbackHost(host)) {
		return { ok: false, reason: 'Host is not loopback' };
	}

	const origin = req.headers.origin;
	if (!origin || typeof origin !== 'string') {
		return { ok: false, reason: 'missing Origin' };
	}
	if (!allowedOrigins.has(origin)) {
		return { ok: false, reason: 'Origin not allowed' };
	}

	return { ok: true };
}

export function isMutatingMethod(method: string): boolean {
	return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
