import type { ChannelConnectionState } from '../channels/channel.js';
import type { Chat } from '../store/chats.js';
import type { Draft } from '../store/drafts.js';
import type { Message } from '../store/messages.js';
import type { OutboxRow } from '../store/outbox.js';

/**
 * Realtime events fan out to connected WebSocket clients.
 * Store writers (API handlers, U4 ingest, agent, outbox pacer) emit via EventBus.
 */
export type ConnectionState = ChannelConnectionState | 'unpaired';

export type ServerEvent =
	| { type: 'message-new'; message: Message }
	| { type: 'chat-updated'; chat: Chat }
	| { type: 'draft-updated'; draft: Draft }
	| { type: 'draft-removed'; chat_jid: string }
	| { type: 'outbox-updated'; outbox: OutboxRow }
	| { type: 'connection'; state: ConnectionState }
	| { type: 'pairing-needed'; qr: string }
	| { type: 'sync-progress'; phase: string; done: number; total: number };

export type ServerEventListener = (event: ServerEvent) => void;

export class EventBus {
	readonly #listeners = new Set<ServerEventListener>();

	subscribe(listener: ServerEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: ServerEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// Never let a bad subscriber break other clients.
			}
		}
	}
}

/**
 * Hooks for U4 ingestion (and peers) to publish store writes without importing
 * HTTP/WS internals. Define the contract here; U4 wires it from its side.
 */
export type IngestEventHooks = {
	onMessageIngested(message: Message): void;
	onChatUpdated(chat: Chat): void;
	onSyncProgress(phase: string, done: number, total: number): void;
};

export function createIngestEventHooks(bus: EventBus): IngestEventHooks {
	return {
		onMessageIngested(message) {
			bus.emit({ type: 'message-new', message });
		},
		onChatUpdated(chat) {
			bus.emit({ type: 'chat-updated', chat });
		},
		onSyncProgress(phase, done, total) {
			bus.emit({ type: 'sync-progress', phase, done, total });
		}
	};
}

export type ConnectionStatus = {
	state: ConnectionState;
	qr: string | null;
};

export function createConnectionStatus(): {
	get: () => ConnectionStatus;
	setState: (state: ConnectionState) => void;
	setQr: (qr: string | null) => void;
} {
	let status: ConnectionStatus = { state: 'unpaired', qr: null };
	return {
		get: () => status,
		setState(state) {
			status = { ...status, state, qr: state === 'connected' ? null : status.qr };
		},
		setQr(qr) {
			status = { ...status, qr, state: qr ? 'unpaired' : status.state };
		}
	};
}
