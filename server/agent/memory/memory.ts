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

/**
 * Persistent voice and preference memory. U10 supplies the Hindsight implementation.
 *
 * `drain` is optional and only the Hindsight implementation provides it: a short-interval
 * retry of the retain queue that is independent of the (6-hourly) `reflect` heartbeat. The
 * runtime wires a ~1-minute timer around it so one cold-start timeout does not park the
 * whole voice bootstrap until the next reflect.
 */
export interface Memory {
	retainVoiceObservation(observation: VoiceObservation): Promise<void>;
	retainEditDelta(delta: EditDelta): Promise<void>;
	recallStyleFor(chat: Chat): Promise<string | null>;
	reflect(): Promise<void>;
	/** Retry any locally-queued retains once the offline window has elapsed. No-op when offline. */
	drain?(): Promise<void>;
}
