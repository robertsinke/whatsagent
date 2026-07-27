import { getChat, setChatAgentState } from '../store/chats.js';
import type { AppDatabase } from '../store/db.js';
import { getDraft, upsertDraft } from '../store/drafts.js';
import type { Message } from '../store/messages.js';
import type { DraftProvider } from '../providers/provider.js';
import { listNeedsReplyCandidates } from './classifier.js';
import { draftChat, type AgentDraftHooks } from './drafter.js';
import type { Memory } from './memory/memory.js';

export type DraftSchedulerOptions = {
	db: AppDatabase;
	provider: DraftProvider;
	providerName: string;
	memory: Memory;
	debounceMs?: number;
	concurrency?: number;
	conversationLimit?: number;
	now?: () => number;
	hooks?: AgentDraftHooks;
};

function timestampMillis(timestamp: number): number {
	return timestamp > 0 && timestamp < 1e12 ? timestamp * 1_000 : timestamp;
}

export class DraftScheduler {
	readonly #options: DraftSchedulerOptions;
	readonly #debounceMs: number;
	readonly #concurrency: number;
	readonly #now: () => number;
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #queued = new Set<string>();
	/**
	 * Chats with an owner "Generate draft" request pending. Consumed exactly once,
	 * at the top of #run — if the marker could survive a run, the next *automatic*
	 * debounce for that chat would draft in a muted/skipped chat with no owner
	 * request behind it.
	 */
	readonly #ownerRequested = new Set<string>();
	readonly #queue: string[] = [];
	readonly #idleWaiters = new Set<() => void>();
	#running = 0;
	#stopped = false;

	constructor(options: DraftSchedulerOptions) {
		this.#options = options;
		this.#debounceMs = options.debounceMs ?? 60_000;
		this.#concurrency = Math.max(1, options.concurrency ?? 2);
		this.#now = options.now ?? Date.now;
	}

