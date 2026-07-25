export type ChannelConnectionState = 'connecting' | 'connected' | 'disconnected';

export type ChannelEvent =
	| { type: 'connection'; state: ChannelConnectionState }
	| { type: 'pairing-needed'; qr: string }
	/**
	 * Terminal: the account was unlinked on the phone and re-pairing is required.
	 * A sibling of the transport states, deliberately NOT a fourth
	 * `ChannelConnectionState` — the transport enum stays three-valued (D5).
	 */
	| { type: 'logged-out' }
	/** Emitted only after a live message transaction commits to SQLite. */
	| { type: 'message-committed'; message: Message }
	| {
			type: 'sync-progress';
			/** Baileys' percentage — retained at transport level, never rendered (D5). */
			progress: number | null;
			isLatest: boolean;
			/** Chats in this batch (the only honest sync unit; there is no total). */
			chats: number;
			/** Messages in this batch. */
			messages: number;
	  }
	| { type: 'error'; error: Error; fatal: boolean };

export type ChannelEventListener = (event: ChannelEvent) => void;

export interface Channel {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: ChannelEventListener): () => void;
	/**
	 * Forget stored credentials so the next `start()` pairs from scratch.
	 * Required after `logged-out`: the stored session is dead, but a channel
	 * holding it will not offer a fresh QR.
	 */
	resetAuth?(): Promise<void>;
}
import type { Message } from '../store/messages.js';
