/**
 * List Google Calendar events in a time range. Callers: frontend and tool —
 * this is how the panel agent answers "am I free Thursday?".
 *
 * READ-ONLY. Credentials always come from {@link getCalendarCredentials} (the
 * single decrypting accessor). No create/update/delete here — that is CAL-2
 * behind confirm-calendar-event.
 */
import type { CalDavFetch } from '../calendar/caldav.js';
import { createCalendarClient } from '../calendar/client.js';
import { getCalendarCredentials } from '../calendar/credentials.js';
import { clampCount, clampOffset } from './list-chats.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_RANGE_DAYS = 7;

export type ListCalendarEventsInput = {
	start: string | null;
	end: string | null;
	limit: number;
	offset: number;
};

export type ListCalendarEventsDeps = {
	fetch?: CalDavFetch;
	encryptionKey?: Buffer;
	now?: () => Date;
};

function parseIsoDate(value: unknown, field: string): string | null | typeof PARSE_FAIL {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') return PARSE_FAIL;
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) return PARSE_FAIL;
	return new Date(ms).toISOString();
}

const PARSE_FAIL = Symbol('parse-fail');

export function createListCalendarEventsAction(
	defaults: ListCalendarEventsDeps = {}
): ActionDefinition<ListCalendarEventsInput> {
	return {
		name: 'list-calendar-events',
		callers: ['frontend', 'tool'],
		jsonSchema: {
			type: 'object',
			properties: {
				start: {
					type: 'string',
					description: 'ISO-8601 range start (inclusive). Default: now.'
				},
				end: {
					type: 'string',
					description: `ISO-8601 range end (exclusive). Default: now + ${DEFAULT_RANGE_DAYS} days.`
				},
				limit: {
					type: 'number',
					description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`
				},
				offset: {
					type: 'number',
					description: 'Occurrences to skip, for paging.'
				}
			},
			additionalProperties: false
		},
		parse(raw: unknown) {
			const body = (raw ?? {}) as {
				start?: unknown;
				end?: unknown;
				limit?: unknown;
				offset?: unknown;
			};
			const start = parseIsoDate(body.start, 'start');
			if (start === PARSE_FAIL) return parseError(400, 'start must be an ISO-8601 datetime');
			const end = parseIsoDate(body.end, 'end');
			if (end === PARSE_FAIL) return parseError(400, 'end must be an ISO-8601 datetime');
			const limit = clampCount(body.limit, DEFAULT_LIMIT, MAX_LIMIT);
			if (limit === null) return parseError(400, `Expected limit to be 1-${MAX_LIMIT}`);
			const offset = clampOffset(body.offset);
			if (offset === null) return parseError(400, 'Expected offset to be a non-negative integer');
			return { ok: true, input: { start, end, limit, offset } };
		},
		async run(input, ctx) {
			const encryptionKey = ctx.deps.calendarEncryptionKey ?? defaults.encryptionKey;
			const creds = getCalendarCredentials(ctx.deps.db, encryptionKey);
			if (!creds) {
				return actionError(
					400,
					'Google Calendar is not connected. Add an App Password in Settings.'
				);
			}

			const nowFn = ctx.deps.calendarNow ?? defaults.now ?? (() => new Date());
			const now = nowFn();
			const rangeStart = input.start ? new Date(input.start) : now;
			const rangeEnd = input.end
				? new Date(input.end)
				: new Date(rangeStart.getTime() + DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
			if (!(rangeStart < rangeEnd)) {
				return actionError(400, 'start must be before end');
			}

			const fetchImpl = ctx.deps.calendarFetch ?? defaults.fetch;
			const client = createCalendarClient(
				creds,
				fetchImpl ? { fetch: fetchImpl } : {}
			);

			try {
				const result = await client.listEvents({ start: rangeStart, end: rangeEnd });
				if (!(result.status >= 200 && result.status < 300)) {
					return actionError(502, `CalDAV REPORT returned HTTP ${result.status}`, {
						status: result.status
					});
				}
				const total = result.events.length;
				const page = result.events.slice(input.offset, input.offset + input.limit);
				return actionJson(200, {
					items: page,
					total,
					offset: input.offset,
					limit: input.limit,
					has_more: input.offset + page.length < total,
					range: {
						start: rangeStart.toISOString(),
						end: rangeEnd.toISOString()
					}
				});
			} catch (err) {
				return actionError(
					502,
					err instanceof Error ? err.message : 'CalDAV REPORT failed'
				);
			}
		}
	};
}

export const listCalendarEventsAction = createListCalendarEventsAction();
