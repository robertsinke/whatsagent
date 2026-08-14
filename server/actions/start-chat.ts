import { normalizePhone, phoneToJid } from '../../shared/phone.js';
import { chatViewFor } from '../api/chat-view.js';
import { getChat, upsertChat, type Chat } from '../store/chats.js';
import { resolveContact } from '../store/contacts.js';
import { canonicalChatJid } from '../store/identity.js';
import type { AppDatabase } from '../store/db.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type StartChatInput = { phone: string };

/**
 * How many zero-message 1:1 chats may exist before the agent is refused another
 * one. Same reasoning as `MAX_PENDING_PROPOSALS_PER_CHAT` in `propose-send.ts`:
 * an agent steered by attacker-controlled message text must not be able to
 * manufacture an unbounded claim on the owner's attention. It is worse here,
 * because a chat row has no reject affordance — the owner has to delete it.
 *
 * The cap applies to `tool` only. The owner typing a number is not the threat.
 */
export const MAX_AGENT_EMPTY_CHATS = 5;

/** Chats with no message rows at all, regardless of who created them. */
function countEmptyDirectChats(db: AppDatabase): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM chats
			 WHERE kind = '1:1'
			   AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_jid = chats.jid)`
		)
		.get() as { n: number };
	return row.n;
}

/**
 * Every chat jid this person might already be known under.
 *
 * `canonicalChatJid` alone is NOT enough here: it short-circuits on anything
 * that is not `@lid`, and the input is always `<number>@s.whatsapp.net`, so on
 * this path it is a no-op. The dedupe that matters is the contacts one —
 * `resolveContact` ORs `jid`/`lid_jid`/`phone_jid`, so a person already stored
 * under an opaque `@lid` jid with a recorded phone mapping resolves from the
 * phone number the owner typed. Inserting the phone jid regardless is exactly
 * the double-conversation bug `server/store/identity.ts` exists to fix.
 */
function findExistingChat(db: AppDatabase, phoneJid: string): Chat | undefined {
	const contact = resolveContact(db, phoneJid);
	const candidates = [
		canonicalChatJid(db, phoneJid),
		phoneJid,
		contact?.jid,
		contact?.phone_jid,
		contact?.lid_jid
	];
	for (const jid of candidates) {
		if (!jid) continue;
		const chat = getChat(db, jid);
		if (chat) return chat;
	}
	return undefined;
}

/**
 * NEWCHAT-1 — open a 1:1 chat with a number that has never messaged the owner.
 *
 * Both callers. Creating a chat row is a purely local write: it puts nothing on
 * the wire, so it is not an outbound effect and the propose-and-confirm pattern
 * does not apply. The agent's flow becomes `start-chat` → `propose-send` →
 * owner confirms; the approval model is unchanged with one step in front of it.
 *
 * R9 is untouched by design: this file writes one `chats` row and returns. It
 * does not import the outbox, does not call `wakeOutbox`, and has no branch
 * that could. `start-chat.test.ts` asserts `listOutbox(db)` is empty after it.
 *
 * The number is validated against WhatsApp up front rather than letting the
 * send fail, because the outbox has no terminal failure state — the pacer
 * re-queues every send error after 5s, forever, with no attempts cap. A typo
 * would therefore become a permanent retry loop the owner never sees. That
 * defect is tracked separately (OUTBOX-1); this action's job is to not feed it.
 */
export const startChatAction: ActionDefinition<StartChatInput> = {
	name: 'start-chat',
	description:
		'Open a 1:1 chat with a phone number in full international form (e.g. +31612345678); a country code is required and none is assumed. Creates only a local chat row — nothing is sent. Needs the WhatsAgent app open to verify the number.',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: { phone: { type: 'string' } },
		required: ['phone'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { phone?: unknown } | undefined;
		if (typeof body?.phone !== 'string' || !body.phone.trim()) {
			return parseError(400, 'Expected { phone }');
		}
		return { ok: true, input: { phone: body.phone } };
	},
	async run(input, ctx) {
		const { db, events } = ctx.deps;
		const parsed = normalizePhone(input.phone);
		if (!parsed.ok) {
			return actionError(400, 'Not a usable phone number', {
				reason: parsed.reason,
				hint: 'Include the country code — no country is assumed.'
			});
		}
		const phoneJid = phoneToJid(parsed.e164);

		// Before anything else: one human, one chat row (W4-U13).
		const existing = findExistingChat(db, phoneJid);
		if (existing) {
			return actionJson(200, { created: false, chat: chatViewFor(db, existing) });
		}

		if (
			ctx.caller === 'tool' &&
			countEmptyDirectChats(db) >= MAX_AGENT_EMPTY_CHATS
		) {
			return actionError(409, 'Too many chats with no messages are already open', {
				max: MAX_AGENT_EMPTY_CHATS
			});
		}

		if (!ctx.deps.checkRegistered) {
			// Same dep-absent shape as `load-media` / `deepen-history`: validation
			// needs a live socket, and an unvalidated row is what the missing
			// outbox failure path makes expensive.
			return actionError(503, 'Starting a chat requires the WhatsAgent app to be open');
		}
		let registration: { registered: boolean; jid: string | null };
		try {
			registration = await ctx.deps.checkRegistered(phoneJid);
		} catch {
			return actionError(502, 'Could not check the number with WhatsApp', {
				phone: parsed.e164
			});
		}
		if (!registration.registered) {
			return actionError(404, 'That number is not on WhatsApp', { phone: parsed.e164 });
		}

		// WhatsApp may report a different jid than the number implies (LID
		// addressing). Trust its answer, then re-run the dedupe against it.
		const targetJid = registration.jid ?? phoneJid;
		const alreadyKnown = findExistingChat(db, targetJid);
		if (alreadyKnown) {
			return actionJson(200, { created: false, chat: chatViewFor(db, alreadyKnown) });
		}

		const contact = resolveContact(db, targetJid);
		upsertChat(db, {
			jid: targetJid,
			kind: '1:1',
			name: contact?.name ?? contact?.push_name ?? null,
			// NOT null: `listChats` orders `last_msg_at IS NULL` first, so a null
			// here sorts the new chat to the BOTTOM and the owner never finds it.
			last_msg_at: Date.now()
		});
		const chat = getChat(db, targetJid)!;
		const view = chatViewFor(db, chat);
		events.emit({ type: 'chat-updated', chat: view });
		return actionJson(201, { created: true, chat: view });
	}
};
