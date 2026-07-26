import { api } from './api.js';
import { createRealtime, type Realtime } from './ws.svelte.js';
import {
	ApiError,
	type Chat,
	type Draft,
	type Message,
	type OutboxRow,
	type SessionView
} from './types.js';
import {
	deriveUnreadBoundary,
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
	outbox = $state<OutboxRow[]>([]);
	loadingMessages = $state(false);
	/** False once a page comes back short — otherwise "load earlier" never ends. */
	hasMoreMessages = $state(false);
	stalePrompt = $state<StalePrompt | null>(null);
	/**
	 * One "New" marker for the open chat, derived from the unread count captured
	 * *before* `markRead` zeroed it. Marking read must not erase the boundary the
	 * owner is still reading against, so this is latched, not reactive: it is
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
		const unreadBeforeOpen = this.chats.find((c) => c.jid === jid)?.unread ?? 0;
		this.selectedJid = jid;
		this.loadingMessages = true;
		this.stalePrompt = null;
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
				this.unreadBoundary = deriveUnreadBoundary(this.messages, unreadBeforeOpen);
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
			this.unreadBoundary = deriveUnreadBoundary(this.messages, this.#unreadAtOpen);
		}
	}

	/** Composer send — goes to the outbox, never to WhatsApp directly (R9). */
	async send(text: string): Promise<boolean> {
		const jid = this.selectedJid;
		if (!jid || !text.trim()) return false;
		try {
			const row = await api.send(jid, text.trim());
			this.#mergeOutbox(row);
			return true;
		} catch (err) {
			this.error = describeError(err);
			return false;
		}
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

	async cancelOutbox(id: number): Promise<void> {
		try {
			this.#mergeOutbox(await api.cancelOutbox(id));
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
