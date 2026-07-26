<script lang="ts">
	import PromptInput from '$lib/components/ai-elements/prompt-input.svelte';
	import { X } from '@lucide/svelte';
	import { senderLabel } from '$lib/client/view.js';
	import type { Message } from '$lib/client/types.js';

	let {
		value = $bindable(''),
		disabled = false,
		placeholder = 'Write a reply…',
		replyTo = null,
		ondismissreply,
		onsend
	}: {
		value?: string;
		disabled?: boolean;
		placeholder?: string;
		replyTo?: Message | null;
		ondismissreply?: () => void;
		onsend?: (text: string) => boolean | void | Promise<boolean | void>;
	} = $props();

	let busy = $state(false);
	const replyAuthor = $derived(
		replyTo ? (replyTo.from_me ? 'You' : senderLabel(replyTo.sender)) : ''
	);
	const replyBody = $derived(replyTo ? replyTo.text?.trim() || messageTypeLabel(replyTo.type) : '');

	function messageTypeLabel(type: string): string {
		switch (type) {
			case 'image':
				return 'Photo';
			case 'video':
				return 'Video';
			case 'audio':
				return 'Voice message';
			case 'document':
				return 'Document';
			case 'sticker':
				return 'Sticker';
			default:
				return 'Message';
		}
	}

	/**
	 * R9: this hands text to the API, which enqueues an outbox row. There is no
	 * path from the UI to WhatsApp's send function — the pacer is the only sender.
	 */
	async function submit({ text }: { text: string }) {
		const trimmed = text.trim();
		if (!trimmed || disabled || busy) return;
		busy = true;
		try {
			const sent = await onsend?.(trimmed);
			if (sent !== false) value = '';
		} finally {
			busy = false;
		}
	}
</script>

<div class="composer neumorphic-raised">
	{#if replyTo}
		<div class="reply-context" role="note" aria-label={`Replying to ${replyAuthor}: ${replyBody}`}>
			<div class="reply-copy">
				<span class="reply-author">Replying to {replyAuthor}</span>
				<span class="reply-body">{replyBody}</span>
			</div>
			<button
				class="reply-dismiss"
				type="button"
				onclick={() => ondismissreply?.()}
				aria-label="Cancel reply"
			>
				<X class="size-3.5" />
			</button>
		</div>
	{/if}
	<PromptInput
		bind:value
		{placeholder}
		status={busy ? 'submitted' : 'ready'}
		onsubmit={submit}
		class="composer-input"
	/>
	<p class="hint">Typed sends go immediately through the outbox — nothing bypasses it.</p>
</div>

<style>
	.composer {
		border-radius: var(--radius-md);
		padding: 0.5rem 0.5rem 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	:global(.composer-input textarea) {
		font-size: 0.88rem;
	}
	.hint {
		margin: 0;
		font-size: 0.66rem;
		color: var(--ink-50);
		padding-left: 0.2rem;
	}
	.reply-context {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.45rem;
		border-left: 2px solid var(--terracotta);
		border-radius: var(--radius-sm);
		background: var(--quote-tint);
	}
	.reply-copy {
		min-width: 0;
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.05rem;
	}
	.reply-author {
		font-size: 0.66rem;
		font-weight: 600;
		color: var(--ink-70);
	}
	.reply-body {
		font-size: 0.72rem;
		color: var(--ink-50);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.reply-dismiss {
		appearance: none;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--ink-50);
		padding: 0.2rem;
		cursor: pointer;
	}
	.reply-dismiss:hover,
	.reply-dismiss:focus-visible {
		background: var(--surface-sunken);
		color: var(--ink-90);
	}
	/* Short viewports: shrink the composer's resting height so the conversation
	   keeps usable space. The outbox hint stays — it states an invariant, not a
	   decoration — and the input still grows with content. */
	@media (max-height: 640px) {
		.composer {
			padding: 0.35rem 0.35rem 0.25rem;
		}
		:global(.composer-input textarea) {
			min-height: 2.4rem;
		}
	}
</style>
