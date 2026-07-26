<script lang="ts">
	import {
		Conversation,
		ConversationContent,
		ConversationScrollButton
	} from '$lib/components/ai-elements/conversation/index.js';
	import ConversationStream from './ConversationStream.svelte';
	import Lightbox from './Lightbox.svelte';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { MessagesSquare } from '@lucide/svelte';
	import type { Message } from '$lib/client/types.js';
	import type { UnreadBoundary } from '$lib/client/view.js';

	let {
		chatJid,
		messages,
		loading = false,
		hasMore = true,
		unreadBoundary = null,
		onloadolder,
		onloadmedia
	}: {
		chatJid: string;
		messages: Message[];
		loading?: boolean;
		hasMore?: boolean;
		unreadBoundary?: UnreadBoundary | null;
		onloadolder?: () => void | Promise<void>;
		onloadmedia?: (messageId: string) => void;
	} = $props();

	let lightboxMessage = $state<Message | null>(null);
</script>

<Conversation class="conv">
	<ConversationContent class="conv-content">
		{#if loading}
			<div class="loading"><Spinner /> Loading conversation…</div>
		{:else if messages.length === 0}
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon"><MessagesSquare class="size-5" /></Empty.Media>
					<Empty.Title>No messages yet</Empty.Title>
					<Empty.Description>Say something to start this conversation.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<ConversationStream
				{chatJid}
				{messages}
				{hasMore}
				{unreadBoundary}
				{onloadolder}
				{onloadmedia}
				onopenmedia={(m) => (lightboxMessage = m)}
			/>
		{/if}
	</ConversationContent>
	<ConversationScrollButton />
</Conversation>

<Lightbox bind:message={lightboxMessage} />

<style>
	:global(.conv) {
		flex: 1;
		min-height: 0;
	}
	:global(.conv-content) {
		gap: 0.35rem;
		padding: 0.75rem 0.9rem;
	}
	.loading {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ink-50);
		font-size: 0.82rem;
		justify-content: center;
		padding: 2rem 0;
	}
</style>
