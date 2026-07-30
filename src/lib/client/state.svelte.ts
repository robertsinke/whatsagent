import { api } from './api.js';
import { createRealtime, type Realtime } from './ws.svelte.js';
import {
	ApiError,
	type Chat,
	type Draft,
	type Message,
	type OutboxRow,
	type RefinementIntent,
	type SendProposal,
	type SessionView,
	type AgentSessionView
} from './types.js';
import {
	isKnownAgentPartKind,
	upsertAgentPart,
	type AgentPart
} from '../../../shared/agent-events.js';
import {
	CONFLICT_TEXT_CHANGED,
	hashApprovalText,
	type DraftTextSource
} from '../../../shared/approval-hash.js';
import {
	deriveUnreadBoundary,
	deriveUnreadBoundaryFromCursor,
	mergeMessages,
	replaceMessage,
	type UnreadBoundary
} from './view.js';

const PAGE_SIZE = 60;

/** Mirrors the server's approvable set — the only statuses a click can send. */
const APPROVABLE_DRAFT_STATUSES: ReadonlySet<string> = new Set(['ready', 'stale', 'drafted']);

/**
 * W4-U12. History sync writes chat and message rows straight to SQLite and
 * publishes no per-row event — deliberately, because one batch can carry
 * thousands of messages and a `message-new` per row would flood the socket and
 * re-sort the open conversation once per message. `sync-progress` is the
 * notification, and the client answers it with one coalesced {@link
 * AppState.refresh}: batches inside the debounce window collapse into a single
 * refetch, and the max-wait keeps a long initial sync (whose batches arrive
 * with no gap between them) from starving the trailing timer forever.
 */
const RESYNC_DEBOUNCE_MS = 750;
const RESYNC_MAX_WAIT_MS = 4_000;
/**
 * W4-U15 safety net only. An accepted generate is released by its first draft
 * event; this bounds the wait so a run that emits nothing cannot leave the
 * Generate button disabled indefinitely.
 */
const GENERATE_SETTLE_TIMEOUT_MS = 30_000;

const EMPTY_SESSION: SessionView = {
	status: 'initializing',
	qr: null,
	qrExpiresAt: null,
	sync: { chatsSynced: 0, messagesSynced: 0, complete: false }
};

/** Re-confirmation prompt raised by a 409 from the approve endpoint. */
export type StalePrompt = {
	chatJid: string;
	basisMsgId: string | null;
	latestInboundId: string | null;
};

/**
 * PL-U3 Half B — the draft is no longer the text the owner read.
 *
 * Raised either by a `text-changed` 409, or locally when a `draft-updated`
 * event carries text the owner has not acknowledged. Both hold the *new* text
 * and the hash that goes with it: approving from here sends this hash, never
 * one recomputed at click time, so the second click authorises the text this
 * prompt actually displayed.
 */
export type TextConflictPrompt = {
	chatJid: string;
	text: string;
	hash: string;
	source: DraftTextSource;
	/** True when the server refused a click; false when we caught it first. */
	refused: boolean;
};

/** PL-U3 — a proposal whose confirmation the server refused as stale. */
export type ProposalStalePrompt = {
	proposalId: number;
	latestInboundId: string;
};

export class AppState {
	session = $state<SessionView>(EMPTY_SESSION);
	chats = $state<Chat[]>([]);
	selectedJid = $state<string | null>(null);
	messages = $state<Message[]>([]);
	draft = $state<Draft | null>(null);
	replyTarget = $state<Message | null>(null);
	outbox = $state<OutboxRow[]>([]);
	loadingMessages = $state(false);
	/** False once a page comes back short — otherwise "load earlier" never ends. */
	hasMoreMessages = $state(false);
	stalePrompt = $state<StalePrompt | null>(null);
	/**
	 * PL-U3 Half B — set when the open chat's draft changed under the owner.
	 * While this is set, the approve buttons are not the owner's next action:
	 * reading the new text is. See {@link acknowledgeDraftChange}.
	 */
	textConflict = $state<TextConflictPrompt | null>(null);
	/** PL-U3 — pending agent proposals awaiting an owner decision. */
	proposals = $state<SendProposal[]>([]);
	proposalStalePrompt = $state<ProposalStalePrompt | null>(null);
	/** Proposal id currently being confirmed/rejected, so the card can disable. */
	decidingProposalId = $state<number | null>(null);
	/**
	 * True while a preview-only draft refinement request is in flight. The
	 * editor stays open across success, failure, and 409; this flag only
	 * disables conflicting refinement actions and surfaces local progress.
	 */
	refining = $state(false);
	/**
	 * Recoverable refinement error message. Set on provider failure or a 409
	 * (draft changed during refinement); cleared on the next successful
	 * refinement or when the owner switches chats. The prior preview is always
	 * preserved — refinement never destroys a good draft.
	 */
	refineError = $state<string | null>(null);
	/**
	 * W4-U15 — true while an owner-triggered "Generate draft" request is in
	 * flight. "In flight" means *until the draft row appears*, matching how
	 * `refining` covers a whole provider round-trip — not merely until the 202.
	 * The server accepts before the scheduler runs, and at the concurrency limit
	 * the chat can sit queued with no `drafting` row, which would otherwise leave
	 * the card reading "No draft" with the button live and nothing happening.
	 */
	generating = $state(false);
	/** Recoverable generation error, surfaced in the no-draft card. */
	generateError = $state<string | null>(null);
	/** Chat awaiting its first draft event, and the safety net that releases it. */
	#generatingJid: string | null = null;
	#generatingTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * One "New" marker for the open chat. U4: derived from the persisted read
	 * cursor (`last_read_msg_id`) when it is present, falling back to the
	 * count-based placement from W2-U1 for chats that have never been opened
	 * locally since migration 010. The marker is latched, not reactive: it is
	 * recomputed only when a chat opens and when older pages are prepended.
	 */
	unreadBoundary = $state<UnreadBoundary | null>(null);
	error = $state<string | null>(null);
	/**
	 * Owner-triggered history-deepen status per selected chat. `idle` | `loading`
	 * | `success` | `error`. Resets on chat switch. Read-only with respect to
	 * WhatsApp — this only asks the phone for older messages; it never sends.
	 */
	deepenStatus = $state<{ kind: 'idle' | 'loading' | 'success' | 'error'; at: number | null }>({
		kind: 'idle',
		at: null
	});
	/**
	 * U5 — jump-to-quote signal. Set by `jumpToQuotedMessage` and consumed by
	 * the conversation stream, which scrolls to the target id and briefly
	 * highlights it. `nonce` disambiguates repeated jumps to the same id so a
	 * second click still re-fires the effect. `pending` is true while an
	 * off-page fetch is in flight so the stream knows the target is on its way
	 * (it ignores stale signals for a chat that was switched away mid-fetch).
	 */
	jumpTarget = $state<{ id: string; nonce: number } | null>(null);
	/**
	 * W4-U8 — outbox send-mode. `true` when the pacer transmits over WhatsApp;
	 * `false` (the fail-safe default) when rows are marked sent without
	 * reaching a recipient. Surfaced always-visible in the topbar so the owner
	 * is never unsure whether a send is live. Updated live via the
	 * `send-mode` WS event; flipped through {@link setSendMode} which confirms
	 * the unsafe direction (live) in the UI before calling the API.
	 */
	sendsLive = $state(false);
	/**
	 * True while a send-mode PUT is in flight, so the toggle can show a
	 * local pending state without flickering on the WS echo.
	 */
	sendingMode = $state(false);
	/**
	 * OSS-P3.4 — true once the first refresh has come back. Until then an
	 * already-paired app is indistinguishable from a brand-new one (both are
	 * `initializing` with zero chats), so the first-run flow must not commit to
	 * an answer yet or it would flash on every launch. See {@link isFirstRun}.
	 */
	hydrated = $state(false);
	/**
	 * PL-A1 — agent turn parts keyed by sessionId. Accumulated by
	 * `agent-part-updated` events; AgentPanel.svelte renders from this, never
	 * from the wire directly.
	 */
	agentSessions = $state<Record<string, AgentSessionView>>({});

