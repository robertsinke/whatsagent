import { describe, expect, it } from 'vitest';
import {
	buildCalendarDigest,
	fetchCalendarDigest,
	MAX_DIGEST_CHARS,
	MAX_DIGEST_EVENTS
} from './digest.js';
import { expandIcalInRange, type CalendarEventOccurrence } from './ical.js';

const NOW_MS = new Date('2026-07-31T08:00:00Z').getTime();
const TZ = 'UTC';

function occ(start: string, summary: string, extra: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
	return {
		uid: `uid-${summary}`,
		summary,
		start,
		end: new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString(),
		location: null,
		allDay: false,
		recurrenceId: null,
		...extra
	};
}

describe('buildCalendarDigest — capping', () => {
	it('renders a small set verbatim with the not-instruction header', () => {
		const events = [
			occ('2026-07-31T09:00:00Z', 'Standup', { location: 'Zoom' }),
			occ('2026-08-01T12:00:00Z', 'Lunch with Sam')
		];
		const digest = buildCalendarDigest(events, NOW_MS, TZ, 7);
		expect(digest.totalEvents).toBe(2);
		expect(digest.renderedEvents).toBe(2);
		expect(digest.truncated).toBe(false);
		expect(digest.text).toContain('Owner schedule for the next 7 days');
		// The not-instruction framing is the load-bearing part — a shared event
		// title is third-party text entering the prompt exactly like a message body.
		expect(digest.text).toContain('not instructions to you');
		expect(digest.text).toContain('Standup (Zoom)');
		expect(digest.text).toContain('Lunch with Sam');
	});

	it('caps the number of events at MAX_DIGEST_EVENTS', () => {
		const many: CalendarEventOccurrence[] = Array.from({ length: MAX_DIGEST_EVENTS + 5 }, (_, i) =>
			occ(new Date(NOW_MS + i * 60 * 60 * 1000).toISOString(), `Event ${i}`)
		);
		const digest = buildCalendarDigest(many, NOW_MS, TZ, 7);
		expect(digest.totalEvents).toBe(MAX_DIGEST_EVENTS + 5);
		expect(digest.renderedEvents).toBe(MAX_DIGEST_EVENTS);
		// Truncation flag tracks the *character* cap, not the event cap — a
		// block under the char cap with events dropped by the ceiling is not
		// "truncated" in the prompt-budget sense.
		expect(digest.truncated).toBe(false);
		// Header is two lines (title + not-instruction), so total line count is
		// MAX_DIGEST_EVENTS + 2.
		expect(digest.text.split('\n').length).toBe(MAX_DIGEST_EVENTS + 2);
	});

	it('caps the character block at MAX_DIGEST_CHARS and drops a trailing partial line', () => {
		// One giant summary that blows the char cap on its own line.
		const huge = 'X'.repeat(MAX_DIGEST_CHARS * 2);
		const events = [occ('2026-07-31T09:00:00Z', huge)];
		const digest = buildCalendarDigest(events, NOW_MS, TZ, 7);
		expect(digest.truncated).toBe(true);
		expect(digest.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
		// The header survives even when the single event line is dropped.
		expect(digest.text).toContain('Owner schedule for the next 7 days');
		// No partial line ending mid-title.
		expect(digest.text.endsWith('X')).toBe(false);
	});

	it('sorts events chronologically regardless of input order', () => {
		const events = [
			occ('2026-08-02T09:00:00Z', 'Later'),
			occ('2026-07-31T09:00:00Z', 'First')
		];
		const digest = buildCalendarDigest(events, NOW_MS, TZ, 7);
		const firstIdx = digest.text.indexOf('First');
		const laterIdx = digest.text.indexOf('Later');
		expect(firstIdx).toBeGreaterThan(-1);
		expect(laterIdx).toBeGreaterThan(firstIdx);
	});

	it('renders all-day events without a time range', () => {
		const events = [
			occ('2026-08-04T00:00:00Z', 'Public holiday', {
				allDay: true,
				end: new Date('2026-08-05T00:00:00Z').toISOString()
			})
		];
		const digest = buildCalendarDigest(events, NOW_MS, TZ, 7);
		expect(digest.text).toContain('(all day)');
		expect(digest.text).toContain('Public holiday');
	});
});

describe('buildCalendarDigest — recurrence', () => {
	// The plan's binding correction: a digest that omits a recurring weekly
	// meeting makes the drafter confidently wrong about availability. Assert
	// recurrence expansion reaches the digest, not just single events.
	const RECURRING_PAYLOAD = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-standup@test
DTSTART;TZID=America/New_York:20260706T100000
DTEND;TZID=America/New_York:20260706T103000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Weekly Standup
LOCATION:Zoom
END:VEVENT
END:VCALENDAR`;

	it('includes every expanded occurrence of a weekly RRULE in the 7-day window', () => {
		const rangeStart = new Date('2026-07-06T00:00:00Z');
		const rangeEnd = new Date('2026-07-13T00:00:00Z');
		const expanded = expandIcalInRange([RECURRING_PAYLOAD], rangeStart, rangeEnd);
		const standups = expanded.filter((e) => e.uid === 'weekly-standup@test');
		// One Monday in the window.
		expect(standups.length).toBe(1);
		expect(standups[0]?.summary).toBe('Weekly Standup');

		const digest = buildCalendarDigest(expanded, rangeStart.getTime(), 'America/New_York', 7);
		expect(digest.renderedEvents).toBe(1);
		expect(digest.text).toContain('Weekly Standup');
		// America/New_York in July is EDT (UTC-4): 10:00 local → 14:00Z. The
		// digest renders in the America/New_York zone, so the line shows 10:00.
		expect(digest.text).toContain('10:00–10:30');
	});
});

describe('fetchCalendarDigest — outage path', () => {
	it('returns null when listEvents throws (drafting degrades, never goes down)', async () => {
		const throwingClient = {
			async testConnection() {
				return { status: 500, ok: false };
			},
			async listEvents() {
				throw new Error('Google outage: 503');
			}
		};
		const digest = await fetchCalendarDigest(throwingClient, NOW_MS, TZ, 7);
		expect(digest).toBeNull();
	});

	it('returns null on a non-2xx status (expired token / revoked grant)', async () => {
		const unauthorizedClient = {
			async testConnection() {
				return { status: 401, ok: false };
			},
			async listEvents() {
				return { events: [], status: 401 };
			}
		};
		const digest = await fetchCalendarDigest(unauthorizedClient, NOW_MS, TZ, 7);
		expect(digest).toBeNull();
	});

	it('returns a digest when the client succeeds', async () => {
		const okClient = {
			async testConnection() {
				return { status: 207, ok: true };
			},
			async listEvents() {
				return {
					events: [occ('2026-07-31T09:00:00Z', 'Standup')],
					status: 207
				};
			}
		};
		const digest = await fetchCalendarDigest(okClient, NOW_MS, TZ, 7);
		expect(digest).not.toBeNull();
		expect(digest!.text).toContain('Standup');
	});
});