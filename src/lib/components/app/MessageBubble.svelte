<script lang="ts">
	import {
		Contact as ContactIcon,
		FileText as DocumentIcon,
		Image as ImageIcon,
		MapPin as LocationIcon,
		Mic as AudioIcon,
		Sticker as StickerIcon,
		Video as VideoIcon,
		type LucideIcon
	} from '@lucide/svelte';
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import MediaAttachment from './MediaAttachment.svelte';
	import type { Message as ChatMessage } from '$lib/client/types.js';
	import { formatMessageTime, quotePreview, reactionChip } from '$lib/client/view.js';

	let {
		message,
		senderLabel = null,
		onloadmedia,
		onopenmedia,
		onreply
	}: {
		message: ChatMessage;
		/** Group attribution; null for 1:1, own messages, and mid-run messages. */
		senderLabel?: string | null;
		onloadmedia?: (messageId: string) => void;
		onopenmedia?: (message: ChatMessage) => void;
		onreply?: (message: ChatMessage) => void;
	} = $props();

	// Per-subtype preview icon. `text` and unrecognized subtypes render no icon —
	// the body already carries the words.
	const QUOTE_ICONS: Partial<Record<string, LucideIcon>> = {
		image: ImageIcon,
		video: VideoIcon,
		audio: AudioIcon,
		document: DocumentIcon,
		sticker: StickerIcon,
		location: LocationIcon,
		contact: ContactIcon
	};

	const quote = $derived(message.quote ? quotePreview(message.quote) : null);
	const QuoteIcon = $derived(quote ? QUOTE_ICONS[quote.kind] ?? null : null);
	const chips = $derived(message.reactions.map(reactionChip));
</script>

<Message from={message.from_me ? 'user' : 'assistant'} class="bubble-row">
	<MessageContent class={message.from_me ? 'bubble bubble-mine' : 'bubble bubble-theirs'}>
		{#if senderLabel}
			<span class="sender">{senderLabel}</span>
		{/if}
		{#if quote}
			<!-- Static from persisted fields: no fetch, no image, so the bubble
			     reaches its final height on first paint (U1 prepend anchoring). -->
			<!-- `note`, not a bare div: an aria-label on a generic element is not
			     reliably announced, and this is ancillary context, not body text. -->
			<div
				class="quote"
				class:quote-missing={!quote.resolved}
				role="note"
				aria-label={quote.label}
			>
				<span class="quote-sender">{quote.sender}</span>
				<span class="quote-body">
					{#if QuoteIcon}
						<QuoteIcon class="quote-icon" aria-hidden="true" />
					{/if}
					<span class="quote-body-text">{quote.body}</span>
				</span>
			</div>
		{/if}
		{#if message.media}
			<MediaAttachment {message} onload={onloadmedia} onopen={onopenmedia} />
		{/if}
		{#if message.text}
			<span class="text">{message.text}</span>
		{:else if !message.media}
			<span class="untyped">{message.type}</span>
		{/if}
		<div class="meta">
			<button class="reply-action" type="button" onclick={() => onreply?.(message)}>
				Reply
			</button>
			<span class="stamp">{formatMessageTime(message.ts)}</span>
		</div>
		{#if chips.length > 0}
			<!-- Display-only: reactions are rendered, never created, in this wave —
			     so these are not buttons and expose actors through their label. -->
			<div class="reactions" role="group" aria-label="Reactions">
				{#each chips as chip (chip.emoji)}
					<!-- `img` is the standard role for an emoji that carries meaning; it
					     takes the label reliably and stays non-interactive. -->
					<span class="reaction-chip" role="img" title={chip.label} aria-label={chip.label}>
						<span aria-hidden="true">{chip.emoji}</span>
						{#if chip.count > 1}<span class="reaction-chip-count" aria-hidden="true">{chip.count}</span>{/if}
					</span>
				{/each}
			</div>
		{/if}
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
	.sender {
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--terracotta);
		line-height: 1.2;
	}
	/* Inset, sunken, and rule-marked so quoted context never reads as body text. */
	.quote {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.25rem 0.45rem;
		border-left: 2px solid var(--terracotta);
		border-radius: var(--radius-sm);
		background: var(--quote-tint);
	}
	.quote-missing {
		border-left-style: dashed;
		border-left-color: var(--ink-50);
	}
	.quote-sender {
		font-size: 0.66rem;
		font-weight: 600;
		color: var(--ink-70);
	}
	.quote-body {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.72rem;
		color: var(--ink-50);
		line-height: 1.3;
		/* Clamp instead of wrap: a long quote must not out-size its own message. */
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.quote-body-text {
		/* Inline-flex inside a -webkit-box clamp needs a block child to clip. */
		min-width: 0;
	}
	:global(.quote-icon) {
		flex: none;
		width: 0.85rem;
		height: 0.85rem;
		color: var(--ink-50);
	}
	.quote-missing .quote-body {
		font-style: italic;
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
		font-size: 0.62rem;
		color: var(--ink-50);
		line-height: 1;
	}
	.meta {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.45rem;
		min-height: 0.9rem;
	}
	.reply-action {
		appearance: none;
		border: 0;
		background: transparent;
		padding: 0;
		font: inherit;
		font-size: 0.62rem;
		line-height: 1;
		color: var(--ink-50);
		cursor: pointer;
	}
	.reply-action:hover,
	.reply-action:focus-visible {
		color: var(--terracotta);
		text-decoration: underline;
		text-underline-offset: 0.15rem;
	}
	.reactions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem;
		margin-top: -0.15rem;
	}
	.reaction-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		background: var(--surface-raised);
		border: 1px solid var(--hairline-soft);
		box-shadow: var(--shadow-bevel);
		font-size: 0.72rem;
		line-height: 1.35;
		/* No hover/press state and no cursor change: not an affordance. */
		cursor: default;
	}
	.reaction-chip-count {
		font-size: 0.62rem;
		color: var(--ink-70);
	}
</style>
