/**
 * VEVENT parse + RRULE expansion via ical.js (Mozilla).
 *
 * Recurrence is not optional — a digest that misses a weekly standup makes a
 * later unit confidently wrong about availability. If ical.js proves unsuitable,
 * say so in the execution report rather than hand-rolling RRULE.
 */
import ICAL from 'ical.js';

export type CalendarEventOccurrence = {
	uid: string;
	summary: string;
	start: string; // ISO-8601
	end: string; // ISO-8601
	location: string | null;
	allDay: boolean;
	recurrenceId: string | null;
};

const MAX_EXPANSION_ITERATIONS = 2_000;

/**
 * Expand every VEVENT in one or more iCalendar payloads into occurrences that
 * overlap [rangeStart, rangeEnd). Honours TZID via VTIMEZONE components in the
 * payload (Google includes them) and via ical.js's UTC conversion.
 */
export function expandIcalInRange(
	icalPayloads: string[],
	rangeStart: Date,
	rangeEnd: Date
): CalendarEventOccurrence[] {
	if (!(rangeStart < rangeEnd)) return [];
	const out: CalendarEventOccurrence[] = [];
	const rangeStartMs = rangeStart.getTime();
	const rangeEndMs = rangeEnd.getTime();

	for (const payload of icalPayloads) {
		const trimmed = payload.trim();
		if (!trimmed) continue;
		let root: ICAL.Component;
		try {
			const jcal = ICAL.parse(trimmed);
			root = new ICAL.Component(jcal);
		} catch {
			continue;
		}

		// Register any VTIMEZONE so DTSTART with TZID converts correctly.
		for (const tz of root.getAllSubcomponents('vtimezone')) {
			const tzid = tz.getFirstPropertyValue('tzid');
			if (typeof tzid === 'string' && tzid && !ICAL.TimezoneService.has(tzid)) {
				try {
					const zone = new ICAL.Timezone({ component: tz, tzid });
					// ical.js types: register(timezone, name?). Runtime also
					// accepts the legacy (name, timezone) order.
					ICAL.TimezoneService.register(zone, tzid);
				} catch {
					// Unknown / malformed zone — fall through; toJSDate may still work as floating.
				}
			}
		}

		const vevents =
			root.name === 'vevent'
				? [root]
				: root.getAllSubcomponents('vevent');

		for (const vevent of vevents) {
			out.push(...expandVevent(vevent, rangeStartMs, rangeEndMs));
		}
	}

	out.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
	return out;
}

function expandVevent(
	vevent: ICAL.Component,
	rangeStartMs: number,
	rangeEndMs: number
): CalendarEventOccurrence[] {
	const event = new ICAL.Event(vevent);
	const uid = event.uid || textProp(vevent, 'uid') || '';
	const summary = event.summary || textProp(vevent, 'summary') || '(no title)';
	const location = event.location || textProp(vevent, 'location') || null;
	const durationMs = eventDurationMs(event);

	if (!event.startDate) return [];

	const occurrences: CalendarEventOccurrence[] = [];

	if (event.isRecurring()) {
		const expand = new ICAL.RecurExpansion({
			component: vevent,
			dtstart: event.startDate
		});
		let next: ICAL.Time | null;
		let i = 0;
		while ((next = expand.next()) && i++ < MAX_EXPANSION_ITERATIONS) {
			const startMs = next.toJSDate().getTime();
			const endMs = startMs + durationMs;
			if (startMs >= rangeEndMs) break;
			if (endMs <= rangeStartMs) continue;
			occurrences.push(
				toOccurrence({
					uid,
					summary,
					location,
					start: next,
					endMs,
					allDay: Boolean(next.isDate),
					recurrenceId: next.toString()
				})
			);
		}
	} else {
		const start = event.startDate;
		const startMs = start.toJSDate().getTime();
		const endMs = startMs + durationMs;
		if (endMs > rangeStartMs && startMs < rangeEndMs) {
			occurrences.push(
				toOccurrence({
					uid,
					summary,
					location,
					start,
					endMs,
					allDay: Boolean(start.isDate),
					recurrenceId: null
				})
			);
		}
	}

	return occurrences;
}

function eventDurationMs(event: ICAL.Event): number {
	if (event.endDate && event.startDate) {
		const ms = event.endDate.toJSDate().getTime() - event.startDate.toJSDate().getTime();
		if (Number.isFinite(ms) && ms > 0) return ms;
	}
	if (event.duration) {
		try {
			const seconds = event.duration.toSeconds();
			if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
		} catch {
			// fall through
		}
	}
	// All-day default: one calendar day. Timed default: one hour.
	return event.startDate?.isDate ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
}

function toOccurrence(args: {
	uid: string;
	summary: string;
	location: string | null;
	start: ICAL.Time;
	endMs: number;
	allDay: boolean;
	recurrenceId: string | null;
}): CalendarEventOccurrence {
	const startDate = args.start.toJSDate();
	const endDate = new Date(args.endMs);
	return {
		uid: args.uid,
		summary: args.summary,
		start: startDate.toISOString(),
		end: endDate.toISOString(),
		location: args.location,
		allDay: args.allDay,
		recurrenceId: args.recurrenceId
	};
}

function textProp(vevent: ICAL.Component, name: string): string | null {
	const value = vevent.getFirstPropertyValue(name);
	return typeof value === 'string' ? value : null;
}

export type BuildVeventInput = {
	uid: string;
	summary: string;
	start: string; // ISO-8601
	end: string; // ISO-8601
	location?: string | null;
	/** Defaults to now (UTC). */
	dtstamp?: Date;
};

/**
 * Hand-build a VCALENDAR containing one VEVENT for CalDAV PUT.
 * Times are written as UTC (`…Z`). Writing is simple enough to hand-build;
 * parsing/RRULE stays on ical.js.
 */
export function buildVeventIcal(input: BuildVeventInput): string {
	const stamp = formatIcalUtc(input.dtstamp ?? new Date());
	const start = formatIcalUtc(new Date(input.start));
	const end = formatIcalUtc(new Date(input.end));
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//whatsagent//EN',
		'CALSCALE:GREGORIAN',
		'BEGIN:VEVENT',
		`UID:${escapeIcalText(input.uid)}`,
		`DTSTAMP:${stamp}`,
		`DTSTART:${start}`,
		`DTEND:${end}`,
		`SUMMARY:${escapeIcalText(input.summary)}`
	];
	if (input.location?.trim()) {
		lines.push(`LOCATION:${escapeIcalText(input.location.trim())}`);
	}
	lines.push('END:VEVENT', 'END:VCALENDAR', '');
	return lines.join('\r\n');
}

function formatIcalUtc(date: Date): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	const d = String(date.getUTCDate()).padStart(2, '0');
	const hh = String(date.getUTCHours()).padStart(2, '0');
	const mm = String(date.getUTCMinutes()).padStart(2, '0');
	const ss = String(date.getUTCSeconds()).padStart(2, '0');
	return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

/** RFC 5545 TEXT escaping: `\`, `;`, `,`, newlines. */
function escapeIcalText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n/g, '\\n')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\n');
}
