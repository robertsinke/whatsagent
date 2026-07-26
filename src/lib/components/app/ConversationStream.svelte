<script lang="ts">
	import { getContext, onDestroy, tick } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import {
		CONVERSATION_CTX,
		type ConversationContext
	} from '$lib/components/ai-elements/conversation/context.js';
	import MessageBubble from './MessageBubble.svelte';
	import { buildStreamRows } from './message-runs.js';
	import type { ChatKind, Message } from '$lib/client/types.js';
	import { unreadBoundaryLabel, type UnreadBoundary } from '$lib/client/view.js';

	let {
		chatJid,
		chatKind = '1:1',
		messages,
		hasMore = true,
		unreadBoundary = null,
		jumpTarget = null,
		onloadolder,
		onloadmedia,
		onopenmedia,
		onreply,
		onreact,
		onjumpquote
	}: {
		chatJid: string;
		/** From the server's chat row — never sniffed from the JID suffix here. */
		chatKind?: ChatKind;
		messages: Message[];
		hasMore?: boolean;
		unreadBoundary?: UnreadBoundary | null;
		/**
		 * U5 — a `{ id, nonce }` signal from AppState. When it changes, the
		 * stream scrolls the matching bubble into view and briefly highlights
		 * it so the jump is legible. `null` (or a chat switch) does nothing.
		 */
		jumpTarget?: { id: string; nonce: number } | null;
		onloadolder?: () => void | Promise<void>;
		onloadmedia?: (messageId: string) => void;
		onopenmedia?: (message: Message) => void;
		onreply?: (message: Message) => void;
		/** D2 (Wave 3 U2): add/remove a reaction. Empty emoji removes. */
		onreact?: (messageId: string, emoji: string) => void;
		/** U5 — jump to a quoted message's target. */
		onjumpquote?: (targetId: string) => void;
	} = $props();

	const rows = $derived(
		buildStreamRows(messages, { isGroup: chatKind === 'group', unreadBoundary })
	);

	// Rendered inside <Conversation>, so the shared scroll viewport stays the one
	// scroll owner — this component only asks it to move.
	const ctx = getContext<ConversationContext>(CONVERSATION_CTX);

	let loadingOlder = $state(false);
	let lastChatJid: string | null = null;
	let lastMessageId: string | null = null;
	// A chat switch tears this component down while the pane shows its loading
	// state; props of a destroyed component keep their last value, so the flag —
	// not the jid — is what proves the capture is still current.
	let destroyed = false;
	onDestroy(() => (destroyed = true));

	/** U5 — id of the bubble currently flashing as a jump target. */
	let highlightedId = $state<string | null>(null);
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	function clearHighlight(): void {
		if (highlightTimer !== null) {
			clearTimeout(highlightTimer);
			highlightTimer = null;
		}
		highlightedId = null;
	}
	onDestroy(clearHighlight);

	/**
	 * Positioning rules, in one place:
	 * - opening a chat (and every chat switch) lands on the newest message;
	 * - a newer message follows the reader down only if they were already at the
	 *   bottom, so reading history is never yanked;
	 * - prepends change nothing here — `loadOlder` restores the anchor by geometry.
	 */
	$effect(() => {
		const jid = chatJid;
		const newestId = messages.at(-1)?.id ?? null;
		const chatChanged = jid !== lastChatJid;
		const firstPaint = lastMessageId === null;
		const grew = newestId !== null && newestId !== lastMessageId;
		const atBottom = ctx.isAtBottom;

		lastChatJid = jid;
		lastMessageId = newestId;

		if (chatChanged || (grew && firstPaint)) {
			void tick().then(() => ctx.scrollToBottom('instant'));
			return;
		}
		if (grew && atBottom) void tick().then(() => ctx.scrollToBottom('smooth'));
	});

	/**
	 * U5 — jump-to-quote. When AppState sets `jumpTarget`, scroll the matching
	 * bubble into view and flash it briefly. The effect keys on the nonce so a
	 * second click on the same quote re-fires even though `id` is unchanged.
	 *
	 * The target is guaranteed to be in `messages` at this point: AppState's
	 * `jumpToQuotedMessage` fetches a focused page around an off-page target
	 * before setting the signal, so the row is rendered by the time this runs.
	 * If the row is somehow still absent (a race with a chat switch), the effect
	 * is a no-op rather than a crash.
	 */
	$effect(() => {
		const target = jumpTarget;
		if (!target) return;
		// Touch `messages` so this re-runs when a focused-page merge lands.
		const _ = messages.length;
		void _;
		void tick().then(() => {
			if (destroyed || chatJid !== lastChatJid) return;
			const el = streamEl?.querySelector(`[data-msg-id="${cssEscape(target.id)}"]`);
			if (!el) return;
			ctx.scrollToElement(el as HTMLElement, 'smooth');
			clearHighlight();
			highlightedId = target.id;
			highlightTimer = setTimeout(clearHighlight, HIGHLIGHT_MS);
		});
	});

	async function loadOlder() {
		if (loadingOlder) return;
		loadingOlder = true;
		// Geometry captured here describes *this* conversation. If the owner switches
		// chats while the page is in flight, the restore would fight the new chat's
		// open-at-newest scroll with a stale offset — so it is dropped instead.
		const jidAtCapture = chatJid;
		const restoreAnchor = ctx.captureAnchor();
		try {
			await onloadolder?.();
			await tick();
			if (!destroyed && jidAtCapture === chatJid) restoreAnchor();
		} finally {
			loadingOlder = false;
		}
	}

	function dayLabel(ts: number): string {
		return new Date(ts).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'short'
		});
	}

	/** U5 — the stream container, for `querySelector` on a jump target. */
	let streamEl: HTMLElement | null = null;

	/** Highlight duration: long enough to read as "this is what you jumped to". */
	const HIGHLIGHT_MS = 1800;

	/**
	 * Escape a message id for use in a CSS attribute selector. Message ids are
	 * Baileys stanza ids (alnum + a few symbols) and rarely contain selector
	 * metacharacters, but a stray `:` or `.` would break the selector silently —
	 * escape defensively so a jump never no-ops because of an id shape.
	 */
	function cssEscape(value: string): string {
		return value.replace(/["\\]/g, '\\$&');
	}

</script>

<!-- `margin-top: auto` anchors a short thread to the bottom without the
     flex-end scroll-clipping bug. -->
<div class="stream" bind:this={streamEl}>
	{#if hasMore}
		<div class="older">
			<Button variant="ghost" size="sm" onclick={loadOlder} disabled={loadingOlder}>
				{#if loadingOlder}<Spinner class="size-3.5" />{/if}
				{loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
			</Button>
		</div>
	{/if}
	{#each rows as row (row.message.id)}
		{#if row.newDay}
			<div class="day"><span>{dayLabel(row.message.ts)}</span></div>
		{/if}
		{#if row.unreadMarker && unreadBoundary}
			<div class="unread" role="separator" aria-label={unreadBoundaryLabel(unreadBoundary)}>
				<span>{unreadBoundaryLabel(unreadBoundary)}</span>
			</div>
		{/if}
		<div class="bubble-wrap" data-msg-id={row.message.id} class:jump-highlight={highlightedId === row.message.id}>
			<MessageBubble
				message={row.message}
				senderLabel={row.senderLabel}
				{onloadmedia}
				{onopenmedia}
				{onreply}
				{onreact}
				{onjumpquote}
			/>
		</div>
	{/each}
</div>

<style>
	.stream {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.older {
		display: flex;
		justify-content: center;
		padding-bottom: 0.35rem;
	}
	.day {
		display: flex;
		justify-content: center;
		margin: 0.6rem 0 0.35rem;
	}
	.day span {
		font-size: 0.66rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-50);
		background: var(--surface-sunken);
		border: 1px solid var(--hairline-soft);
		border-radius: 999px;
		padding: 0.1rem 0.6rem;
	}
	/* Exactly one of these renders per open chat — it is latched in AppState. */
	.unread {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0 0.3rem;
		color: var(--terracotta);
	}
	.unread::before,
	.unread::after {
		content: '';
		flex: 1;
		height: 1px;
		background: color-mix(in srgb, var(--terracotta) 45%, transparent);
	}
	.unread span {
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
	}
	/* U5 — brief flash on the jump target so the reader sees what they jumped to.
	   One animation, theme-tinted, no persistent state; fades out on its own.

	   The class sits on `.bubble-wrap` (which owns `data-msg-id` and is what the
	   scroll targets), but the flash MUST paint the inner `.bubble`. The wrapper
	   is a full-width block and the row inside it is 78% wide, while the visible
	   bubble is only as wide as its text — so painting the wrapper stretched a
	   pink rectangle hundreds of pixels across empty space and read as though a
	   different message had been selected. `:global()` because `.bubble` belongs
	   to a child component. */
	@keyframes jump-flash {
		0% {
			background: color-mix(in srgb, var(--terracotta) 22%, transparent);
			box-shadow: 0 0 0 2px color-mix(in srgb, var(--terracotta) 55%, transparent);
		}
		100% {
			background: transparent;
			box-shadow: 0 0 0 2px transparent;
		}
	}
	.jump-highlight :global(.bubble) {
		animation: jump-flash 1.8s ease-out 1;
	}
	@media (prefers-reduced-motion: reduce) {
		/* Keep the affordance without motion: a static tint that the class
		   removal clears, so reduced-motion users still see the target. */
		.jump-highlight :global(.bubble) {
			animation: none;
			background: color-mix(in srgb, var(--terracotta) 18%, transparent);
		}
	}
</style>
