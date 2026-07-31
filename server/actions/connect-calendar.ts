/**
 * FRONTEND ONLY — saves a Google Calendar App Password (durable account
 * credential) and optionally runs a live PROPFIND. Installing credentials is a
 * different threat model than any drafting or panel tool; the panel agent reads
 * via `list-calendar-events`, it does not configure the connection.
 *
 * Odysseus trap: after save, the PROPFIND must use {@link getCalendarCredentials}
 * (the single decrypting accessor), not the plaintext just submitted. That is
 * how a write-path decrypt bug is caught here rather than in CAL-2.
 */
import {
	defaultGoogleCalDavEventsUrl,
	propfind,
	type CalDavFetch
} from '../calendar/caldav.js';
import {
	getCalendarCredentials,
	saveCalendarCredentials,
	type CalendarCredentials
} from '../calendar/credentials.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ConnectCalendarMode = 'test' | 'save';

export type ConnectCalendarInput = {
	serverUrl: string;
	email: string;
	password: string;
	mode: ConnectCalendarMode;
};

export type ConnectCalendarDeps = {
	fetch?: CalDavFetch;
	encryptionKey?: Buffer;
};

function asNonEmptyString(value: unknown, field: string): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export function createConnectCalendarAction(
	defaults: ConnectCalendarDeps = {}
): ActionDefinition<ConnectCalendarInput> {
	return {
		name: 'connect-calendar',
		callers: ['frontend'],
		jsonSchema: {
			type: 'object',
			properties: {
				serverUrl: {
					type: 'string',
					description:
						'CalDAV events URL. Google legacy: https://www.google.com/calendar/dav/EMAIL/events'
				},
				email: { type: 'string', description: 'Google account email.' },
				password: {
					type: 'string',
					description:
						'Google App Password from myaccount.google.com/apppasswords (2-Step Verification required).'
				},
				mode: {
					type: 'string',
					enum: ['test', 'save'],
					description: 'test = PROPFIND only; save = encrypt, persist, then PROPFIND via the decrypting accessor.'
				}
			},
			required: ['serverUrl', 'email', 'password', 'mode'],
			additionalProperties: false
		},
		parse(raw: unknown) {
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				return parseError(400, 'Body must be an object');
			}
			const body = raw as Record<string, unknown>;
			const email = asNonEmptyString(body.email, 'email');
			if (!email) return parseError(400, 'email is required');
			const password = asNonEmptyString(body.password, 'password');
			if (!password) return parseError(400, 'password is required');
			let serverUrl = asNonEmptyString(body.serverUrl, 'serverUrl');
			if (!serverUrl) serverUrl = defaultGoogleCalDavEventsUrl(email);
			const mode = body.mode;
			if (mode !== 'test' && mode !== 'save') {
				return parseError(400, 'mode must be test or save');
			}
			return { ok: true, input: { serverUrl, email, password, mode } };
		},
		async run(input, ctx) {
			const fetchImpl = ctx.deps.calendarFetch ?? defaults.fetch;
			const encryptionKey = ctx.deps.calendarEncryptionKey ?? defaults.encryptionKey;
			const submitted: CalendarCredentials = {
				serverUrl: input.serverUrl,
				email: input.email,
				password: input.password
			};

			if (input.mode === 'save') {
				try {
					saveCalendarCredentials(ctx.deps.db, submitted, encryptionKey);
				} catch (err) {
					return actionError(
						500,
						err instanceof Error ? err.message : 'Failed to save calendar credentials'
					);
				}

				// Binding: PROPFIND after save MUST go through getCalendarCredentials
				// so a write-path that forgot to decrypt cannot silently succeed here.
				const stored = getCalendarCredentials(ctx.deps.db, encryptionKey);
				if (!stored) {
					return actionError(500, 'Calendar credentials missing after save');
				}
				try {
					const result = await propfind(
						stored,
						fetchImpl ? { fetch: fetchImpl } : {}
					);
					return actionJson(200, {
						mode: 'save',
						saved: true,
						ok: result.ok,
						status: result.status,
						serverUrl: stored.serverUrl,
						email: stored.email
					});
				} catch (err) {
					return actionError(
						502,
						err instanceof Error ? err.message : 'CalDAV PROPFIND failed',
						{ saved: true }
					);
				}
			}

			try {
				const result = await propfind(
					submitted,
					fetchImpl ? { fetch: fetchImpl } : {}
				);
				return actionJson(200, {
					mode: 'test',
					saved: false,
					ok: result.ok,
					status: result.status,
					serverUrl: submitted.serverUrl,
					email: submitted.email
				});
			} catch (err) {
				return actionError(
					502,
					err instanceof Error ? err.message : 'CalDAV PROPFIND failed',
					{ saved: false }
				);
			}
		}
	};
}

export const connectCalendarAction = createConnectCalendarAction();
