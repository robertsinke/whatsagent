<script lang="ts">
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import MediaAttachment from './MediaAttachment.svelte';
	import type { Message as ChatMessage } from '$lib/client/types.js';
	import { formatMessageTime } from '$lib/client/view.js';

	let {
		message,
		onloadmedia,
		onopenmedia
	}: {
		message: ChatMessage;
		onloadmedia?: (messageId: string) => void;
		onopenmedia?: (message: ChatMessage) => void;
	} = $props();
</script>

<Message from={message.from_me ? 'user' : 'assistant'} class="bubble-row">
	<MessageContent class={message.from_me ? 'bubble bubble-mine' : 'bubble bubble-theirs'}>
		{#if message.media}
			<MediaAttachment {message} onload={onloadmedia} onopen={onopenmedia} />
		{/if}
		{#if message.text}
			<span class="text">{message.text}</span>
		{:else if !message.media}
			<span class="untyped">{message.type}</span>
		{/if}
		<span class="stamp">{formatMessageTime(message.ts)}</span>
	</MessageContent>
</Message>

<style>
	:global(.bubble-row) {
		max-width: 78%;
	}
	:global(.bubble) {
		border-radius: var(--radius-md);
		padding: 0.45rem 0.65rem;
		gap: 0.35rem;
	}
	:global(.bubble-theirs) {
		background: var(--surface-raised);
		border: 1px solid var(--hairline-soft);
		box-shadow: var(--shadow-bevel);
	}
	/* Own messages get the sunken treatment — pressed, not floating. */
	:global(.bubble-mine) {
		background: var(--surface-sunken);
		border: 1px solid var(--hairline);
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--ink-90);
		line-height: 1.4;
	}
	.untyped {
		font-style: italic;
		color: var(--ink-50);
		font-size: 0.78rem;
	}
	.stamp {
		align-self: flex-end;
		font-size: 0.62rem;
		color: var(--ink-50);
		line-height: 1;
	}
</style>
