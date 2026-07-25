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
import { mergeMessages } from './view.js';

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
	error = $state<string | null>(null);

	#realtime: Realtime | undefined;
	#conversationEpoch = 0;

	get connected(): boolean {
		return this.#realtime?.connected ?? false;
	}

	get selectedChat(): Chat | null {
		return this.chats.find((c) => c.jid === this.selectedJid) ?? null;
	}

	start(): void {
		this.#realtime = createRealtime({
			onEvent: (event) => this.#apply(event),
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

	async openChat(jid: string, options: { markRead?: boolean } = {}): Promise<void> {
		const epoch = ++this.#conversationEpoch;
		this.selectedJid = jid;
		this.loadingMessages = true;
		this.stalePrompt = null;
		try {
			const messages = await api.messages(jid, { limit: PAGE_SIZE });
			if (epoch !== this.#conversationEpoch || this.selectedJid !== jid) return;
			this.messages = mergeMessages([], messages);
			this.hasMoreMessages = messages.length >= PAGE_SIZE;
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
	async approveDraft(text?: string): Promise<void> {
		const jid = this.selectedJid;
		if (!jid) return;
		try {
			const { outbox, draft } = await api.approveDraft(jid, text);
			this.#mergeOutbox(outbox);
			this.draft = draft;
			this.stalePrompt = null;
		} catch (err) {
			if (err instanceof ApiError && err.status === 409) {
				const stalePrompt = {
					chatJid: jid,
					basisMsgId: (err.body.basis_msg_id as string) ?? null,
					latestInboundId: (err.body.latest_inbound_id as string) ?? null
				};
				await this.openChat(jid, { markRead: false });
				if (this.selectedJid === jid) this.stalePrompt = stalePrompt;
				return;
			}
			this.error = describeError(err);
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
			this.messages = this.messages.map((m) => (m.id === updated.id ? updated : m));
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

	#apply(event: import('./types.js').ServerEvent): void {
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
