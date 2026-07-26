/**
 * Stream decoration for `ConversationStream.svelte`, kept out of the component
 * so the run/divider/marker rules are testable without a DOM (the same split
 * `scroll-anchor.ts` uses).
 *
 * Everything here is a pure function of the already-loaded messages. It never
 * looks anything up and never defers work to a later paint: a bubble that grows
 * after the prepend anchor is restored would break U1's scroll preservation.
 */

import type { Message } from '$lib/client/types.js';
import { senderLabel, type UnreadBoundary } from '$lib/client/view.js';

export type StreamRow = {
	message: Message;
	/** First message of a calendar day — the component renders the date chip. */
	newDay: boolean;
	/** The single latched unread separator renders above this message. */
	unreadMarker: boolean;
	/**
	 * Start of an inbound sender run in a group. Consecutive messages from the
	 * same participant stay unlabelled so the stream doesn't get noisy.
	 */
	showSender: boolean;
	/** Attribution text; null whenever `showSender` is false. */
	senderLabel: string | null;
};

export type StreamRowOptions = {
	/** Only group chats attribute senders; 1:1 needs no label to be unambiguous. */
	isGroup: boolean;
	unreadBoundary?: UnreadBoundary | null;
};

function sameSender(a: Message, b: Message): boolean {
	if (a.from_me !== b.from_me) return false;
	return (a.sender?.jid ?? null) === (b.sender?.jid ?? null);
}

function isNewDay(previous: Message | undefined, current: Message): boolean {
	if (!previous) return true;
	return new Date(previous.ts).toDateString() !== new Date(current.ts).toDateString();
}

export function buildStreamRows(messages: Message[], options: StreamRowOptions): StreamRow[] {
	const boundaryId = options.unreadBoundary?.firstUnreadId ?? null;
	return messages.map((message, index) => {
		const previous = messages[index - 1];
		const newDay = isNewDay(previous, message);
		const unreadMarker = boundaryId !== null && message.id === boundaryId;
		// Owner messages already read as "mine" from their side of the stream, so a
		// name there would be redundant. A divider or the unread marker breaks the
		// visual run, so attribution restarts under it.
		const showSender =
			options.isGroup &&
			!message.from_me &&
			(!previous || newDay || unreadMarker || !sameSender(previous, message));
		return {
			message,
			newDay,
			unreadMarker,
			showSender,
			senderLabel: showSender ? senderLabel(message.sender) : null
		};
	});
}
