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
		onloadolder,
		onloadmedia,
		onopenmedia,
		onreply
	}: {
		chatJid: string;
		/** From the server's chat row — never sniffed from the JID suffix here. */
		chatKind?: ChatKind;
		messages: Message[];
		hasMore?: boolean;
		unreadBoundary?: UnreadBoundary | null;
		onloadolder?: () => void | Promise<void>;
		onloadmedia?: (messageId: string) => void;
		onopenmedia?: (message: Message) => void;
		onreply?: (message: Message) => void;
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

</script>

<!-- `margin-top: auto` anchors a short thread to the bottom without the
     flex-end scroll-clipping bug. -->
<div class="stream">
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
		<MessageBubble
			message={row.message}
			senderLabel={row.senderLabel}
			{onloadmedia}
			{onopenmedia}
			{onreply}
		/>
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
</style>
