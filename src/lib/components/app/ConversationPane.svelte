<script lang="ts">
	import {
		Conversation,
		ConversationContent,
		ConversationScrollButton
	} from '$lib/components/ai-elements/conversation/index.js';
	import MessageBubble from './MessageBubble.svelte';
	import Lightbox from './Lightbox.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { MessagesSquare } from '@lucide/svelte';
	import type { Message } from '$lib/client/types.js';

	let {
		messages,
		loading = false,
		hasMore = true,
		onloadolder,
		onloadmedia
	}: {
		messages: Message[];
		loading?: boolean;
		hasMore?: boolean;
		onloadolder?: () => void;
		onloadmedia?: (messageId: string) => void;
	} = $props();

	let lightboxMessage = $state<Message | null>(null);

	function dayLabel(ts: number): string {
		return new Date(ts).toLocaleDateString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'short'
		});
	}

	function isNewDay(index: number): boolean {
		if (index === 0) return true;
		const previous = messages[index - 1]!;
		const current = messages[index]!;
		return new Date(previous.ts).toDateString() !== new Date(current.ts).toDateString();
	}
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
			<!-- `margin-top: auto` anchors a short thread to the bottom without the
			     flex-end scroll-clipping bug. -->
			<div class="stream">
				{#if hasMore}
					<div class="older">
						<Button variant="ghost" size="sm" onclick={() => onloadolder?.()}>
							Load earlier messages
						</Button>
					</div>
				{/if}
				{#each messages as message, index (message.id)}
					{#if isNewDay(index)}
						<div class="day"><span>{dayLabel(message.ts)}</span></div>
					{/if}
					<MessageBubble
						{message}
						onloadmedia={onloadmedia}
						onopenmedia={(m) => (lightboxMessage = m)}
					/>
				{/each}
			</div>
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
	.stream {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
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
</style>