	#realtime: Realtime | undefined;
	#conversationEpoch = 0;
	/** Coalescing state for the history-sync resync — see {@link RESYNC_DEBOUNCE_MS}. */
	readonly #resyncDebounceMs: number;
	readonly #resyncMaxWaitMs: number;
	#resyncTimer: ReturnType<typeof setTimeout> | undefined;
	#resyncMaxWaitTimer: ReturnType<typeof setTimeout> | undefined;
	/** Highest cumulative sync counters seen on the wire, to spot a batch that wrote rows. */
	#syncedSeen = { chats: 0, messages: 0 };
	/** Server unread count at the moment this chat was opened. */
	#unreadAtOpen = 0;
	/**
	 * U4 — persisted read cursor snapshotted at open, so the boundary stays put
	 * even after `markRead` advances the server-side cursor. `null` for chats
	 * that have never been opened locally since migration 010; the count-based
	 * {@link deriveUnreadBoundary} is used as the fallback in that case.
	 */
	#cursorAtOpen: string | null = null;
	/**
	 * PL-U3 Half B — the hash of the draft text the owner has actually seen, per
	 * chat. This is the whole guard: it is pinned when a draft is presented and
	 * is NOT updated by an incoming `draft-updated`, because a silent re-pin is
	 * exactly how "owner reads A, agent rewrites to B, owner approves B" used to
	 * happen. Only {@link acknowledgeDraftChange} (an owner action) re-pins it.
	 */
	#reviewedDraftHash = new Map<string, string>();

	constructor(options: { resyncDebounceMs?: number; resyncMaxWaitMs?: number } = {}) {
		this.#resyncDebounceMs = options.resyncDebounceMs ?? RESYNC_DEBOUNCE_MS;
		this.#resyncMaxWaitMs = options.resyncMaxWaitMs ?? RESYNC_MAX_WAIT_MS;
	}

	get connected(): boolean {
		return this.#realtime?.connected ?? false;
	}

	get selectedChat(): Chat | null {
		return this.chats.find((c) => c.jid === this.selectedJid) ?? null;
	}

