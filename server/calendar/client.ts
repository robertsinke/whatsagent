/**
 * Transport-agnostic calendar client. CAL-2/3/4 depend on this interface so a
 * future swap off Google's deprecated legacy CalDAV endpoint (EventKit, OAuth)
 * does not touch those units.
 */
import {
	propfind,
	reportCalendarQuery,
	type CalDavFetch
} from './caldav.js';
import type { CalendarCredentials } from './credentials.js';
import { expandIcalInRange, type CalendarEventOccurrence } from './ical.js';

export type { CalendarEventOccurrence };

export type CalendarListResult = {
	events: CalendarEventOccurrence[];
	status: number;
};

export type CalendarTestResult = {
	status: number;
	ok: boolean;
};

export type CalendarClient = {
	testConnection(): Promise<CalendarTestResult>;
	listEvents(range: { start: Date; end: Date }): Promise<CalendarListResult>;
};

export type CreateCalendarClientOptions = {
	fetch?: CalDavFetch;
};

/**
 * Build a client bound to already-decrypted credentials.
 * Callers must obtain `creds` from {@link getCalendarCredentials} — never from
 * a second decrypt path, and never from ciphertext.
 */
export function createCalendarClient(
	creds: CalendarCredentials,
	options: CreateCalendarClientOptions = {}
): CalendarClient {
	const fetchImpl = options.fetch;

	return {
		async testConnection() {
			const result = await propfind(creds, fetchImpl ? { fetch: fetchImpl } : {});
			return { status: result.status, ok: result.ok };
		},

		async listEvents(range) {
			const report = await reportCalendarQuery(
				creds,
				range.start,
				range.end,
				fetchImpl ? { fetch: fetchImpl } : {}
			);
			if (!(report.status >= 200 && report.status < 300)) {
				return { events: [], status: report.status };
			}
			const payloads = report.entries.map((e) => e.calendarData);
			const events = expandIcalInRange(payloads, range.start, range.end);
			return { events, status: report.status };
		}
	};
}
