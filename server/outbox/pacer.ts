import { markChatRead } from '../store/chats.js';
import type { AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import {
	cancelClaimedOutbox,
	deferPendingDrafts,
	getNextPendingOutbox,
	getOutbox,
	markOutboxFailed,
	markOutboxRetry,
	markOutboxSending,
	markOutboxSent,
	recoverSendingOutbox,
	type OutboxRow
} from '../store/outbox.js';
import { classifySendFailure, failureMessage, retryDelayMs } from './failure.js';
import { BufferJSON, type WAMessage, type WAMessageKey } from 'baileys';
import { getLastInboundMessage, getMessage } from '../store/messages.js';
import { getOutboxPacingSettings } from '../store/settings.js';
import type { WhatsAppSendTransport } from '../channels/whatsapp/send.js';

export type OutboxPacerOptions = {
	db: AppDatabase;
	transport: WhatsAppSendTransport;
	dryRun?: boolean;
	minDraftDelayMs?: number;
	maxDraftDelayMs?: number;
	manualPresenceMs?: number;
	/** Base retry delay; the first retry waits exactly this, then it doubles. */
	retryDelayMs?: number;
	/** Ceiling on the exponential retry backoff. */
	maxRetryDelayMs?: number;
	/** OUTBOX-1: attempts before a row goes terminal (`failed`). */
	maxAttempts?: number;
	now?: () => number;
	random?: () => number;
	sleep?: (ms: number) => Promise<void>;
	onUpdated?: (row: OutboxRow) => void;
	onError?: (error: Error, row: OutboxRow) => void;
	/** Runtime starts paused until terminal history sync; tests default unpaused. */
	draftsPaused?: boolean;
};

export class QuotedReplyTargetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QuotedReplyTargetError';
	}
}

function resolveQuotedTarget(db: AppDatabase, row: OutboxRow): WAMessage | undefined {
	if (!row.reply_to_msg_id) return undefined;
	const target = getMessage(db, row.reply_to_msg_id);
	if (!target || target.chat_jid !== row.chat_jid || !target.raw) {
		throw new QuotedReplyTargetError('Quoted reply target is unavailable');
	}

	try {
		const parsed = JSON.parse(target.raw, BufferJSON.reviver) as WAMessage;
		if (!parsed?.key || parsed.key.id !== target.id || !parsed.message) {
			throw new Error('Invalid stored message envelope');
		}
		return parsed;
	} catch (error) {
		if (error instanceof QuotedReplyTargetError) throw error;
		throw new QuotedReplyTargetError('Quoted reply target data is corrupt');
	}
}

/**
 * D2 (Wave 3 U2): reconstruct the WAMessageKey for a reaction target. The
 * reaction call needs the target message's key (its id, remoteJid, fromMe) —
 * the same envelope stored in `messages.raw`. A missing, cross-chat, or
 * corrupt target cancels the row rather than retrying, mirroring the quoted-
 * reply policy: a broken target is a deterministic cancellation.
 */
function resolveReactionTargetKey(db: AppDatabase, row: OutboxRow): WAMessageKey {
	if (!row.reaction_target_msg_id) {
		throw new QuotedReplyTargetError('Reaction target is missing');
	}
	const target = getMessage(db, row.reaction_target_msg_id);
	if (!target || target.chat_jid !== row.chat_jid || !target.raw) {
		throw new QuotedReplyTargetError('Reaction target is unavailable');
	}
	try {
		const parsed = JSON.parse(target.raw, BufferJSON.reviver) as WAMessage;
		if (!parsed?.key || parsed.key.id !== target.id) {
			throw new Error('Invalid stored message envelope');
		}
		return parsed.key;
	} catch (error) {
		if (error instanceof QuotedReplyTargetError) throw error;
		throw new QuotedReplyTargetError('Reaction target data is corrupt');
	}
}

export class OutboxPacer {
	readonly #options: OutboxPacerOptions;
	readonly #now: () => number;
	readonly #random: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #minDraftDelayMs: number;
	readonly #maxDraftDelayMs: number;
	readonly #manualPresenceMs: number;
	readonly #retryDelayMs: number;
	readonly #maxRetryDelayMs: number;
	readonly #maxAttempts: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;
	#stopped = true;
	#draftsPaused: boolean;
	/**
	 * Live send-mode. Defaults to dry-run when the `dryRun` option is unset.
	 * Flipped at runtime by
	 * {@link setDryRun} from the settings UI — no restart required. The pacer
	 * remains the only path to `sendMessage`; this only changes whether it
	 * actually transmits, never whether the queue advances.
	 */
	#dryRun: boolean;

	constructor(options: OutboxPacerOptions) {
		const pacing = getOutboxPacingSettings(options.db);
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? Math.random;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#minDraftDelayMs = options.minDraftDelayMs ?? pacing.minSpacingMs;
		this.#maxDraftDelayMs = options.maxDraftDelayMs ?? pacing.maxSpacingMs;
		this.#manualPresenceMs = options.manualPresenceMs ?? 2_500;
		this.#retryDelayMs = options.retryDelayMs ?? 5_000;
		this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 5 * 60_000;
		this.#maxAttempts = Math.max(1, options.maxAttempts ?? 5);
		this.#draftsPaused = options.draftsPaused ?? false;
		// Fail safe: an unset `dryRun` means DRY RUN, never live sends.
		//
		// This mirrors `resolveOutboxDryRun`, where anything that is not the exact
		// string 'false' resolves to dry-run. Defaulting the constructor the other
		// way would mean any caller that supplies a real transport but forgets
		// `dryRun` transmits to real recipients — the one failure mode that is not
		// recoverable, because a sent WhatsApp message cannot be unsent.
		//
		// A test that wants live sends must say so with an explicit `dryRun: false`.
		// That is the correct direction for the ask to point: opting in to sending
		// is a deliberate act, opting out is the default.
		this.#dryRun = options.dryRun ?? true;
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

	/**
	 * Flip whether the pacer transmits over the WhatsApp transport at runtime,
	 * without a restart. Safe polarity: the safe direction (live → dry-run) is
	 * always one call; the unsafe direction (dry-run → live) is gated by the
	 * caller (settings UI confirms). This does NOT add a send path — the pacer
	 * remains the only sender; it only changes whether a drained row calls the
	 * transport or logs `[outbox:dry-run]`. A wake is unnecessary: a row
	 * already past its `send_after` is not waiting on a timer, and a future
	 * row's timer is unaffected by the transmit flag.
	 */
	setDryRun(dryRun: boolean): void {
		this.#dryRun = dryRun;
	}

	isDryRun(): boolean {
		return this.#dryRun;
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
			if (row.payload_kind === 'reaction') {
				await this.#drainReaction(row);
			} else {
				await this.#drainText(row);
			}
		} finally {
			this.#running = false;
			this.wake();
		}
	}