	/** Scan persisted backlog and enqueue eligible chats oldest-first. */
	start(): void {
		this.#stopped = false;
		for (const candidate of listNeedsReplyCandidates(this.#options.db)) {
			const draft = getDraft(this.#options.db, candidate.chat.jid);
			if (draft && draft.basis_msg_id === candidate.lastInbound.id && draft.status !== 'stale') {
				continue;
			}
			if (draft && draft.status !== 'stale') {
				upsertDraft(this.#options.db, { ...draft, status: 'stale' });
				this.#options.hooks?.onDraftUpdated?.(
					getDraft(this.#options.db, candidate.chat.jid)!
				);
			}
			const elapsed = this.#now() - timestampMillis(candidate.lastInbound.ts);
			this.#schedule(candidate.chat.jid, Math.max(0, this.#debounceMs - elapsed));
		}
	}

	/** Call after an inbound message has been committed by ingestion. */
	onMessage(message: Message): void {
		if (message.from_me) return;
		const chat = getChat(this.#options.db, message.chat_jid);
		if (!chat || chat.kind !== '1:1') return;

		const draft = getDraft(this.#options.db, chat.jid);
		if (draft && ['drafting', 'ready', 'failed', 'approved'].includes(draft.status)) {
			upsertDraft(this.#options.db, { ...draft, status: 'stale' });
			this.#options.hooks?.onDraftUpdated?.(getDraft(this.#options.db, chat.jid)!);
		}
		// This transition makes both skipped and failed chats eligible on new inbound.
		setChatAgentState(this.#options.db, chat.jid, null);
		const updated = getChat(this.#options.db, chat.jid);
		if (updated) this.#options.hooks?.onChatUpdated?.(updated);
		this.#schedule(chat.jid, this.#debounceMs);
	}

	/**
	 * W4-U15 — owner pressed "Generate draft"; never called automatically.
	 *
	 * Routed through the scheduler rather than calling `draftChat` directly so a
	 * manual run shares the one queue, the one concurrency limit, and the one set
	 * of hooks — and so `#schedule(jid, 0)` cancels any pending debounce timer for
	 * this chat instead of racing it.
	 *
	 * Generating a draft writes a draft row and nothing else. It never enqueues an
	 * outbox row and never reaches the send transport (R9).
	 *
	 * Returns false when the request was refused, so the caller can distinguish a
	 * refusal from an accepted run.
	 */
	generate(chatJid: string): boolean {
		const chat = getChat(this.#options.db, chatJid);
		// R8 restated at the seam: no caller can drive a group into the agent.
		if (!chat || chat.kind !== '1:1') return false;
		const draft = getDraft(this.#options.db, chatJid);
		// An approved draft may already be queued in the outbox — never regenerate
		// under one. A run already in flight is left to finish.
		if (draft && (draft.status === 'approved' || draft.status === 'drafting')) return false;
		if (draft && draft.status !== 'stale') {
			upsertDraft(this.#options.db, { ...draft, status: 'stale' });
			this.#options.hooks?.onDraftUpdated?.(getDraft(this.#options.db, chatJid)!);
		}
		setChatAgentState(this.#options.db, chatJid, null);
		const updated = getChat(this.#options.db, chatJid);
		if (updated) this.#options.hooks?.onChatUpdated?.(updated);
		this.#ownerRequested.add(chatJid);
		this.#schedule(chatJid, 0);
		return true;
	}

	/** Owner-triggered retry for a failed row; never called automatically. */
	retry(chatJid: string): void {
		const draft = getDraft(this.#options.db, chatJid);
		if (!draft || draft.status !== 'failed') return;
		upsertDraft(this.#options.db, { ...draft, status: 'stale' });
		this.#options.hooks?.onDraftUpdated?.(getDraft(this.#options.db, chatJid)!);
		setChatAgentState(this.#options.db, chatJid, null);
		const chat = getChat(this.#options.db, chatJid);
		if (chat) this.#options.hooks?.onChatUpdated?.(chat);
		this.#schedule(chatJid, 0);
	}

	waitForIdle(): Promise<void> {
		if (this.#isIdle()) return Promise.resolve();
		return new Promise((resolve) => this.#idleWaiters.add(resolve));
	}

	stop(): void {
		this.#stopped = true;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		this.#queue.length = 0;
		this.#queued.clear();
		this.#ownerRequested.clear();
		this.#resolveIdle();
	}

	#schedule(chatJid: string, delayMs: number): void {
		if (this.#stopped) return;
		const existing = this.#timers.get(chatJid);
		if (existing) clearTimeout(existing);
		this.#timers.set(
			chatJid,
			setTimeout(() => {
				this.#timers.delete(chatJid);
				this.#enqueue(chatJid);
			}, delayMs)
		);
	}

	#enqueue(chatJid: string): void {
		if (this.#stopped || this.#queued.has(chatJid)) return;
		this.#queued.add(chatJid);
		this.#queue.push(chatJid);
		this.#drain();
	}

	#drain(): void {
		while (!this.#stopped && this.#running < this.#concurrency && this.#queue.length > 0) {
			const chatJid = this.#queue.shift()!;
			this.#queued.delete(chatJid);
			this.#running += 1;
			void this.#run(chatJid);
		}
		this.#resolveIdle();
	}

	async #run(chatJid: string): Promise<void> {
		// Read-and-delete before the await: the marker authorises this run only.
		const ownerRequested = this.#ownerRequested.delete(chatJid);
		try {
			const result = await draftChat({
				ownerRequested,
				db: this.#options.db,
				provider: this.#options.provider,
				providerName: this.#options.providerName,
				memory: this.#options.memory,
				chatJid,
				conversationLimit: this.#options.conversationLimit,
				now: this.#now,
				hooks: this.#options.hooks
			});
			if (result.kind === 'rate_limited') {
				// The rate-limit reschedule is a continuation of the same request, so
				// the owner authorisation is carried over rather than silently
				// downgraded to an automatic run the classifier would then reject.
				if (ownerRequested) this.#ownerRequested.add(chatJid);
				this.#schedule(chatJid, result.retryAfterMs);
			}
		} finally {
			this.#running -= 1;
			this.#drain();
		}
	}

	#isIdle(): boolean {
		return this.#running === 0 && this.#queue.length === 0 && this.#timers.size === 0;
	}

	#resolveIdle(): void {
		if (!this.#isIdle()) return;
		for (const resolve of this.#idleWaiters) resolve();
		this.#idleWaiters.clear();
	}
}
