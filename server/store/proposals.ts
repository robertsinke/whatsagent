import type { AppDatabase } from './db.js';

/**
 * PANEL-S6: a proposal is the agent's half of any outbound action.
 *
 * A proposal is inert. It is not a queued send, it is not an outbox row, and
 * the pacer never looks at this table. The only transition out of `pending` is
 * an owner click through a frontend-only action (`confirm-proposal`). Outbound
 * WhatsApp effects therefore stay behind owner confirmation structurally —
 * adding a new outbound capability means adding a `propose-*` tool that writes
 * here, not opening the underlying action to tools.
 */
export type ProposalStatus = 'pending' | 'confirmed' | 'rejected';

/** Discriminator for what the owner is being asked to put on the wire. */
export type ProposalKind = 'send' | 'reaction';

export type SendProposal = {
	id: number;
	chat_jid: string;
	kind: ProposalKind;
	text: string;
	reaction_emoji: string | null;
	reaction_target_msg_id: string | null;
	status: ProposalStatus;
	created_at: number;
	basis_msg_id: string | null;
	decided_at: number | null;
	outbox_id: number | null;
};

/** @deprecated Prefer {@link SendProposal} — same row; name kept for call-site familiarity. */
export type Proposal = SendProposal;

export type InsertSendProposalInput = {
	kind?: 'send';
	chatJid: string;
	text: string;
	basisMsgId: string | null;
	now: number;
};

export type InsertReactionProposalInput = {
	kind: 'reaction';
	chatJid: string;
	emoji: string;
	targetMsgId: string;
	now: number;
};

export type InsertProposalInput = InsertSendProposalInput | InsertReactionProposalInput;

export function insertProposal(db: AppDatabase, input: InsertProposalInput): number {
	if (input.kind === 'reaction') {
		const result = db
			.prepare(
				`INSERT INTO send_proposals
				   (chat_jid, text, status, created_at, basis_msg_id, kind,
				    reaction_emoji, reaction_target_msg_id)
				 VALUES
				   (@chat_jid, '', 'pending', @created_at, @basis_msg_id, 'reaction',
				    @reaction_emoji, @reaction_target_msg_id)`
			)
			.run({
				chat_jid: input.chatJid,
				created_at: input.now,
				// Approval binding for a reaction is the target message itself —
				// the proposal cannot silently retarget after the owner reviews it.
				basis_msg_id: input.targetMsgId,
				reaction_emoji: input.emoji,
				reaction_target_msg_id: input.targetMsgId
			});
		return Number(result.lastInsertRowid);
	}

	const result = db
		.prepare(
			`INSERT INTO send_proposals
			   (chat_jid, text, status, created_at, basis_msg_id, kind,
			    reaction_emoji, reaction_target_msg_id)
			 VALUES
			   (@chat_jid, @text, 'pending', @created_at, @basis_msg_id, 'send',
			    NULL, NULL)`
		)
		.run({
			chat_jid: input.chatJid,
			text: input.text,
			created_at: input.now,
			basis_msg_id: input.basisMsgId
		});
	return Number(result.lastInsertRowid);
}

export function getProposal(db: AppDatabase, id: number): SendProposal | undefined {
	return db.prepare('SELECT * FROM send_proposals WHERE id = ?').get(id) as
		| SendProposal
		| undefined;
}

export function listPendingProposals(db: AppDatabase, chatJid: string): SendProposal[] {
	return db
		.prepare(
			`SELECT * FROM send_proposals WHERE chat_jid = ? AND status = 'pending'
			 ORDER BY id ASC`
		)
		.all(chatJid) as SendProposal[];
}

/** Every pending proposal, newest first — the panel's inbox after a restart. */
export function listPendingProposalsAll(db: AppDatabase, limit = 50): SendProposal[] {
	const capped = Math.min(Math.max(limit, 1), 200);
	return db
		.prepare(`SELECT * FROM send_proposals WHERE status = 'pending' ORDER BY id DESC LIMIT ?`)
		.all(capped) as SendProposal[];
}

/**
 * Link a confirmed proposal to the row the owner's click queued. Separate from
 * {@link decideProposal} because the claim has to happen *before* the outbox
 * insert (it is what wins the race), and the outbox id only exists after.
 */
export function attachProposalOutbox(db: AppDatabase, id: number, outboxId: number): void {
	db.prepare('UPDATE send_proposals SET outbox_id = ? WHERE id = ?').run(outboxId, id);
}

/**
 * Conditional on `status = 'pending'`, so two clicks (or a click racing a
 * reject) cannot both decide one proposal. Returns false when the row was
 * already decided — the caller turns that into a 409.
 */
export function decideProposal(
	db: AppDatabase,
	input: {
		id: number;
		status: Exclude<ProposalStatus, 'pending'>;
		now: number;
		outboxId?: number | null;
	}
): boolean {
	return (
		db
			.prepare(
				`UPDATE send_proposals SET status = @status, decided_at = @decided_at, outbox_id = @outbox_id
				 WHERE id = @id AND status = 'pending'`
			)
			.run({
				id: input.id,
				status: input.status,
				decided_at: input.now,
				outbox_id: input.outboxId ?? null
			}).changes > 0
	);
}
