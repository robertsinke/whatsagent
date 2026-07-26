import { api } from './api.js';
import { createRealtime, type Realtime } from './ws.svelte.js';
import {
	ApiError,
	type Chat,
	type Draft,
	type Message,
	type OutboxRow,
	type RefinementIntent,
	type SessionView
} from './types.js';
import {
	deriveUnreadBoundary,
	deriveUnreadBoundaryFromCursor,
	mergeMessages,
	replaceMessage,
	type UnreadBoundary
} from './view.js';

const PAGE_SIZE = 60;

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

	#realtime: Realtime | undefined;
	#conversationEpoch = 0;
	/** Server unread count at the moment this chat was opened. */
	#unreadAtOpen = 0;
	/**
	 * U4 — persisted read cursor snapshotted at open, so the boundary stays put
	 * even after `markRead` advances the server-side cursor. `null` for chats
	 * that have never been opened locally since migration 010; the count-based
	 * {@link deriveUnreadBoundary} is used as the fallback in that case.
	 */
	#cursorAtOpen: string | null = null;

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
	}

	async refresh(): Promise<void> {
		try {
			const [session, chats, outbox] = await Promise.all([
				api.session().catch(() => EMPTY_SESSION),
				api.chats(),
				api.outbox()
			]);
			this.session = session;
			this.chats = chats;
			this.outbox = outbox;
			if (this.selectedJid) await this.openChat(this.selectedJid, { markRead: false });
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
		this.loadingMessages = true;
		this.stalePrompt = null;
		// Refinement error is chat-scoped: a new selection (or same-chat reload)
		// clears it. `refining` is left untouched — an in-flight request is not
		// canceled by a UI reload, and its finally-block clears the flag.
		if (chatChanged) this.refineError = null;
		if (!options.preserveDeepenStatus) {
			this.deepenStatus = { kind: 'idle', at: null };
		}
		try {
			const messages = await api.messages(jid, { limit: PAGE_SIZE });
			if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
			this.messages = mergeMessages([], messages);
			this.hasMoreMessages = messages.length >= PAGE_SIZE;
			if (resnapshotUnread) {
				this.#unreadAtOpen = unreadBeforeOpen;
				this.#cursorAtOpen = cursorBeforeOpen;
				// U4: prefer the persisted cursor. Fall back to the count-based
				// placement for chats that have never been opened locally since
				// migration 010 — the boundary never regresses.
				this.unreadBoundary = cursorBeforeOpen
					? deriveUnreadBoundaryFromCursor(messages, cursorBeforeOpen, unreadBeforeOpen)
					: deriveUnreadBoundary(messages, unreadBeforeOpen);
			}
			const draft = await api.draft(jid).catch(() => null);
			if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
			this.draft = draft;
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
	 * Approve a draft. A 409 means the server saw newer inbound than the draft's
	 * basis message — we surface a re-confirm prompt instead of sending, and we
	 * never decide staleness ourselves.
	 */
	async approveDraft(text?: string): Promise<boolean> {
		const jid = this.selectedJid;
		if (!jid) return false;
		try {
			const { outbox, draft } = await api.approveDraft(jid, text);
			this.#mergeOutbox(outbox);
			this.draft = draft;
			this.stalePrompt = null;
			return true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				const stalePrompt = {
					chatJid: jid,
					basisMsgId: (err.body.basis_msg_id as string) ?? null,
					latestInboundId: (err.body.latest_inbound_id as string) ?? null
				};
				await this.openChat(jid, { markRead: false });
				if (this.selectedJid === jid) this.stalePrompt = stalePrompt;
				return false;
			}
			this.error = describeError(err);
			return false;
		}
	}

	/** Explicit second owner action after the server reports a stale basis. */
	async confirmStaleDraft(text?: string): Promise<boolean> {
		const prompt = this.stalePrompt;
		if (!prompt || this.selectedJid !== prompt.chatJid || !prompt.latestInboundId) return false;
		try {
			const { outbox, draft } = await api.approveDraft(
				prompt.chatJid,
				text,
				prompt.latestInboundId
			);
			this.#mergeOutbox(outbox);
			this.draft = draft;
			this.stalePrompt = null;
			return true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				return this.approveDraft(text);
			}
			this.error = describeError(err);
			return false;
		}
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
	 * Owner-triggered on-demand history deepen for the selected chat. Asks the
	 * server to call Baileys `fetchMessageHistory` for older messages; the
	 * server returns 202 once the request is accepted, and the new (older)
	 * messages arrive over WS as `message-new`/`sync-progress` events and merge
	 * into the open conversation pane like any other inbound.
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
				return;
			case 'chat-updated':
				this.#mergeChat(event.chat);
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
				if (event.draft.chat_jid === this.selectedJid) this.draft = event.draft;
				this.chats = this.chats.map((c) =>
					c.jid === event.draft.chat_jid ? { ...c, draft_status: event.draft.status } : c
				);
				return;
			case 'draft-removed':
				if (event.chat_jid === this.selectedJid) this.draft = null;
				this.chats = this.chats.map((c) =>
					c.jid === event.chat_jid ? { ...c, draft_status: null } : c
				);
				return;
			case 'outbox-updated':
				this.#mergeOutbox(event.outbox);
				return;
			default:
				return;
		}
	}

	#mergeChat(chat: Chat): void {
		const index = this.chats.findIndex((c) => c.jid === chat.jid);
		const next = index === -1 ? [...this.chats, chat] : this.chats.with(index, chat);
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
