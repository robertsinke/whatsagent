import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { listEffectiveSettings } from '../store/settings.js';
import {
	CALENDAR_PASSWORD_ENC_SETTING,
	clearCalendarCredentials,
	getCalendarCredentials,
	saveCalendarCredentials
} from './credentials.js';
import { parseMultistatusCalendarData, propfind } from './caldav.js';
import { expandIcalInRange } from './ical.js';
import { createCalendarClient } from './client.js';
import { actionRegistry, dispatch } from '../actions/index.js';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function openTempDb(): AppDatabase {
	dataDir = mkdtempSync(join(tmpdir(), 'whatsagent-cal-'));
	db = openDatabase({ dataDir });
	return db;
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) rmSync(dataDir, { recursive: true, force: true });
	dataDir = undefined;
});

const KEY = Buffer.alloc(32, 9);

describe('calendar credentials', () => {
	it('round-trips through encrypt-on-write and decrypt-on-read only', () => {
		const database = openTempDb();
		saveCalendarCredentials(
			database,
			{
				serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
				email: 'owner@gmail.com',
				password: 'abcd efgh ijkl mnop'
			},
			KEY
		);

		const enc = database
			.prepare('SELECT value FROM settings WHERE key = ?')
			.get(CALENDAR_PASSWORD_ENC_SETTING) as { value: string };
		expect(enc.value).not.toContain('abcd');
		expect(enc.value).not.toContain('ijkl');

		const loaded = getCalendarCredentials(database, KEY);
		expect(loaded).toEqual({
			serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
			email: 'owner@gmail.com',
			password: 'abcd efgh ijkl mnop'
		});
	});

	it('never returns the ciphertext via listEffectiveSettings', () => {
		const database = openTempDb();
		saveCalendarCredentials(
			database,
			{
				serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
				email: 'owner@gmail.com',
				password: 'secret-app-password'
			},
			KEY
		);
		const view = listEffectiveSettings(database);
		expect(view.calendar_configured).toBe('true');
		expect(view.calendar_email).toBe('owner@gmail.com');
		expect(view[CALENDAR_PASSWORD_ENC_SETTING]).toBeUndefined();
		expect(JSON.stringify(view)).not.toContain('secret-app-password');
	});

	it('fails loudly when the encryption key cannot decrypt', () => {
		const database = openTempDb();
		saveCalendarCredentials(
			database,
			{
				serverUrl: 'https://www.google.com/calendar/dav/a@b.com/events',
				email: 'a@b.com',
				password: 'pw'
			},
			KEY
		);
		expect(() => getCalendarCredentials(database, Buffer.alloc(32, 1))).toThrow();
	});

	it('clear removes every calendar row', () => {
		const database = openTempDb();
		saveCalendarCredentials(
			database,
			{
				serverUrl: 'https://www.google.com/calendar/dav/a@b.com/events',
				email: 'a@b.com',
				password: 'pw'
			},
			KEY
		);
		clearCalendarCredentials(database);
		expect(getCalendarCredentials(database, KEY)).toBeNull();
		expect(listEffectiveSettings(database).calendar_configured).toBe('false');
	});
});

const PROPFIND_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/calendar/dav/owner@gmail.com/events</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>owner@gmail.com</D:displayname>
        <D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const REPORT_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendar/dav/owner@gmail.com/events/standup.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"abc"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
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
UID:standup@test
DTSTART;TZID=America/New_York:20260706T100000
DTEND;TZID=America/New_York:20260706T103000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Standup
LOCATION:Zoom
END:VEVENT
END:VCALENDAR</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/calendar/dav/owner@gmail.com/events/lunch.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"def"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:lunch@test
DTSTART:20260708T120000Z
DTEND:20260708T130000Z
SUMMARY:Lunch with Sam
END:VEVENT
END:VCALENDAR</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

describe('CalDAV XML parsing', () => {
	it('extracts calendar-data entries from a REPORT multistatus', () => {
		const entries = parseMultistatusCalendarData(REPORT_FIXTURE);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.etag).toBe('"abc"');
		expect(entries[0]?.calendarData).toContain('UID:standup@test');
		expect(entries[1]?.calendarData).toContain('Lunch with Sam');
	});
});

describe('ical RRULE expansion and TZID', () => {
	it('expands a weekly RRULE and keeps DTSTART TZID conversion', () => {
		const payloads = parseMultistatusCalendarData(REPORT_FIXTURE).map((e) => e.calendarData);
		// Week of Mon 2026-07-06 .. Mon 2026-07-13
		const events = expandIcalInRange(
			payloads,
			new Date('2026-07-06T00:00:00Z'),
			new Date('2026-07-13T00:00:00Z')
		);
		const standup = events.filter((e) => e.uid === 'standup@test');
		expect(standup.length).toBeGreaterThanOrEqual(1);
		expect(standup[0]?.summary).toBe('Standup');
		expect(standup[0]?.location).toBe('Zoom');
		// America/New_York in July is EDT (UTC-4): 10:00 local → 14:00Z
		expect(standup[0]?.start).toBe('2026-07-06T14:00:00.000Z');
		expect(standup[0]?.end).toBe('2026-07-06T14:30:00.000Z');

		const lunch = events.find((e) => e.uid === 'lunch@test');
		expect(lunch?.summary).toBe('Lunch with Sam');
		expect(lunch?.start).toBe('2026-07-08T12:00:00.000Z');
	});
});

