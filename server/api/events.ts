import type { AgentPart, ClientCommand } from '../../shared/agent-events.js';
import type { ChannelConnectionState } from '../channels/channel.js';
import type { Chat } from '../store/chats.js';
import type { Draft } from '../store/drafts.js';
import type { AppDatabase } from '../store/db.js';
import type { Message } from '../store/messages.js';
import type { OutboxRow } from '../store/outbox.js';
import type { CancellationNotice } from '../store/cancellation-notices.js';
import type { SendProposal } from '../store/proposals.js';
import { chatViewFor, type ChatView } from './chat-view.js';
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
	/**
	 * Always the client-facing view, never a store `Chat` — the SPA requires
	 * `display_jid`/`preview`/`needs_reply`/`draft_status` and breaks hard
	 * without them. `chatViewFor` is the only correct way to build this.
	 */
	| { type: 'chat-updated'; chat: ChatView }
	/**
	 * W4-U13: `jid` was a duplicate identity of `merged_into` and no longer
	 * exists. Always preceded by a `chat-updated` for the survivor, so a client
	 * that drops `jid` on receipt never ends up holding neither row.
	 */
	| { type: 'chat-removed'; jid: string; merged_into: string }
	| { type: 'draft-updated'; draft: Draft }
	/**
	 * PL-U3 — a send the agent proposed, or the owner's decision on one. The
	 * panel renders pending proposals live from this; it is deliberately the
	 * same channel every other store write uses rather than a parallel one, so
	 * a proposal cannot arrive by a route the rest of the UI does not watch.
	 */
	| { type: 'proposal-updated'; proposal: SendProposal }
	/**
	 * PL-U5 — the agent cancelled a message the owner had approved, or the
	 * owner dismissed that notice. Carried on the same channel as every other
	 * store write so a toast that already faded is not the only signal.
	 */
	| { type: 'cancellation-notice'; notice: CancellationNotice }
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
	  }
	/**
	 * PL-A1 — streaming agent turn parts (opencode-shaped). Correlation lives
	 * inside `part` (sessionId / messageId / partId); `delta` is the optional
	 * text chunk for live append. One-way server→client, same as every other
	 * variant — no request/response layer on the socket.
	 */
	/**
	 * PL-U7 — the panel turn's own lifecycle, separate from its parts.
	 *
	 * Needed because "is a turn still running?" is not derivable from the parts.
	 * A turn can end without a `step-finish` (a harness that exits mid-step, a
	 * cancel, a spawn failure), and a turn's *first* part can arrive seconds after
	 * the owner pressed Enter. Inferring the state from step markers therefore
	 * either leaves the composer locked forever or unlocks it early; both are
	 * worse than one explicit event. `reason` is what the panel shows when a turn
	 * ended without finishing normally.
	 */
	| {
			type: 'agent-turn';
			phase: 'started' | 'finished';
			sessionId: string;
			messageId: string;
			harness: string;
			reason?: string;
	  }
	| { type: 'agent-part-updated'; part: AgentPart; delta?: string }
	/**
	 * PANEL-S4/S7 — focus a chat in the SPA without marking it read. Emitted by
	 * the `open-chat` registry action (both the agent tool surface and the
	 * owner's chat-list click, which dispatches it via REST); the client
	 * reducer routes this into `openChat(jid)` (load-only). `mark-read` is a
	 * separate, explicit action — opening a chat by *looking at it* must not
	 * silently clear the unread badge.
	 */
	| { type: 'focus-chat'; jid: string; name: string | null }
	/**
	 * PL-A1 — pure client-state commands (no REST route exists). Closed typed
	 * set; the client reducer dispatches into AppState. Still server→client
	 * only — an agent (or the dev emitter) pushes these through the EventBus.
	 * PANEL-S7 removed `open-chat` from this set — it duplicated the
	 * `open-chat` registry action and was emitted only from the dev harness.
	 */
	| { type: 'client-command'; command: ClientCommand };

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
			bus.emit({ type: 'chat-updated', chat: chatViewFor(db, chat) });
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
