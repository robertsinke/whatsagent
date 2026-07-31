/**
 * FRONTEND ONLY — an agent confirming its own calendar proposal defeats the
 * confirm gate. This is the ONLY writer to Google Calendar (CalDAV PUT).
 *
 * Odysseus trap (binding): a non-2xx PUT must surface to the owner as a
 * failure. Never keep a local copy and report success. Credentials come only
 * from {@link getCalendarCredentials} — never a second decrypt of the
 * ciphertext setting.
 *
 * Double-confirm: claim the pending row before PUT so two clicks cannot fire
 * two writes. If PUT fails, the claim is reverted so the owner can retry.
 */
import {
	approvalHashMatches,
	calendarProposalApprovalText,
	CONFLICT_TEXT_CHANGED,
	hashApprovalText
} from '../../shared/approval-hash.js';
import type { CalDavFetch } from '../calendar/caldav.js';
import { createCalendarClient } from '../calendar/client.js';
import { getCalendarCredentials } from '../calendar/credentials.js';
import {
	attachCalendarEventId,
	claimCalendarProposal,
	getCalendarProposal,
	revertCalendarProposalClaim
} from '../store/calendar-proposals.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';
import { randomUUID } from 'node:crypto';

export type ConfirmCalendarEventInput = {
	id: number;
	base_hash: string;
};

export type ConfirmCalendarEventDeps = {
	fetch?: CalDavFetch;
	encryptionKey?: Buffer;
	/** Injectable uid for tests — production uses randomUUID(). */
	newUid?: () => string;
};

export function createConfirmCalendarEventAction(
	defaults: ConfirmCalendarEventDeps = {}
): ActionDefinition<ConfirmCalendarEventInput> {
	return {
		name: 'confirm-calendar-event',
		callers: ['frontend'],
		jsonSchema: {
			type: 'object',
			properties: {
				id: { type: 'number' },
				base_hash: { type: 'string' }
			},
			required: ['id', 'base_hash'],
			additionalProperties: false
		},
		parse(raw: unknown) {
			const body = raw as { id?: unknown; base_hash?: unknown } | undefined;
			const id = typeof body?.id === 'number' ? body.id : Number.NaN;
			if (!Number.isInteger(id) || id <= 0) {
				return parseError(400, 'Expected { id }');
			}
			if (typeof body?.base_hash !== 'string' || !body.base_hash) {
				return parseError(400, 'Expected { base_hash }');
			}
			return { ok: true, input: { id, base_hash: body.base_hash } };
		},
		async run(input, ctx) {
			const { db, events } = ctx.deps;
			const proposal = getCalendarProposal(db, input.id);
			if (!proposal) {
				return actionError(404, 'Calendar proposal not found', { id: input.id });
			}
			if (proposal.status !== 'pending') {
				return actionError(409, 'Calendar proposal is no longer pending', {
					id: proposal.id,
					status: proposal.status
				});
			}

			const approvalPayload = calendarProposalApprovalText(proposal);
			if (!approvalHashMatches(approvalPayload, input.base_hash)) {
				return actionError(409, 'Calendar proposal does not match what you reviewed', {
					conflict: CONFLICT_TEXT_CHANGED,
					id: proposal.id,
					current_text: approvalPayload,
					current_hash: hashApprovalText(approvalPayload)
				});
			}

			const encryptionKey = ctx.deps.calendarEncryptionKey ?? defaults.encryptionKey;
			const creds = getCalendarCredentials(db, encryptionKey);
			if (!creds) {
				return actionError(
					400,
					'Google Calendar is not connected. Add an App Password in Settings.'
				);
			}

			const now = Date.now();
			// Claim first so a double click cannot reach PUT twice.
			if (!claimCalendarProposal(db, { id: proposal.id, now })) {
				return actionError(409, 'Calendar proposal is no longer pending', {
					id: proposal.id
				});
			}

			const uid =
				(defaults.newUid ?? (() => randomUUID()))() + '@whatsagent.local';
			const fetchImpl = ctx.deps.calendarFetch ?? defaults.fetch;
			const client = createCalendarClient(
				creds,
				fetchImpl ? { fetch: fetchImpl } : {}
			);

			try {
				const result = await client.createEvent({
					uid,
					summary: proposal.summary,
					start: proposal.start,
					end: proposal.end,
					location: proposal.location
				});
				if (!result.ok) {
					// Odysseus fix: surface the failure; do not leave a "confirmed"
					// local row that pretends Google accepted it.
					revertCalendarProposalClaim(db, proposal.id);
					const pending = getCalendarProposal(db, proposal.id)!;
					events.emit({ type: 'calendar-proposal-updated', proposal: pending });
					return actionError(
						502,
						`Google Calendar rejected the event (HTTP ${result.status})`,
						{ status: result.status, proposal: pending }
					);
				}

				attachCalendarEventId(db, proposal.id, result.uid);
				const confirmed = getCalendarProposal(db, proposal.id)!;
				events.emit({ type: 'calendar-proposal-updated', proposal: confirmed });
				// CAL-5 — so the panel agent's next turn does not still say "pending".
				ctx.deps.panelSession?.recordCalendarOutcome?.({
					status: 'confirmed',
					summary: confirmed.summary,
					start: confirmed.start
				});
				return actionJson(200, { proposal: confirmed, google_event_id: result.uid });
			} catch (err) {
				revertCalendarProposalClaim(db, proposal.id);
				const pending = getCalendarProposal(db, proposal.id)!;
				events.emit({ type: 'calendar-proposal-updated', proposal: pending });
				return actionError(
					502,
					err instanceof Error ? err.message : 'CalDAV PUT failed',
					{ proposal: pending }
				);
			}
		}
	};
}

export const confirmCalendarEventAction = createConfirmCalendarEventAction();
