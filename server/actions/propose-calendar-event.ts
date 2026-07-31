import { getChat } from '../store/chats.js';
import {
	getCalendarProposal,
	insertCalendarProposal,
	listPendingCalendarProposals
} from '../store/calendar-proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type ProposeCalendarEventInput = {
	summary: string;
	start: string;
	end: string;
	location: string | null;
	chatJid: string | null;
};

/**
 * How many un-acted-on calendar proposals may exist at once. A proposal is a
 * claim on the owner's attention, and an agent steered by attacker-controlled
 * message text would otherwise be free to manufacture an unbounded queue.
 * Global (not per-chat) because chat_jid is optional provenance — "add lunch
 * tomorrow" has no chat.
 */
export const MAX_PENDING_CALENDAR_PROPOSALS = 3;

/**
 * TOOL ONLY — the agent's only route toward creating a calendar event.
 *
 * Inserts an inert row and returns. It does not call CalDAV PUT, and there is
 * deliberately no branch that could: the Google write is performed by
 * `confirm-calendar-event`, which is frontend-only. R9 is unchanged — nothing
 * here reaches the outbox or WhatsApp sendMessage.
 *
 * The response says `pending_confirmation` rather than anything resembling
 * success on purpose. An agent that believes it booked something will tell the
 * person it is talking to; the status name teaches it that the create has not
 * happened yet and may never happen.
 */
export const proposeCalendarEventAction: ActionDefinition<ProposeCalendarEventInput> = {
	name: 'propose-calendar-event',
	callers: ['tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			summary: { type: 'string', description: 'Event title.' },
			start: { type: 'string', description: 'ISO-8601 start (inclusive).' },
			end: { type: 'string', description: 'ISO-8601 end (exclusive or exclusive-of-instant).' },
			location: { type: 'string', description: 'Optional location.' },
			chatJid: {
				type: 'string',
				description: 'Optional chat provenance — not required to propose an event.'
			}
		},
		required: ['summary', 'start', 'end'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as {
			summary?: unknown;
			start?: unknown;
			end?: unknown;
			location?: unknown;
			chatJid?: unknown;
		};
		const summary = typeof body?.summary === 'string' ? body.summary.trim() : '';
		if (!summary) return parseError(400, 'Expected { summary }');
		if (typeof body?.start !== 'string' || !Number.isFinite(Date.parse(body.start))) {
			return parseError(400, 'start must be an ISO-8601 datetime');
		}
		if (typeof body?.end !== 'string' || !Number.isFinite(Date.parse(body.end))) {
			return parseError(400, 'end must be an ISO-8601 datetime');
		}
		const start = new Date(body.start).toISOString();
		const end = new Date(body.end).toISOString();
		if (!(Date.parse(start) < Date.parse(end))) {
			return parseError(400, 'start must be before end');
		}
		const location =
			typeof body?.location === 'string' && body.location.trim()
				? body.location.trim()
				: null;
		const chatJid =
			typeof body?.chatJid === 'string' && body.chatJid ? body.chatJid : null;
		return { ok: true, input: { summary, start, end, location, chatJid } };
	},
	run(input, ctx) {
		const { db, events } = ctx.deps;
		if (input.chatJid) {
			const chat = getChat(db, input.chatJid);
			if (!chat) {
				return actionError(404, 'Chat not found', { jid: input.chatJid });
			}
		}
		const pending = listPendingCalendarProposals(db);
		if (pending.length >= MAX_PENDING_CALENDAR_PROPOSALS) {
			return actionError(409, 'Too many calendar proposals are already awaiting the owner', {
				pending: pending.length,
				max: MAX_PENDING_CALENDAR_PROPOSALS
			});
		}
		const now = Date.now();
		const id = insertCalendarProposal(db, {
			summary: input.summary,
			start: input.start,
			end: input.end,
			location: input.location,
			chatJid: input.chatJid,
			now
		});
		const proposal = getCalendarProposal(db, id)!;
		events.emit({ type: 'calendar-proposal-updated', proposal });
		return actionJson(202, {
			status: 'pending_confirmation',
			proposal_id: proposal.id,
			proposal
		});
	}
};
