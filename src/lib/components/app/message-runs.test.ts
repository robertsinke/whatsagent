import { describe, expect, it } from 'vitest';
import { buildStreamRows } from './message-runs.js';
import type { IdentityView, Message } from '$lib/client/types.js';

const GROUP = 'crew@g.us';
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 6, 20, 12, 0, 0);

function who(jid: string, name?: string): IdentityView {
	return { jid, display_jid: jid, name: name ?? jid };
}

function msg(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		chat_jid: GROUP,
		channel: 'whatsapp',
		from_me: false,
		sender: who('maya@s.whatsapp.net', 'Maya'),
		ts: BASE,
		type: 'text',
		text: id,
		media: null,
		quote: null,
		reactions: [],
		...overrides
	};
}

describe('group sender runs', () => {
	it('labels the first message of each run and stays quiet inside a run', () => {
		const sam = who('sam@s.whatsapp.net', 'Sam');
		const rows = buildStreamRows(
			[
				msg('a', { ts: BASE }),
				msg('b', { ts: BASE + 1000 }),
				msg('c', { ts: BASE + 2000, sender: sam }),
				msg('d', { ts: BASE + 3000, sender: sam }),
				msg('e', { ts: BASE + 4000 })
			],
			{ isGroup: true }
		);
		expect(rows.map((r) => r.senderLabel)).toEqual(['Maya', null, 'Sam', null, 'Maya']);
	});

	it('never labels owner messages and restarts the run after one', () => {
		const rows = buildStreamRows(
			[
				msg('a', { ts: BASE }),
				msg('b', { ts: BASE + 1000, from_me: true, sender: null }),
				msg('c', { ts: BASE + 2000 })
			],
			{ isGroup: true }
		);
		expect(rows.map((r) => r.senderLabel)).toEqual(['Maya', null, 'Maya']);
		expect(rows[1]!.showSender).toBe(false);
	});

	it('leaves 1:1 conversations unlabelled', () => {
		const rows = buildStreamRows([msg('a'), msg('b', { ts: BASE + 1000 })], { isGroup: false });
		expect(rows.every((r) => !r.showSender && r.senderLabel === null)).toBe(true);
	});

	it('falls back to the JID local part rather than claiming a contact name', () => {
		const unknown = who('4477000111@s.whatsapp.net');
		const rows = buildStreamRows([msg('a', { sender: unknown })], { isGroup: true });
		expect(rows[0]!.senderLabel).toBe('+4477000111');
	});

	it('restarts a run across a day divider and across the unread marker', () => {
		const messages = [
			msg('a', { ts: BASE }),
			msg('b', { ts: BASE + DAY }),
			msg('c', { ts: BASE + DAY + 1000 })
		];
		const rows = buildStreamRows(messages, {
			isGroup: true,
			unreadBoundary: { firstUnreadId: 'c', count: 1, exact: true }
		});
		expect(rows.map((r) => r.newDay)).toEqual([true, true, false]);
		expect(rows.map((r) => r.unreadMarker)).toEqual([false, false, true]);
		// Same participant throughout, yet each break re-attributes.
		expect(rows.map((r) => r.senderLabel)).toEqual(['Maya', 'Maya', 'Maya']);
	});

	it('renders at most one unread marker and none without a boundary', () => {
		const messages = [msg('a'), msg('b', { ts: BASE + 1000 })];
		expect(buildStreamRows(messages, { isGroup: true }).some((r) => r.unreadMarker)).toBe(false);
		const marked = buildStreamRows(messages, {
			isGroup: true,
			unreadBoundary: { firstUnreadId: 'b', count: 1, exact: true }
		});
		expect(marked.filter((r) => r.unreadMarker)).toHaveLength(1);
	});
});
