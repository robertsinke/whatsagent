export const CONVERSATION_CTX = Symbol('conversation');

export type ConversationContext = {
	get isAtBottom(): boolean;
	setIsAtBottom: (value: boolean) => void;
	scrollToBottom: () => void;
	setViewport: (el: HTMLElement | null) => void;
};
