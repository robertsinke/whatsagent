export const CONVERSATION_CTX = Symbol('conversation');

export type ConversationContext = {
	get isAtBottom(): boolean;
	/** True while the reader is actively scrolling — drives contextual scrollbar chrome. */
	get isScrolling(): boolean;
	setIsAtBottom: (value: boolean) => void;
	scrollToBottom: (behavior?: ScrollBehavior) => void;
	setViewport: (el: HTMLElement | null) => void;
	/** Report a scroll event (contextual scrollbar idle timer). */
	noteScroll: () => void;
	/**
	 * Snapshot viewport geometry before prepending older content. Call the
	 * returned function after the DOM has reconciled to restore the anchor.
	 */
	captureAnchor: () => () => void;
};
