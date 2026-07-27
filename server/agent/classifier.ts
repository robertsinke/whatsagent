import type { AppDatabase } from '../store/db.js';
import { listChats, type Chat } from '../store/chats.js';
import { getLastMessage, type Message } from '../store/messages.js';

export type NeedsReplyCandidate = {
	chat: Chat;
	lastInbound: Message;
};

/**
 * Deterministic classification floor. Groups are rejected before any other
 * state is inspected so they can never enter the agent pipeline.
 */
export function classifyNeedsReply(
	db: AppDatabase,
	chat: Chat
): NeedsReplyCandidate | undefined {
	if (chat.kind !== '1:1') return undefined;
	if (chat.muted || chat.archived) return undefined;
	if (chat.agent_state === 'skipped' || chat.agent_state === 'quiet') return undefined;

	const lastMessage = getLastMessage(db, chat.jid);
	if (!lastMessage || lastMessage.from_me) return undefined;
	return { chat, lastInbound: lastMessage };
}

/** Backlog order is oldest unanswered inbound first. */
export function listNeedsReplyCandidates(db: AppDatabase): NeedsReplyCandidate[] {
	return listChats(db)
		.map((chat) => classifyNeedsReply(db, chat))
		.filter((candidate): candidate is NeedsReplyCandidate => candidate !== undefined)
		.sort(
			(a, b) =>
				a.lastInbound.ts - b.lastInbound.ts || a.lastInbound.id.localeCompare(b.lastInbound.id)
		);
}
