import type { ChannelConnectionState } from '../channels/channel.js';
import type { Chat } from '../store/chats.js';
import type { Draft } from '../store/drafts.js';
import type { AppDatabase } from '../store/db.js';
import type { Message } from '../store/messages.js';
import type { OutboxRow } from '../store/outbox.js';
import type { ChatView } from './chat-view.js';
import { toMessageView, type MessageView } from './message-view.js';
import type { SessionView } from './session.js';

/**
 * Realtime events fan out to connected WebSocket clients.
 * Store writers (API handlers, U4 ingest, agent, outbox pacer) emit via EventBus.
 */
export type ConnectionState = ChannelConnectionState | 'unpaired';

export type ServerEvent =
	/** Carries the client-facing view (no `raw` envelope) — see message-view.ts. */
	| { type: 'message-new'; message: MessageView }
	| { type: 'message-updated'; message: MessageView }
	| { type: 'chat-updated'; chat: Chat | ChatView }
	| { type: 'draft-updated'; draft: Draft }
	| { type: 'draft-removed'; chat_jid: string }
	| { type: 'outbox-updated'; outbox: OutboxRow }
	/**
	 * W4-U8: outbox send-mode flipped at runtime. `live: true` means the pacer
	 * transmits over the WhatsApp transport; `live: false` (the safe default)
	 * means rows are marked sent without ever reaching a recipient. Pushed to
	 * every WS client so the topbar indicator and the settings toggle stay in
	 * sync without a refetch.
	 */
	| { type: 'send-mode'; live: boolean; dry_run: boolean }
	| { type: 'connection'; state: ConnectionState }
	| { type: 'pairing-needed'; qr: string }
	/** D5 — the derived view state the shell renders (supersedes `connection` for UI). */
	| { type: 'session'; session: SessionView }
	/**
	 * D5 — indeterminate by construction: counts only, never a total or a
	 * percentage. Baileys does not tell us how much history is coming.
	 */
	| {
			type: 'sync-progress';
			phase: string;
			chatsSynced: number;
			messagesSynced: number;
			complete: boolean;
	  };

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
export type SyncProgressPayload = {
	phase: string;
	chatsSynced: number;
	messagesSynced: number;
	complete: boolean;
};

export type IngestEventHooks = {
	onMessageIngested(message: Message): void;
	onMessageUpdated(message: Message): void;
	onChatUpdated(chat: Chat): void;
	onSyncProgress(progress: SyncProgressPayload): void;
};

export function createIngestEventHooks(bus: EventBus, db: AppDatabase): IngestEventHooks {
	return {
		onMessageIngested(message) {
			bus.emit({ type: 'message-new', message: toMessageView(db, message) });
		},
		onMessageUpdated(message) {
			bus.emit({ type: 'message-updated', message: toMessageView(db, message) });
		},
		onChatUpdated(chat) {
			bus.emit({ type: 'chat-updated', chat });
		},
		onSyncProgress(progress) {
			bus.emit({ type: 'sync-progress', ...progress });
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
