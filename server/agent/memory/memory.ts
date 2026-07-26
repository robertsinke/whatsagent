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
 * `drain` is optional and only the Hindsight implementation provides it: the short-interval
 * memory tick that is the single periodic schedule for the voice mirror. It both retries
 * the retain queue (so one cold-start timeout does not park the whole voice bootstrap
 * until the next reflect) and mirrors voice documents whose `last_refreshed_at` advanced
 * since the last mirror (so a freshly consolidated document reaches disk in minutes, not
 * hours). The runtime wires a ~1-minute timer around it; `reflect()` is the 6-hourly
 * full-mirror heartbeat and the create/ensure path.
 */
export interface Memory {
	retainVoiceObservation(observation: VoiceObservation): Promise<void>;
	retainEditDelta(delta: EditDelta): Promise<void>;
	recallStyleFor(chat: Chat): Promise<string | null>;
	reflect(): Promise<void>;
	/** The short-interval memory tick: retry the retain queue and mirror changed documents. No-op when offline. */
	drain?(): Promise<void>;
}
