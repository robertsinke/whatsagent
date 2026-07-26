import type { AppDatabase } from '../store/db.js';
import { listChats, type Chat } from '../store/chats.js';
import { getLastMessage, type Message } from '../store/messages.js';

export type NeedsReplyCandidate = {
	chat: Chat;
	lastInbound: Message;
};

export type NeedsReplyOptions = {
	/**
	 * Development-only escape hatch for exercising the drafting pipeline with
	 * one exact owner-authored message. Default classification remains inbound-only.
	 */
	devDraftFromMeMessageId?: string;
};

/**
 * Deterministic classification floor. Groups are rejected before any other
 * state is inspected so they can never enter the agent pipeline.
 */
export function classifyNeedsReply(
	db: AppDatabase,
	chat: Chat,
	options: NeedsReplyOptions = {}
): NeedsReplyCandidate | undefined {
	if (chat.kind !== '1:1') return undefined;
	if (chat.muted || chat.archived) return undefined;
	if (chat.agent_state === 'skipped' || chat.agent_state === 'quiet') return undefined;

	const lastMessage = getLastMessage(db, chat.jid);
	if (
		!lastMessage ||
		(lastMessage.from_me && lastMessage.id !== options.devDraftFromMeMessageId)
	) {
		return undefined;
	}
	return { chat, lastInbound: lastMessage };
}

/** Backlog order is oldest unanswered inbound first. */
export function listNeedsReplyCandidates(
	db: AppDatabase,
	options: NeedsReplyOptions = {}
): NeedsReplyCandidate[] {
	return listChats(db)
		.map((chat) => classifyNeedsReply(db, chat, options))
		.filter((candidate): candidate is NeedsReplyCandidate => candidate !== undefined)
		.sort(
			(a, b) =>
				Number(b.lastInbound.id === options.devDraftFromMeMessageId) -
					Number(a.lastInbound.id === options.devDraftFromMeMessageId) ||
				a.lastInbound.ts - b.lastInbound.ts ||
				a.lastInbound.id.localeCompare(b.lastInbound.id)
		);
}