describe('connect-calendar save path uses the decrypting accessor', () => {
	it('PROPFINDs with the decrypted password after save, not the ciphertext', async () => {
		const database = openTempDb();
		const seenAuth: string[] = [];
		const fakeFetch: typeof fetch = async (_url, init) => {
			const auth = new Headers(init?.headers).get('Authorization') ?? '';
			seenAuth.push(auth);
			return new Response(PROPFIND_FIXTURE, { status: 207, statusText: 'Multi-Status' });
		};

		const deps: RoutesDeps = {
			db: database,
			events: new EventBus(),
			getConnectionStatus: () => ({ state: 'connected', qr: null }),
			port: 0,
			calendarFetch: fakeFetch,
			calendarEncryptionKey: KEY
		};

		const result = await dispatch(
			actionRegistry,
			'connect-calendar',
			{
				serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
				email: 'owner@gmail.com',
				password: 'plain-app-password',
				mode: 'save'
			},
			{ caller: 'frontend', deps }
		);

		expect(result.kind).toBe('json');
		if (result.kind !== 'json') return;
		expect(result.body).toMatchObject({ saved: true, ok: true, status: 207 });

		expect(seenAuth).toHaveLength(1);
		const decoded = Buffer.from(seenAuth[0]!.replace(/^Basic\s+/i, ''), 'base64').toString(
			'utf8'
		);
		expect(decoded).toBe('owner@gmail.com:plain-app-password');

		// Ciphertext on disk is not what was sent.
		const enc = database
			.prepare('SELECT value FROM settings WHERE key = ?')
			.get(CALENDAR_PASSWORD_ENC_SETTING) as { value: string };
		expect(decoded).not.toContain(enc.value);
		expect(enc.value).not.toBe('plain-app-password');
	});

	it('refuses the apidata host before fetching', async () => {
		await expect(
			propfind(
				{
					serverUrl: 'https://apidata.googleusercontent.com/caldav/v2/x/events',
					email: 'x@y.com',
					password: 'pw'
				},
				{
					fetch: async () => {
						throw new Error('must not fetch');
					}
				}
			)
		).rejects.toThrow(/apidata\.googleusercontent\.com/);
	});
});

describe('list-calendar-events', () => {
	it('is advertised to tool callers and lists expanded events', async () => {
		const database = openTempDb();
		saveCalendarCredentials(
			database,
			{
				serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
				email: 'owner@gmail.com',
				password: 'pw'
			},
			KEY
		);

		const fakeFetch: typeof fetch = async (_url, init) => {
			expect(init?.method).toBe('REPORT');
			return new Response(REPORT_FIXTURE, { status: 207 });
		};

		const deps: RoutesDeps = {
			db: database,
			events: new EventBus(),
			getConnectionStatus: () => ({ state: 'connected', qr: null }),
			port: 0,
			calendarFetch: fakeFetch,
			calendarEncryptionKey: KEY,
			calendarNow: () => new Date('2026-07-06T00:00:00Z')
		};

		const toolNames = [...actionRegistry.values()]
			.filter((a) => a.callers.includes('tool'))
			.map((a) => a.name);
		expect(toolNames).toContain('list-calendar-events');
		expect(toolNames).not.toContain('connect-calendar');

		const result = await dispatch(
			actionRegistry,
			'list-calendar-events',
			{ start: '2026-07-06T00:00:00Z', end: '2026-07-13T00:00:00Z' },
			{ caller: 'tool', deps }
		);
		expect(result.kind).toBe('json');
		if (result.kind !== 'json') return;
		const body = result.body as { items: Array<{ summary: string }>; total: number };
		expect(body.total).toBeGreaterThanOrEqual(2);
		expect(body.items.map((i) => i.summary)).toEqual(
			expect.arrayContaining(['Standup', 'Lunch with Sam'])
		);
	});

	it('returns 400 when calendar is not connected', async () => {
		const database = openTempDb();
		const deps: RoutesDeps = {
			db: database,
			events: new EventBus(),
			getConnectionStatus: () => ({ state: 'connected', qr: null }),
			port: 0,
			calendarEncryptionKey: KEY
		};
		const result = await dispatch(actionRegistry, 'list-calendar-events', {}, {
			caller: 'tool',
			deps
		});
		expect(result).toMatchObject({ kind: 'error', status: 400 });
	});
});

describe('calendar client interface', () => {
	it('lists through createCalendarClient without exposing transport', async () => {
		const client = createCalendarClient(
			{
				serverUrl: 'https://www.google.com/calendar/dav/owner@gmail.com/events',
				email: 'owner@gmail.com',
				password: 'pw'
			},
			{
				fetch: async () => new Response(REPORT_FIXTURE, { status: 207 })
			}
		);
		const listed = await client.listEvents({
			start: new Date('2026-07-06T00:00:00Z'),
			end: new Date('2026-07-13T00:00:00Z')
		});
		expect(listed.status).toBe(207);
		expect(listed.events.some((e) => e.summary === 'Standup')).toBe(true);
	});
});
