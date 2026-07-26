import type { AppDatabase } from '../store/db.js';
import type { Chat } from '../store/chats.js';
import { getContact } from '../store/contacts.js';
import { getDraft } from '../store/drafts.js';
import { getLastMessage } from '../store/messages.js';
import { isMediaType } from './message-view.js';

/**
 * Chat row as the SPA consumes it. Everything the list needs is decided here:
 * `needs_reply` and `draft_status` in particular are server verdicts, never
 * something the client re-derives (the classifier floor and the stale-draft
 * rule both live server-side).
 */
export type ChatView = Chat & {
	/** Phone JID when a LID-backed chat has a known phone alias; never used for routing. */
	display_jid: string;
	needs_reply: boolean;
	/** One-line preview of the last message (typed placeholder for media). */
	preview: string | null;
	preview_from_me: boolean;
	draft_status: string | null;
};

const MEDIA_PREVIEW: Record<string, string> = {
	image: 'Photo',
	video: 'Video',
	audio: 'Voice message',
	document: 'Document',
	sticker: 'Sticker'
};

export function toChatView(
	db: AppDatabase,
	chat: Chat,
	needsReply: (chat: Chat) => boolean
): ChatView {
	const last = getLastMessage(db, chat.jid);
	const draft = getDraft(db, chat.jid);
	const contact = getContact(db, chat.jid);
	const contactName = contact?.name?.trim() || contact?.push_name?.trim() || null;

	let preview: string | null = null;
	if (last) {
		preview = last.text?.trim() || (isMediaType(last.type) ? MEDIA_PREVIEW[last.type] ?? 'Attachment' : null);
	}

	return {
		...chat,
		name: chat.name?.trim() || contactName,
		display_jid: contact?.phone_jid ?? chat.jid,
		needs_reply: needsReply(chat),
		preview,
		preview_from_me: last?.from_me ?? false,
		draft_status: draft?.status ?? null
	};
}