	/**
	 * D2 (Wave 3 U2): a reaction row sends a single `react` payload. No staleness
	 * check, no composing presence, no read receipts, no draft marking — a
	 * reaction is not a reply and has no basis message. The target key is
	 * reconstructed from `messages.raw` after the row is claimed, so restart
	 * recovery stays idempotent without persisting a credential-adjacent payload
	 * in the outbox. A broken target cancels the row rather than retrying.
	 */
	async #drainReaction(row: OutboxRow): Promise<void> {
		let targetKey: WAMessageKey;
		try {
			targetKey = resolveReactionTargetKey(this.#options.db, row);
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			cancelClaimedOutbox(this.#options.db, row.id);
			this.#emit(row.id);
			this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
			return;
		}
		try {
			if (this.#dryRun) {
				console.info(
					`[outbox:dry-run] ${row.chat_jid}: react ${row.reaction_emoji ?? ''} on ${row.reaction_target_msg_id}`
				);
			} else {
				await this.#options.transport.sendReaction(
					row.chat_jid,
					targetKey,
					row.reaction_emoji ?? ''
				);
			}
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.#handleSendFailure(row, normalized);
			return;
		}

		const sentAt = this.#now();
		const spacing = this.jitterMs();
		const commitSend = this.#options.db.transaction(() => {
			markOutboxSent(this.#options.db, row.id, sentAt);
			deferPendingDrafts(this.#options.db, sentAt + spacing);
		});
		try {
			commitSend();
		} catch (error) {
			this.#stopped = true;
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
			return;
		}
		this.#emit(row.id);
	}

	async #drainText(row: OutboxRow): Promise<void> {
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
			let quoted: WAMessage | undefined;
			try {
				quoted = resolveQuotedTarget(this.#options.db, row);
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				cancelClaimedOutbox(this.#options.db, row.id);
				this.#emit(row.id);
				this.#options.onError?.(normalized, getOutbox(this.#options.db, row.id)!);
				return;
			}
			if (this.#dryRun) {
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
				await this.#options.transport.sendText(
					row.chat_jid,
					row.text,
					row.message_id!,
					quoted
				);
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
			if (!this.#dryRun) {
				const followups: Promise<unknown>[] = [
					this.#options.transport.setPresence(row.chat_jid, 'unavailable')
				];
				if (row.basis_msg_id) {
					followups.push(this.#options.transport.markRead(row.chat_jid, row.basis_msg_id));
				}
				await Promise.allSettled(followups);
			}
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.#handleSendFailure(row, normalized);
		}
	}

	/**
	 * OUTBOX-1 — the single place a failed send attempt is resolved.
	 *
	 * Retrying at all is safe because the row carries a stable `message_id`, so a
	 * repeat is idempotent at WhatsApp (the same property `recoverSendingOutbox`
	 * relies on after a crash). Retrying *forever* was the defect: no attempt
	 * counter, a fixed 5s delay, and no terminal state, which is both an
	 * invisible failure for the owner and the traffic pattern that flags an
	 * account.
	 *
	 * Three outcomes:
	 * - `offline`: no socket, so nothing was transmitted. The attempt budget is
	 *   deliberately NOT consumed — failing the owner's queue because their
	 *   laptop slept would be wrong, and no packet reached WhatsApp to be paced.
	 *   It re-arms at the flat base delay, exactly as before this change.
	 * - `terminal`: WhatsApp rejected the payload; a repeat cannot change that.
	 *   Fail on the first attempt.
	 * - `transient`: retry with exponential backoff until `maxAttempts`, then
	 *   fail. This is what bounds an undeliverable address — Baileys' send never
	 *   rejects an unregistered JID, so the cap, not the classifier, is what
	 *   stops that loop.
	 */
	#handleSendFailure(row: OutboxRow, error: Error): void {
		const kind = classifySendFailure(error);
		const message = failureMessage(error);
		const now = this.#now();

		if (kind === 'offline') {
			markOutboxRetry(this.#options.db, row.id, {
				sendAfter: now + this.#retryDelayMs,
				attempts: row.attempts,
				error: message
			});
		} else {
			const attempts = row.attempts + 1;
			if (kind === 'terminal' || attempts >= this.#maxAttempts) {
				markOutboxFailed(this.#options.db, row.id, {
					attempts,
					error: message,
					failedAt: now
				});
			} else {
				markOutboxRetry(this.#options.db, row.id, {
					sendAfter: now + retryDelayMs(attempts, this.#retryDelayMs, this.#maxRetryDelayMs),
					attempts,
					error: message
				});
			}
		}

		this.#emit(row.id);
		this.#options.onError?.(error, getOutbox(this.#options.db, row.id)!);
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
