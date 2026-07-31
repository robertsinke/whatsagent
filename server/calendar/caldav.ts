/**
 * CalDAV over plain fetch — PROPFIND and calendar-query REPORT.
 *
 * Google's legacy endpoint accepts Basic Auth with an App Password:
 *   https://www.google.com/calendar/dav/EMAIL/events
 * Do NOT use apidata.googleusercontent.com — that host is OAuth-only and 401s
 * on Basic Auth. Verified on the owner's account 2026-07-31.
 *
 * No googleapis, no caldav npm client. Same posture as server/providers/ollama.ts.
 */
import type { CalendarCredentials } from './credentials.js';

export type CalDavFetch = typeof fetch;

export type PropfindResult = {
	status: number;
	ok: boolean;
	body: string;
};

export type CalendarDataEntry = {
	href: string;
	etag: string | null;
	calendarData: string;
};

const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

function basicAuthHeader(email: string, password: string): string {
	return `Basic ${Buffer.from(`${email}:${password}`, 'utf8').toString('base64')}`;
}

/** Default Google CalDAV event collection for an address. Legacy host only. */
export function defaultGoogleCalDavEventsUrl(email: string): string {
	const trimmed = email.trim();
	return `https://www.google.com/calendar/dav/${trimmed}/events`;
}

export function defaultGoogleCalDavPrincipalUrl(email: string): string {
	const trimmed = email.trim();
	return `https://www.google.com/calendar/dav/${trimmed}/user`;
}

function assertLegacyHost(serverUrl: string): void {
	let host: string;
	try {
		host = new URL(serverUrl).hostname;
	} catch {
		throw new Error(`Invalid CalDAV server URL: ${serverUrl}`);
	}
	if (host === 'apidata.googleusercontent.com') {
		throw new Error(
			'apidata.googleusercontent.com is OAuth-only and rejects Basic Auth. ' +
				'Use https://www.google.com/calendar/dav/EMAIL/events instead.'
		);
	}
}

function formatCalDavTime(date: Date): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	const d = String(date.getUTCDate()).padStart(2, '0');
	const hh = String(date.getUTCHours()).padStart(2, '0');
	const mm = String(date.getUTCMinutes()).padStart(2, '0');
	const ss = String(date.getUTCSeconds()).padStart(2, '0');
	return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`;

function calendarQueryBody(rangeStart: Date, rangeEnd: Date): string {
	const start = formatCalDavTime(rangeStart);
	const end = formatCalDavTime(rangeEnd);
	return `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="${CALDAV_NS}">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

/**
 * PROPFIND Depth:0 against the events (or principal) URL. Returns the raw
 * status so the Settings Test button can report exactly what Google said.
 */
export async function propfind(
	creds: CalendarCredentials,
	options: { fetch?: CalDavFetch; url?: string } = {}
): Promise<PropfindResult> {
	const url = options.url ?? creds.serverUrl;
	assertLegacyHost(url);
	const response = await (options.fetch ?? fetch)(url, {
		method: 'PROPFIND',
		headers: {
			Authorization: basicAuthHeader(creds.email, creds.password),
			Depth: '0',
			'Content-Type': 'application/xml; charset=utf-8'
		},
		body: PROPFIND_BODY
	});
	const body = await response.text();
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		body
	};
}

/**
 * calendar-query REPORT for VEVENTs overlapping [rangeStart, rangeEnd).
 */
export async function reportCalendarQuery(
	creds: CalendarCredentials,
	rangeStart: Date,
	rangeEnd: Date,
	options: { fetch?: CalDavFetch } = {}
): Promise<{ status: number; entries: CalendarDataEntry[]; body: string }> {
	assertLegacyHost(creds.serverUrl);
	const response = await (options.fetch ?? fetch)(creds.serverUrl, {
		method: 'REPORT',
		headers: {
			Authorization: basicAuthHeader(creds.email, creds.password),
			Depth: '1',
			'Content-Type': 'application/xml; charset=utf-8'
		},
		body: calendarQueryBody(rangeStart, rangeEnd)
	});
	const body = await response.text();
	if (!(response.status >= 200 && response.status < 300)) {
		return { status: response.status, entries: [], body };
	}
	return { status: response.status, entries: parseMultistatusCalendarData(body), body };
}

/**
 * Parse a CalDAV multistatus XML body for calendar-data payloads.
 * Deliberately tolerant of namespace prefixes (D:, C:, raw local names).
 */
export function parseMultistatusCalendarData(xml: string): CalendarDataEntry[] {
	const entries: CalendarDataEntry[] = [];
	// Split on response elements — Google returns one per event href.
	const responseRe = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
	let match: RegExpExecArray | null;
	while ((match = responseRe.exec(xml)) !== null) {
		const block = match[1] ?? '';
		const href = textContent(block, 'href');
		const etag = textContent(block, 'getetag');
		const calendarData = textContent(block, 'calendar-data');
		if (!calendarData?.trim()) continue;
		entries.push({
			href: href?.trim() ?? '',
			etag: etag?.trim() || null,
			calendarData: decodeXmlEntities(calendarData.trim())
		});
	}
	return entries;
}

function textContent(xml: string, localName: string): string | null {
	const re = new RegExp(
		`<(?:[\\w-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${localName}>`,
		'i'
	);
	const m = re.exec(xml);
	return m ? (m[1] ?? null) : null;
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}
