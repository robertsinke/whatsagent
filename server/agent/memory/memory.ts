import type { Chat } from '../../store/chats.js';

export type VoiceObservation = {
	chatJid: string;
	text: string;
	language?: string;
};

export type EditDelta = {
	chatJid: string;
	draft: string;
	final: string | null;
	skipped: boolean;
};

/** Persistent voice and preference memory. U10 supplies the Hindsight implementation. */
export interface Memory {
	retainVoiceObservation(observation: VoiceObservation): Promise<void>;
	retainEditDelta(delta: EditDelta): Promise<void>;
	recallStyleFor(chat: Chat): Promise<string | null>;
	reflect(): Promise<void>;
}