	start(): void {
		this.#realtime = createRealtime({
			onEvent: (event) => this.applyEvent(event),
			// Every reconnect refetches — never trust that we saw every event.
			onResync: () => void this.refresh()
		});
		this.#realtime.start();
		void this.refresh();
	}

	stop(): void {
		this.#realtime?.stop();
		this.#realtime = undefined;
		this.#clearResyncTimers();
	}

	#clearResyncTimers(): void {
		if (this.#resyncTimer) clearTimeout(this.#resyncTimer);
		if (this.#resyncMaxWaitTimer) clearTimeout(this.#resyncMaxWaitTimer);
		this.#resyncTimer = undefined;
		this.#resyncMaxWaitTimer = undefined;
	}

	/**
	 * Ask for one refetch after the current burst of history batches settles.
	 * Trailing-only would never fire during an initial sync, whose batches land
	 * back to back for minutes; the max-wait timer forces progress meanwhile.
	 */
	#scheduleResync(): void {
		if (this.#resyncTimer) clearTimeout(this.#resyncTimer);
		this.#resyncTimer = setTimeout(() => void this.#runResync(), this.#resyncDebounceMs);
		this.#resyncMaxWaitTimer ??= setTimeout(() => void this.#runResync(), this.#resyncMaxWaitMs);
	}

	#runResync(): Promise<void> {
		this.#clearResyncTimers();
		// A machine-triggered resync is not an owner navigation: it must not clear
		// the deepen feedback the owner is looking at. The phone answers a deepen
		// with exactly the history batch that schedules this refresh, so without
		// the flag "Requested" would be wiped by its own result arriving.
		return this.refresh({ preserveDeepenStatus: true });
	}

	async refresh(options: { preserveDeepenStatus?: boolean } = {}): Promise<void> {
		try {
			const [session, chats, outbox, sendMode, proposals] = await Promise.all([
				api.session().catch(() => EMPTY_SESSION),
				api.chats(),
				api.outbox(),
				api.sendMode().catch(() => ({ live: false, dry_run: true })),
				// A proposal outlives the socket that announced it, so the pending
				// set is refetched rather than reconstructed from events.
				api.proposals().catch(() => ({ items: [] as SendProposal[] }))
			]);
			this.session = session;
			this.chats = chats;
			this.outbox = outbox;
			this.sendsLive = sendMode.live;
			this.proposals = proposals.items;
			// Session and chats have now both been seen — first-run can be decided.
			this.hydrated = true;
			if (this.selectedJid) {
				await this.openChat(this.selectedJid, {
					markRead: false,
					preserveDeepenStatus: options.preserveDeepenStatus
				});
			}
		} catch (err) {
			this.error = describeError(err);
		}
	}

	async openChat(
		jid: string,
		options: { markRead?: boolean; preserveDeepenStatus?: boolean } = {}
	): Promise<void> {
		const epoch = ++this.#conversationEpoch;
		// A same-chat reopen (refresh, deepen, post-409 reload) must not restate the
		// unread snapshot — by then the chat is already read and the count is 0.
		const chatChanged = this.selectedJid !== jid;
		const resnapshotUnread = chatChanged || options.markRead !== false;
		const chatBeforeOpen = this.chats.find((c) => c.jid === jid);
		const unreadBeforeOpen = chatBeforeOpen?.unread ?? 0;
		const cursorBeforeOpen = chatBeforeOpen?.last_read_msg_id ?? null;
		this.selectedJid = jid;
		if (chatChanged) this.replyTarget = null;
		if (chatChanged) this.jumpTarget = null;
		// W4-U14: a same-chat reopen that already has a loaded window must not
		// flip `loadingMessages` — ConversationPane unmounts the stream while
		// loading is true, which would yank the owner's scroll position even
		// when the message array is preserved below.
		const preserveWindow = !chatChanged && this.messages.length > 0;
		if (!preserveWindow) this.loadingMessages = true;
		this.stalePrompt = null;
		// Chat-scoped like the stale prompt: without this the contested text from
		// another chat would render over this one's composer. `#observeDraft` at
		// the end of this method re-raises it when the pin still disagrees.
		this.textConflict = null;
		// Refinement error is chat-scoped: a new selection (or same-chat reload)
		// clears it. `refining` is left untouched — an in-flight request is not
		// canceled by a UI reload, and its finally-block clears the flag.
		if (chatChanged) this.refineError = null;
		if (chatChanged) this.generateError = null;
		// A generate awaiting its first event belongs to the chat it was asked
		// for; leaving the flag set would disable the button in the new chat.
		if (chatChanged && this.#generatingJid !== null) {
			this.#settleGenerating(this.#generatingJid);
		}
		if (!options.preserveDeepenStatus) {
			this.deepenStatus = { kind: 'idle', at: null };
		}
		try {
			const messages = await api.messages(jid, { limit: PAGE_SIZE });
			if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
			if (preserveWindow) {
				// Re-merge the fresh newest page into the existing array. One
				// request regardless of how deep the reader has paged — never
				// refetch every loaded page. Messages the newest page no longer
				// contains stay on screen: history sync only adds rows, and a
				// deletion (rare) would arrive via `message-updated` / a later
				// explicit navigation, not via this coalesced resync.
				this.messages = mergeMessages(this.messages, messages);
				// Do not touch hasMoreMessages: that flag is about the OLDEST
				// edge of the window. A newest-page fetch cannot speak for it,
				// and recomputing from a full newest page would falsely revive
				// "load earlier" after loadOlder had cleared it.
			} else {
				this.messages = mergeMessages([], messages);
				this.hasMoreMessages = messages.length >= PAGE_SIZE;
			}
			if (resnapshotUnread) {
				this.#unreadAtOpen = unreadBeforeOpen;
				this.#cursorAtOpen = cursorBeforeOpen;
				// U4: prefer the persisted cursor. Fall back to the count-based
				// placement for chats that have never been opened locally since
				// migration 010 — the boundary never regresses.
				// When preserving the window, resnapshotUnread is false on the
				// resync path (markRead: false) so the boundary stays put; a
				// chat switch still derives against the fresh page below.
				this.unreadBoundary = cursorBeforeOpen
					? deriveUnreadBoundaryFromCursor(messages, cursorBeforeOpen, unreadBeforeOpen)
					: deriveUnreadBoundary(messages, unreadBeforeOpen);
			}
			const draft = await api.draft(jid).catch(() => null);
			if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
			this.draft = draft;
			this.#observeDraft(draft);
			if (options.markRead !== false) {
				const updated = await api.markRead(jid);
				if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
				this.#mergeChat(updated);
			}
		} catch (err) {
			this.error = describeError(err);
		} finally {
			if (epoch === this.#conversationEpoch) this.loadingMessages = false;
		}
	}

	async loadOlder(): Promise<void> {
		const jid = this.selectedJid;
		const epoch = this.#conversationEpoch;
		const oldest = this.messages[0];
		if (!jid || !oldest) return;
		const older = await api.messages(jid, {
			limit: PAGE_SIZE,
			beforeTs: oldest.ts,
			beforeId: oldest.id
		});
		if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
		this.hasMoreMessages = older.length >= PAGE_SIZE;
		this.messages = mergeMessages(this.messages, older);
		// A prepend is the only event that can sharpen an approximate boundary:
		// once it is exact it stays put, so the marker never moves under the reader.
		if (this.unreadBoundary && !this.unreadBoundary.exact) {
			this.unreadBoundary = this.#cursorAtOpen
				? deriveUnreadBoundaryFromCursor(this.messages, this.#cursorAtOpen, this.#unreadAtOpen)
				: deriveUnreadBoundary(this.messages, this.#unreadAtOpen);
		}
  }

	/**
	 * U5 — jump to a quoted message's target. If the target is on the loaded
	 * page, this just signals the stream to scroll to it. If it is off-page, a
	 * focused page is fetched around the target and merged into the loaded
	 * messages (a prepend when the target is older than the loaded window, an
	 * append when newer — but in practice a quote target is almost always
	 * older). The merge produces the same prepend shape `loadOlder` does, so
	 * the W2-U1 anchor restoration is exercised by the same path: the stream
	 * captures the anchor, the merge happens, the anchor is restored, and only
	 * then does the explicit scroll-to-target override it — a navigation, not a
	 * yank. A target that no longer exists degrades to a no-op: the focused
	 * fetch returns an empty page and no signal is set, so the quote inset's
	 * existing "original not loaded" rendering stays honest without a crash.
	 */
	async jumpToQuotedMessage(targetId: string): Promise<void> {
		const jid = this.selectedJid;
		if (!jid) return;
		// In-page: the target is already loaded — just signal the stream.
		if (this.messages.some((m) => m.id === targetId)) {
			this.jumpTarget = { id: targetId, nonce: this.#nextJumpNonce() };
			return;
		}
		// Off-page: fetch a page centered on the target. The epoch guards a chat
		// switch (or reload) that happens while the fetch is in flight — a late
		// merge for a chat the owner already left must not land.
		const epoch = this.#conversationEpoch;
		try {
			const focused = await api.messages(jid, { limit: PAGE_SIZE, focusMsgId: targetId });
			if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
			// Unknown / cross-chat target → empty page. Degrade to a no-op rather
			// than signalling a scroll to a message that will never render.
			if (focused.length === 0) return;
			// Merge so existing loaded context is preserved. This is the prepend
			// that exercises anchor restoration; the stream captures the anchor
			// via the `grew`-path effect, restores it, and then the jump signal
			// (set below) drives the explicit scroll to the target.
			this.messages = mergeMessages(this.messages, focused);
			// The focused page may have revealed older history than the loaded
			// window's previous floor — keep `hasMoreMessages` honest.
			this.hasMoreMessages = true;
			this.jumpTarget = { id: targetId, nonce: this.#nextJumpNonce() };
		} catch (err) {
			this.error = describeError(err);
		}
	}

	#jumpNonce = 0;
	#nextJumpNonce(): number {
		return ++this.#jumpNonce;
	}

	/** Composer send — goes to the outbox, never to WhatsApp directly (R9). */
	async send(text: string): Promise<boolean> {
		const jid = this.selectedJid;
		if (!jid || !text.trim()) return false;
		const replyTarget = this.replyTarget;
		try {
			const row = await api.send(jid, text.trim(), replyTarget?.id);
			this.#mergeOutbox(row);
			// A newer selection made while enqueue was in flight must survive.
			if (replyTarget && this.replyTarget?.id === replyTarget.id) this.replyTarget = null;
			return true;
		} catch (err) {
			this.error = describeError(err);
			return false;
		}
	}

	selectReply(message: Message): void {
		if (message.chat_jid === this.selectedJid) this.replyTarget = message;
	}

	dismissReply(): void {
		this.replyTarget = null;
	}

	/**
	 * Approve a draft. Two different 409s can come back and they are told apart
	 * by `body.conflict`, never guessed: `stale-inbound` (the conversation moved
	 * on) raises the re-read prompt, `text-changed` (the draft is not what was
	 * on screen) raises the review prompt. Neither is retried automatically —
	 * an automatic retry would re-authorise text the owner never saw, which is
	 * the bug this whole path exists to prevent.
	 *
	 * `base_hash` is the pinned reviewed hash, not a hash of the text being
	 * sent: the owner may have rewritten the message entirely, and the question
	 * the server answers is whether the draft they started from still stands.
	 */
	async approveDraft(text?: string): Promise<boolean> {
		const jid = this.selectedJid;
		if (!jid) return false;
		// A change we already caught locally must be acknowledged first; sending
		// now would ship whatever arrived while the owner was reading.
		if (this.textConflict && this.textConflict.chatJid === jid) return false;
		try {
			const { outbox, draft } = await api.approveDraft(
				jid,
				text,
				undefined,
				this.#reviewedHashFor(jid)
			);
			this.#mergeOutbox(outbox);
			this.#applyApprovedDraft(draft);
			return true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				return this.#applyApproveConflict(jid, err);
			}
			this.error = describeError(err);
			return false;
		}
	}

	/** Explicit second owner action after the server reports a stale basis. */
	async confirmStaleDraft(text?: string): Promise<boolean> {
		const prompt = this.stalePrompt;
		if (!prompt || this.selectedJid !== prompt.chatJid || !prompt.latestInboundId) return false;
		if (this.textConflict && this.textConflict.chatJid === prompt.chatJid) return false;
		try {
			const { outbox, draft } = await api.approveDraft(
				prompt.chatJid,
				text,
				prompt.latestInboundId,
				this.#reviewedHashFor(prompt.chatJid)
			);
			this.#mergeOutbox(outbox);
			this.#applyApprovedDraft(draft);
			return true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				// Deliberately not a re-approve call: the old fallback re-issued the
				// request and would now re-send a hash for text nobody re-read.
				// Whichever conflict came back, the owner gets a prompt and decides.
				return this.#applyApproveConflict(prompt.chatJid, err);
			}
			this.error = describeError(err);
			return false;
		}
	}

	/**
	 * The owner has now read the changed draft. Re-pin the hash to what is on
	 * screen, so the next click authorises *this* text. This is the only place
	 * that advances a reviewed hash after the initial pin, and it exists only
	 * as the result of an owner action.
	 */
	acknowledgeDraftChange(): void {
		const prompt = this.textConflict;
		if (!prompt) return;
		this.#reviewedDraftHash.set(prompt.chatJid, prompt.hash);
		if (this.draft?.chat_jid === prompt.chatJid && this.draft.text !== prompt.text) {
			// The server's copy is authoritative over anything we cached.
			this.draft = { ...this.draft, text: prompt.text };
		}
		this.textConflict = null;
	}

	/** Dismiss the prompt without adopting the new text — nothing is approved. */
	dismissTextConflict(): void {
		this.textConflict = null;
	}

	/** Pending proposals for the open chat — the only ones the pane renders. */
	get selectedProposals(): SendProposal[] {
		return this.proposals.filter((p) => p.chat_jid === this.selectedJid);
	}

	/**
	 * PL-U3 — confirm an agent-proposed send. This is the click that creates the
	 * outbox row; `propose-send` created nothing. The hash is taken from the
	 * proposal text this client is holding (and therefore rendering), so a
	 * server-side row that says something else is refused rather than sent.
	 *
	 * A stale 409 raises a prompt for a second, explicit confirmation carrying
	 * the newer inbound id — the same contract as a stale draft.
	 */
	async confirmProposal(id: number, confirmedLatestInboundId?: string): Promise<boolean> {
		const proposal = this.proposals.find((p) => p.id === id);
		if (!proposal || this.decidingProposalId !== null) return false;
		this.decidingProposalId = id;
		try {
			const { outbox, proposal: decided } = await api.confirmProposal(
				id,
				hashApprovalText(proposal.text),
				confirmedLatestInboundId
			);
			this.#mergeOutbox(outbox);
			this.proposals = this.proposals.filter((p) => p.id !== decided.id);
			this.proposalStalePrompt = null;
			return true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				const latestInboundId = err.body.latest_inbound_id;
				if (typeof latestInboundId === 'string') {
					this.proposalStalePrompt = { proposalId: id, latestInboundId };
				} else {
					// Not stale: the proposal is gone or its text is not what we hold.
					// Refetching is the honest answer — never re-hash and retry.
					this.proposalStalePrompt = null;
					this.error = describeError(err);
					await this.refreshProposals();
				}
				return false;
			}
			this.error = describeError(err);
			return false;
		} finally {
			this.decidingProposalId = null;
		}
	}

	/** Second, explicit confirmation after the server called a proposal stale. */
	async confirmStaleProposal(id: number): Promise<boolean> {
		const prompt = this.proposalStalePrompt;
		if (!prompt || prompt.proposalId !== id) return false;
		return this.confirmProposal(id, prompt.latestInboundId);
	}

	async rejectProposal(id: number): Promise<boolean> {
		if (this.decidingProposalId !== null) return false;
		this.decidingProposalId = id;
		try {
			await api.rejectProposal(id);
			this.proposals = this.proposals.filter((p) => p.id !== id);
			if (this.proposalStalePrompt?.proposalId === id) this.proposalStalePrompt = null;
			return true;
		} catch (err) {
			this.error = describeError(err);
			return false;
		} finally {
			this.decidingProposalId = null;
		}
	}

	async refreshProposals(): Promise<void> {
		try {
			this.proposals = (await api.proposals()).items;
		} catch {
			// Non-fatal: the WS event refills this, and a missing proposal card
			// never causes a send.
		}
	}

	#reviewedHashFor(jid: string): string | undefined {
		const pinned = this.#reviewedDraftHash.get(jid);
		if (pinned) return pinned;
		// No pin (a draft that arrived before this chat was ever opened): fall
		// back to what is currently on screen. That is still the text the owner
		// is looking at right now, and the server re-checks it either way.
		if (this.draft?.chat_jid === jid) return hashApprovalText(this.draft.text);
		return undefined;
	}

	#pinReviewedDraft(draft: Draft | null): void {
		if (!draft) return;
		this.#reviewedDraftHash.set(draft.chat_jid, hashApprovalText(draft.text));
	}

	/**
	 * Look at a draft the way the owner is about to. First sight pins the hash;
	 * a later change to text they never acknowledged raises the review prompt
	 * instead of quietly replacing what they were reading.
	 *
	 * Owner-sourced changes re-pin themselves. `text_source: 'owner'` can only
	 * be written by a frontend dispatch (the dispatcher refuses `tool` on both
	 * writers), so it is the owner's own edit arriving back over the socket —
	 * prompting them to review their own typing would be noise, not safety.
	 */
	#observeDraft(draft: Draft | null): void {
		if (!draft) return;
		if (!APPROVABLE_DRAFT_STATUSES.has(draft.status) || !draft.text.trim()) return;
		const hash = hashApprovalText(draft.text);
		const pinned = this.#reviewedDraftHash.get(draft.chat_jid);
		if (pinned === hash) {
			if (this.textConflict?.chatJid === draft.chat_jid) this.textConflict = null;
			return;
		}
		const ownerInitiated = draft.text_source === 'owner' || this.#generatingJid === draft.chat_jid;
		if (pinned === undefined || ownerInitiated) {
			this.#reviewedDraftHash.set(draft.chat_jid, hash);
			if (this.textConflict?.chatJid === draft.chat_jid) this.textConflict = null;
			return;
		}
		this.textConflict = {
			chatJid: draft.chat_jid,
			text: draft.text,
			hash,
			source: draft.text_source,
			refused: false
		};
	}

	#applyApprovedDraft(draft: Draft): void {
		this.draft = draft;
		this.stalePrompt = null;
		this.textConflict = null;
		this.#pinReviewedDraft(draft);
	}

	/** Route a 409 from the approve endpoint to the prompt it belongs to. */
	async #applyApproveConflict(jid: string, err: ApiError): Promise<boolean> {
		if (err.body.conflict === CONFLICT_TEXT_CHANGED) {
			const text = typeof err.body.current_text === 'string' ? err.body.current_text : '';
			this.textConflict = {
				chatJid: jid,
				text,
				hash:
					typeof err.body.current_hash === 'string'
						? err.body.current_hash
						: hashApprovalText(text),
				source: (err.body.text_source as DraftTextSource) ?? 'system',
				refused: true
			};
			this.stalePrompt = null;
			return false;
		}
		const stalePrompt = {
			chatJid: jid,
			basisMsgId: (err.body.basis_msg_id as string) ?? null,
			latestInboundId: (err.body.latest_inbound_id as string) ?? null
		};
		await this.openChat(jid, { markRead: false });
		if (this.selectedJid === jid) this.stalePrompt = stalePrompt;
		return false;
	}

	async skipDraft(): Promise<void> {
		const jid = this.selectedJid;
		if (!jid) return;
		try {
			const { chat } = await api.skipDraft(jid);
			this.draft = null;
			this.stalePrompt = null;
			this.#mergeChat(chat);
		} catch (err) {
			this.error = describeError(err);
		}
	}

	/**
	 * W4-U15 — ask the agent for a draft in the open chat, on demand. Valid even
	 * where automatic classification declined (owner spoke last, chat skipped,
	 * muted, archived, or gone quiet); the server refuses group chats.
	 *
	 * There is no optimistic write: the server accepts with 202 and the draft
	 * arrives over `draft-updated`, so the card transitions to its own shimmer.
	 *
	 * This never approves, enqueues an outbox row, or wakes the pacer (R9).
	 */
	async generateDraft(): Promise<boolean> {
		const jid = this.selectedJid;
		if (!jid || this.generating) return false;
		this.generating = true;
		this.generateError = null;
		// The owner asked for new text, so there is no prior review left to
		// invalidate. Dropping the pin lets whatever arrives pin itself; a change
		// *after* that still raises the review prompt. Without this, an owner's
		// own Generate click comes back as "this draft was regenerated after you
		// read it", and a prompt that cries wolf is a prompt nobody reads.
		this.#reviewedDraftHash.delete(jid);
		this.textConflict = null;
		try {
			await api.generateDraft(jid);
			// Accepted, not finished: hold the flag until the first draft event for
			// this chat arrives. The timeout is only a safety net so a run that
			// somehow emits nothing cannot strand the button disabled forever.
			this.#generatingJid = jid;
			this.#generatingTimer = setTimeout(
				() => this.#settleGenerating(jid),
				GENERATE_SETTLE_TIMEOUT_MS
			);
			return true;
		} catch (err) {
			if (this.selectedJid === jid) {
				this.generateError =
					err instanceof ApiError && err.status === 503
						? 'No draft provider is configured, so the agent cannot write a draft.'
						: describeError(err);
			}
			this.#settleGenerating(jid);
			return false;
		}
	}

	/** Release the in-flight flag for `jid`, if it is the chat still waiting. */
	#settleGenerating(jid: string): void {
		if (this.#generatingJid !== null && this.#generatingJid !== jid) return;
		this.generating = false;
		this.#generatingJid = null;
		if (this.#generatingTimer !== null) {
			clearTimeout(this.#generatingTimer);
			this.#generatingTimer = null;
		}
	}

	/**
	 * Preview-only draft refinement. Returns the updated draft on success so the
	 * editor can replace its textarea contents with the transformed text; returns
	 * `null` on failure, 409, or when the chat is no longer selected so the
	 * caller preserves the visible preview.
	 *
	 * On a 409 (draft or inbound history changed while the provider was running)
	 * the late result is never applied — the active draft is reloaded from the
	 * server and a recoverable error is surfaced. On any other failure the prior
	 * draft is left untouched and a recoverable error is surfaced. Either way the
	 * editor stays open and the owner can retry or edit manually.
	 *
	 * This never approves, enqueues an outbox row, writes memory feedback, or
	 * wakes the pacer (R5/R6).
	 */
	async refineDraft(intent: RefinementIntent, text?: string): Promise<Draft | null> {
		const jid = this.selectedJid;
		if (!jid || this.refining) return null;
		this.refining = true;
		this.refineError = null;
		try {
			const draft = await api.refineDraft(jid, intent, text);
			// A chat switch during refinement means the late Draft must not reach
			// DraftStatus (which would overwrite component-owned editedText).
			if (this.selectedJid !== jid) return null;
			this.draft = draft;
			return draft;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				// The draft or inbound history changed while the provider was
				// running. Preserve the visible preview and reload current state
				// rather than applying the late result.
				this.refineError = 'Draft changed while refining — your text is preserved. Try again.';
				await this.openChat(jid, { markRead: false });
			} else if (err instanceof ApiError && err.status === 404) {
				this.refineError = 'Draft is no longer available.';
				await this.openChat(jid, { markRead: false });
			} else {
				this.refineError = describeError(err);
			}
			return null;
		} finally {
			this.refining = false;
		}
	}

	async cancelOutbox(id: number): Promise<void> {
		try {
			this.#mergeOutbox(await api.cancelOutbox(id));
		} catch (err) {
			this.error = describeError(err);
		}
	}

	/**
	 * D2 (Wave 3 U2): add or remove a reaction on a message. Routes through the
	 * outbox pacer — a reaction is a send under R9, so it rides the same single
	 * send path. An empty emoji string removes a prior reaction. The outbox row
	 * is merged into the tray; the reaction chip itself updates when the server
	 * emits a `message-updated` event after the WhatsApp reaction ack arrives.
	 */
	async react(messageId: string, emoji: string): Promise<void> {
		try {
			const row = await api.react(messageId, emoji);
			this.#mergeOutbox(row);
		} catch (err) {
			this.error = describeError(err);
		}
	}

	/** D2 — fetch media for one message, on demand. */
	async loadMedia(messageId: string): Promise<void> {
		try {
			const updated = await api.loadMedia(messageId);
			this.messages = replaceMessage(this.messages, updated);
		} catch (err) {
			// The server has already persisted `failed` + reason; refetch to render it.
			const jid = this.selectedJid;
			if (jid) this.messages = mergeMessages([], await api.messages(jid, { limit: PAGE_SIZE }));
			if (!(err instanceof ApiError)) this.error = describeError(err);
		}
	}

	async regeneratePairing(): Promise<void> {
		try {
			await api.regeneratePairing();
		} catch (err) {
			this.error = describeError(err);
		}
	}

	/**
	 * W4-U8: flip the outbox send-mode at runtime. The UI confirms the unsafe
	 * direction (live) before calling this; the safe direction (dry-run) calls
	 * this directly with no gate. The server pushes the change into the live
	 * pacer and emits a `send-mode` WS event, which {@link applyEvent} folds
	 * into {@link sendsLive} — so this method does not optimistically update
	 * the state, it waits for the echo to avoid a flicker on a failed PUT.
	 */
	async setSendMode(live: boolean): Promise<boolean> {
		if (this.sendingMode) return false;
		this.sendingMode = true;
		try {
			const result = await api.setSendMode(live);
			this.sendsLive = result.live;
			return result.live === live;
		} catch (err) {
			this.error = describeError(err);
			return false;
		} finally {
			this.sendingMode = false;
		}
	}

	/**
	 * Owner-triggered on-demand history deepen for the selected chat. Asks the
	 * server to call Baileys `fetchMessageHistory` for older messages; the
	 * server returns 202 once the request is accepted, and the phone answers
	 * later with a `messaging-history.set` batch.
	 *
	 * Those older messages never arrive as `message-new` — history sync writes
	 * rows without per-row events (W4-U12). What arrives is `sync-progress`, and
	 * {@link applyEvent} answers it with a coalesced {@link refresh}. The
	 * immediate `openChat` below is the fast path for history that already
	 * landed between request and response; the WS-driven resync is what covers
	 * a phone that answers seconds later.
	 *
	 * This is read-only with respect to WhatsApp — it pulls history from the
	 * phone, never sends to a recipient — so it is safe to expose without the
	 * outbox/approval guard. The server additionally refuses while disconnected.
	 */
	async deepenHistory(count?: number): Promise<void> {
		const jid = this.selectedJid;
		if (!jid) return;
		this.deepenStatus = { kind: 'loading', at: Date.now() };
		try {
			await api.deepenHistory(jid, count);
			this.deepenStatus = { kind: 'success', at: Date.now() };
			// The phone delivers older messages asynchronously; refresh once to
			// surface anything that landed between request and response.
			await this.openChat(jid, { markRead: false, preserveDeepenStatus: true });
		} catch (err) {
			this.deepenStatus = { kind: 'error', at: Date.now() };
			this.error = describeError(err);
		}
	}

	/**
	 * The realtime reducer. Public so it can be exercised directly — it is the
	 * only place server events mutate client state, and its rules (in particular
	 * replace-vs-insert) are worth testing without standing up a socket.
	 */
	applyEvent(event: import('./types.js').ServerEvent): void {
		switch (event.type) {
			case 'session':
				this.session = event.session;
				return;
			case 'sync-progress':
				this.session = {
					...this.session,
					sync: {
						chatsSynced: event.chatsSynced,
						messagesSynced: event.messagesSynced,
						complete: event.complete
					}
				};
				// The counters are cumulative; a rise means the batch actually wrote
				// chat or message rows that no other event will ever announce.
				if (
					event.chatsSynced > this.#syncedSeen.chats ||
					event.messagesSynced > this.#syncedSeen.messages
				) {
					this.#syncedSeen = { chats: event.chatsSynced, messages: event.messagesSynced };
					this.#scheduleResync();
				}
				return;
			case 'chat-updated':
				this.#mergeChat(event.chat);
				return;
			case 'chat-removed':
				// The two rows were one person all along. Dropping the duplicate is
				// not enough: if the owner is *looking* at it, leaving it selected
				// leaves them staring at a conversation whose messages have just
				// moved elsewhere. Follow the merge into the survivor.
				this.chats = this.chats.filter((c) => c.jid !== event.jid);
				// PL-U3: the server moved this chat's proposals onto the survivor
				// (see `mergeChats`), and no proposal event announces that. Drop the
				// dead jid's rows and refetch rather than leaving cards keyed to a
				// chat that no longer exists.
				if (this.proposals.some((p) => p.chat_jid === event.jid)) {
					this.proposals = this.proposals.filter((p) => p.chat_jid !== event.jid);
					void this.refreshProposals();
				}
				this.#reviewedDraftHash.delete(event.jid);
				if (this.textConflict?.chatJid === event.jid) this.textConflict = null;
				if (this.selectedJid === event.jid) {
					void this.openChat(event.merged_into, { markRead: false });
				}
				return;
			case 'message-new':
				if (event.message.chat_jid === this.selectedJid) {
					this.messages = mergeMessages(this.messages, [event.message]);
				}
				return;
			case 'message-updated':
				// Replace-only. A reaction can land on a message far above the loaded
				// window; merging would insert it mid-stream with a history hole around
				// it. Unknown id → the next page load will carry the update anyway.
				if (event.message.chat_jid !== this.selectedJid) return;
				this.messages = replaceMessage(this.messages, event.message);
				return;
			case 'draft-updated':
				// PL-U3 Half B: read the pin BEFORE settling the generate flag, or an
				// owner-triggered generation and an agent rewrite become
				// indistinguishable here.
				if (event.draft.chat_jid === this.selectedJid) this.#observeDraft(event.draft);
				// The run this owner asked for has produced a row — the card owns the
				// progress display from here (it shimmers on 'drafting').
				this.#settleGenerating(event.draft.chat_jid);
				if (event.draft.chat_jid === this.selectedJid) this.draft = event.draft;
				this.chats = this.chats.map((c) =>
					c.jid === event.draft.chat_jid ? { ...c, draft_status: event.draft.status } : c
				);
				return;
			case 'draft-removed':
				this.#settleGenerating(event.chat_jid);
				// The draft is gone, so there is nothing left to have reviewed.
				this.#reviewedDraftHash.delete(event.chat_jid);
				if (this.textConflict?.chatJid === event.chat_jid) this.textConflict = null;
				if (event.chat_jid === this.selectedJid) this.draft = null;
				this.chats = this.chats.map((c) =>
					c.jid === event.chat_jid ? { ...c, draft_status: null } : c
				);
				return;
			case 'outbox-updated':
				this.#mergeOutbox(event.outbox);
				return;
			case 'proposal-updated':
				this.proposals =
					event.proposal.status === 'pending'
						? [
								...this.proposals.filter((p) => p.id !== event.proposal.id),
								event.proposal
							].sort((a, b) => a.id - b.id)
						: this.proposals.filter((p) => p.id !== event.proposal.id);
				if (
					event.proposal.status !== 'pending' &&
					this.proposalStalePrompt?.proposalId === event.proposal.id
				) {
					this.proposalStalePrompt = null;
				}
				return;
			case 'send-mode':
				this.sendsLive = event.live;
				return;
			case 'agent-part-updated':
				this.#applyAgentPart(event.part, event.delta);
				return;
			case 'client-command':
				this.#applyClientCommand(event.command);
				return;
			default:
				return;
		}
	}

	/**
	 * Accumulate a streaming agent part. Unknown kinds are ignored so a future
	 * server can ship a new kind without crashing older clients. Text rules:
	 * see {@link upsertAgentPart} / {@link mergeAgentText} in shared/.
	 */
	#applyAgentPart(part: AgentPart | { kind: string }, delta?: string): void {
		if (!isKnownAgentPartKind(part.kind)) return;
		const known = part as AgentPart;
		const existing = this.agentSessions[known.sessionId];
		const parts = upsertAgentPart(existing?.parts ?? [], known, delta);
		this.agentSessions = {
			...this.agentSessions,
			[known.sessionId]: { sessionId: known.sessionId, parts }
		};
	}

	/**
	 * Dispatch a closed client-command. Async actions (`openChat`,
	 * `jumpToQuotedMessage`) are fire-and-forget — same pattern as
	 * `chat-removed` already uses for `void this.openChat(...)`. `applyEvent`
	 * stays a synchronous reducer; those methods have their own epoch guards
	 * so a late completion cannot corrupt a chat the owner already left. A
	 * command queue would add ordering complexity without a consumer that
	 * needs to await completion on the wire.
	 */
	#applyClientCommand(command: import('./types.js').ClientCommand): void {
		switch (command.type) {
			case 'open-chat':
				void this.openChat(command.jid);
				return;
			case 'select-reply': {
				const message = this.messages.find((m) => m.id === command.messageId);
				if (message) this.selectReply(message);
				return;
			}
			case 'dismiss-reply':
				this.dismissReply();
				return;
			case 'jump-to-quoted-message':
				void this.jumpToQuotedMessage(command.messageId);
				return;
			default:
				return;
		}
	}

	#mergeChat(chat: Chat): void {
		const index = this.chats.findIndex((c) => c.jid === chat.jid);
		// Field-wise merge, not replace: a payload that is missing keys must not
		// strip `display_jid`/`preview`/`needs_reply` off a row that already has
		// them. The server is the fix (it now always sends a full ChatView); this
		// keeps a partial payload from degrading the list if that ever regresses.
		const merged = index === -1 ? chat : { ...this.chats[index]!, ...chat };
		const next = index === -1 ? [...this.chats, merged] : this.chats.with(index, merged);
		this.chats = next.sort((a, b) => (b.last_msg_at ?? 0) - (a.last_msg_at ?? 0));
	}

	#mergeOutbox(row: OutboxRow): void {
		const index = this.outbox.findIndex((o) => o.id === row.id);
		this.outbox = index === -1 ? [row, ...this.outbox] : this.outbox.with(index, row);
	}
}

function describeError(err: unknown): string {
	if (err instanceof ApiError) return `${err.message} (${err.status})`;
	return err instanceof Error ? err.message : String(err);
}
