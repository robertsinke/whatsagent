import type { AppDatabase } from '../store/db.js';
import type { Chat } from '../store/chats.js';
import { resolveContact } from '../store/contacts.js';
import { getDraft } from '../store/drafts.js';
import { getLastMessage } from '../store/messages.js';
import { isMediaType } from './message-view.js';
import { usableName } from '../../shared/names.js';

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
	// Identity-aware, matching `message-view.ts`. An exact-jid lookup here meant
	// the same person could render as a name in a message bubble and as a bare
	// number in the chat list, whenever the chat's jid was one side of a
	// LID/phone pair and the contact row was keyed by the other.
	const contact = resolveContact(db, chat.jid);
	// Resolution order: usable chat.name → usable contact.name → usable
	// contact.push_name → null (the client renders the number). A WhatsApp
	// privacy mask ("+31 [dots] 85") is phone-shaped and so is treated as
	// not-a-name here — otherwise it would outrank a perfectly good contact
	// name that is already in the database.
	const resolvedName =
		usableName(chat.name) ?? usableName(contact?.name) ?? usableName(contact?.push_name) ?? null;

	let preview: string | null = null;
	if (last) {
		preview = last.text?.trim() || (isMediaType(last.type) ? MEDIA_PREVIEW[last.type] ?? 'Attachment' : null);
	}

	return {
		...chat,
		name: resolvedName,
		display_jid: contact?.phone_jid ?? chat.jid,
		needs_reply: needsReply(chat),
		preview,
		preview_from_me: last?.from_me ?? false,
		draft_status: draft?.status ?? null
	};
}

/**
 * Deterministic needs-reply (mirrors U8 classifier floor, without draft pipeline):
 * 1:1 + last message inbound + not muted/archived + not skipped since last inbound.
 */
export function chatNeedsReply(db: AppDatabase, chat: Chat): boolean {
	if (chat.kind !== '1:1') return false;
	if (chat.muted || chat.archived) return false;
	// 'skipped' = owner opted out; 'quiet' = agent returned no_reply_needed (D3).
	if (chat.agent_state === 'skipped' || chat.agent_state === 'quiet') return false;
	const last = getLastMessage(db, chat.jid);
	if (!last || last.from_me) return false;
	return true;
}

/**
 * The only form any event emitter should use. A store `Chat` is NOT what the SPA
 * consumes: it has no `display_jid`, `preview`, `needs_reply` or `draft_status`,
 * and the client's `displayName()` dereferences `display_jid` unconditionally.
 * Pushing a raw row over the WebSocket replaced a complete chat in client state
 * with a partial one, and the resulting TypeError was thrown *inside Svelte's
 * effect flush* — which stops the whole reactive graph, so the chat list froze
 * (stale `selected` rows) and reopening a chat did nothing.
 */
export function chatViewFor(db: AppDatabase, chat: Chat): ChatView {
	return toChatView(db, chat, (c) => chatNeedsReply(db, c));
}
