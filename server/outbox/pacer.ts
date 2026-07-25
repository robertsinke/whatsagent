import { markChatRead } from '../store/chats.js';
import type { AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import {
	cancelClaimedOutbox,
	deferPendingDrafts,
	getNextPendingOutbox,
	getOutbox,
	markOutboxPending,
	markOutboxSending,
	markOutboxSent,
	recoverSendingOutbox,
	type OutboxRow
} from '../store/outbox.js';
import { getLastInboundMessage } from '../store/messages.js';
import type { WhatsAppSendTransport } from '../channels/whatsapp/send.js';

export type OutboxPacerOptions = {
	db: AppDatabase;
	transport: WhatsAppSendTransport;
	dryRun?: boolean;
	minDraftDelayMs?: number;
	maxDraftDelayMs?: number;
	manualPresenceMs?: number;
	retryDelayMs?: number;
	now?: () => number;
	random?: () => number;
	sleep?: (ms: number) => Promise<void>;
	onUpdated?: (row: OutboxRow) => void;
	onError?: (error: Error, row: OutboxRow) => void;
	/** Runtime starts paused until terminal history sync; tests default unpaused. */
	draftsPaused?: boolean;
};

const DEFAULT_MIN_DRAFT_DELAY_MS = 30_000;
const DEFAULT_MAX_DRAFT_DELAY_MS = 90_000;

export class OutboxPacer {
	readonly #options: OutboxPacerOptions;
	readonly #now: () => number;
	readonly #random: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #minDraftDelayMs: number;
	readonly #maxDraftDelayMs: number;
	readonly #manualPresenceMs: number;
	readonly #retryDelayMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;
	#stopped = true;
	#draftsPaused: boolean;

	constructor(options: OutboxPacerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? Math.random;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#minDraftDelayMs = options.minDraftDelayMs ?? DEFAULT_MIN_DRAFT_DELAY_MS;
		this.#maxDraftDelayMs = options.maxDraftDelayMs ?? DEFAULT_MAX_DRAFT_DELAY_MS;
		this.#manualPresenceMs = options.manualPresenceMs ?? 2_500;
		this.#retryDelayMs = options.retryDelayMs ?? 5_000;
		this.#draftsPaused = options.draftsPaused ?? false;
	}

	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		recoverSendingOutbox(this.#options.db);
		this.wake();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Call after enqueue, cancellation, or reconnection. */
	wake(): void {
		if (this.#stopped) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		void this.#drain();
	}

	setDraftsPaused(paused: boolean): void {
		this.#draftsPaused = paused;
		this.wake();
	}

	jitterMs(): number {
		const span = Math.max(0, this.#maxDraftDelayMs - this.#minDraftDelayMs);
		return this.#minDraftDelayMs + Math.floor(this.#random() * (span + 1));
	}

	async #drain(): Promise<void> {
		if (this.#running || this.#stopped) return;
		const row = getNextPendingOutbox(this.#options.db, {
			includeDrafts: !this.#draftsPaused
		});
		if (!row) return;

		const delay = row.send_after - this.#now();
		if (delay > 0) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				void this.#drain();
			}, delay);
			return;
		}

		if (!markOutboxSending(this.#options.db, row.id)) {
			this.wake();
			return;
		}
		this.#running = true;
		this.#emit(row.id);

		try {
			try {
				const latestInbound =
					row.source === 'draft'
						? getLastInboundMessage(this.#options.db, row.chat_jid)
						: undefined;
				if (
					latestInbound &&
					row.basis_msg_id &&
					latestInbound.id !== row.basis_msg_id
				) {
					cancelClaimedOutbox(this.#options.db, row.id);
					this.#emit(row.id);
					return;
				}
				if (this.#options.dryRun) {
					console.info(`[outbox:dry-run] ${row.chat_jid}: ${row.text}`);
				} else {
					await this.#options.transport.setPresence(row.chat_jid, 'composing');
					await this.#sleep(this.#manualPresenceMs);
					const latestBeforeSend =
						row.source === 'draft'
							? getLastInboundMessage(this.#options.db, row.chat_jid)
							: undefined;
					if (
						latestBeforeSend &&
						row.basis_msg_id &&
						latestBeforeSend.id !== row.basis_msg_id
					) {
						cancelClaimedOutbox(this.#options.db, row.id);
						this.#emit(row.id);
						await this.#options.transport
							.setPresence(row.chat_jid, 'unavailable')
							.catch(() => undefined);
						return;
					}
					await this.#options.transport.sendText(row.chat_jid, row.text, row.message_id!);
				}
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				markOutboxPending(this.#options.db, row.id, this.#now() + this.#retryDelayMs);
				this.#emit(row.id);
				this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
				return;
			}

			const sentAt = this.#now();
			// Commit immediately after sendText succeeds. Presence/read receipts are
			// best-effort and must never turn a successful network send into a retry.
			const spacing = row.source === 'manual' ? this.jitterMs() : this.#minDraftDelayMs;
			const commitSend = this.#options.db.transaction(() => {
				markOutboxSent(this.#options.db, row.id, sentAt);
				deferPendingDrafts(this.#options.db, sentAt + spacing);
			});
			try {
				commitSend();
			} catch (error) {
				// The network accepted the stable message ID but SQLite could not commit
				// sent + next-spacing atomically. Halt rather than release later rows.
				this.#stopped = true;
				const normalized = error instanceof Error ? error : new Error(String(error));
				this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
				return;
			}
			try {
				markChatRead(this.#options.db, row.chat_jid);
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
			}
			if (row.source === 'draft') {
				try {
					this.#markDraftSent(row);
				} catch (error) {
					const normalized = error instanceof Error ? error : new Error(String(error));
					this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
				}
			}
			this.#emit(row.id);
			if (!this.#options.dryRun) {
				const followups: Promise<unknown>[] = [
					this.#options.transport.setPresence(row.chat_jid, 'unavailable')
				];
				if (row.basis_msg_id) {
					followups.push(this.#options.transport.markRead(row.chat_jid, row.basis_msg_id));
				}
				await Promise.allSettled(followups);
			}
		} finally {
			this.#running = false;
			this.wake();
		}
	}

	#markDraftSent(row: OutboxRow): void {
		const draft = getDraft(this.#options.db, row.chat_jid);
		if (!draft || draft.status !== 'approved' || draft.basis_msg_id !== row.basis_msg_id) return;
		upsertDraft(this.#options.db, { ...draft, status: 'sent' });
	}

	#emit(id: number): void {
		const row = getOutbox(this.#options.db, id);
		if (row) this.#options.onUpdated?.(row);
	}
}
