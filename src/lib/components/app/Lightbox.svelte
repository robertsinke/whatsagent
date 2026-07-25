<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { api } from '$lib/client/api.js';
	import type { Message } from '$lib/client/types.js';
	import { mediaKind } from '$lib/client/view.js';

	let {
		message = $bindable(null)
	}: { message?: Message | null } = $props();

	const open = $derived(message !== null);
	const src = $derived(message ? api.mediaUrl(message.id) : '');
</script>

<Dialog.Root
	bind:open={() => open, (value) => {
		if (!value) message = null;
	}}
>
	<Dialog.Content class="lightbox">
		<Dialog.Header class="sr-only">
			<Dialog.Title>{message?.media?.filename ?? 'Attachment'}</Dialog.Title>
		</Dialog.Header>
		{#if message && mediaKind(message.type) === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video {src} controls autoplay class="lightbox-media"></video>
		{:else if message}
			<img {src} alt={message.media?.filename ?? 'Photo'} class="lightbox-media" />
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.lightbox) {
		max-width: min(92vw, 1000px);
		padding: 0.75rem;
	}
	.lightbox-media {
		display: block;
		max-width: 100%;
		max-height: 78vh;
		margin: 0 auto;
		border-radius: var(--radius-md);
	}
</style>
