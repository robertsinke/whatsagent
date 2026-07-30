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
	import { formatMessageDateTime, formatMessageTime, quotePreview, reactionChip } from '$lib/client/view.js';

	let {
		message,
		senderLabel = null,
		onloadmedia,
		onopenmedia,
		onreply,
		onreact,
		onjumpquote
	}: {
		message: ChatMessage;
		/** Group attribution; null for 1:1, own messages, and mid-run messages. */
		senderLabel?: string | null;
		onloadmedia?: (messageId: string) => void;
		onopenmedia?: (message: ChatMessage) => void;
		onreply?: (message: ChatMessage) => void;
		/** D2 (Wave 3 U2): add/remove a reaction. Empty emoji removes. */
		onreact?: (messageId: string, emoji: string) => void;
		/** U5 — jump to the message this quote references. */
		onjumpquote?: (targetId: string) => void;
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

	const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

	let pickerOpen = $state(false);

	function togglePicker() {
		pickerOpen = !pickerOpen;
	}

	function ownerReactedWith(emoji: string): boolean {
		const chip = message.reactions.find((r) => r.emoji === emoji);
		return Boolean(chip?.actors.some((a) => a.jid === 'me'));
	}

	function pickEmoji(emoji: string) {
		pickerOpen = false;
		// Toggle: if the owner already reacted with this emoji, remove it.
		onreact?.(message.id, ownerReactedWith(emoji) ? '' : emoji);
	}

	function removeReaction(emoji: string) {
		onreact?.(message.id, '');
		void emoji;
	}
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
			{#if onjumpquote}
				<button
					type="button"
					class="quote"
					class:quote-missing={!quote.resolved}
					aria-label={quote.resolved ? `Jump to quoted message from ${quote.sender}: ${quote.body}` : quote.label}
					disabled={!quote.resolved}
					onclick={() => quote.resolved && onjumpquote(quote.targetId)}
					title={quote.resolved ? 'Jump to quoted message' : 'Original message not loaded'}
				>
					<span class="quote-sender">{quote.sender}</span>
					<span class="quote-body">
						{#if QuoteIcon}
							<QuoteIcon class="quote-icon" aria-hidden="true" />
						{/if}
						<span class="quote-body-text">{quote.body}</span>
					</span>
				</button>
			{:else}
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
			{#if onreact}
				<div class="react-popover">
					<button
						class="reply-action"
						type="button"
						aria-expanded={pickerOpen}
						aria-label="React"
						onclick={togglePicker}
					>
						React
					</button>
					{#if pickerOpen}
						<div class="react-picker" role="toolbar" aria-label="Quick reactions">
							{#each QUICK_EMOJIS as emoji (emoji)}
								<button
									class="react-pick"
									type="button"
									aria-label={ownerReactedWith(emoji) ? `Remove ${emoji}` : `React ${emoji}`}
									aria-pressed={ownerReactedWith(emoji)}
									onclick={() => pickEmoji(emoji)}
								>
									{emoji}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			<span class="stamp" title={formatMessageDateTime(message.ts)}>{formatMessageTime(message.ts)}</span>
		</div>
		{#if chips.length > 0}
			<div class="reactions" role="group" aria-label="Reactions">
				{#each chips as chip (chip.emoji)}
					{@const mine = ownerReactedWith(chip.emoji)}
					<button
						class="reaction-chip"
						class:reaction-mine={mine}
						type="button"
						title={chip.label}
						aria-label={mine ? `Remove your ${chip.emoji} reaction` : chip.label}
						aria-pressed={mine}
						onclick={() => (mine ? removeReaction(chip.emoji) : onreact?.(message.id, chip.emoji))}
					>
						<span aria-hidden="true">{chip.emoji}</span>
						{#if chip.count > 1}<span class="reaction-chip-count" aria-hidden="true">{chip.count}</span>{/if}
					</button>
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
	/* Own messages — cobalt-tinted so the largest surface in the app reads as
	   brand, not greyscale. 8% cobalt wash, 22% border, body text stays on
	   --ink-90 for legibility. Pressed, not floating. */
	:global(.bubble-mine) {
		background: color-mix(in srgb, var(--cobalt) 8%, var(--surface-sunken));
		border: 1px solid color-mix(in srgb, var(--cobalt) 22%, var(--hairline));
	}
	.sender {
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--cobalt);
		line-height: 1.2;
	}
	/* Inset, sunken, and rule-marked so quoted context never reads as body text. */
	.quote {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.25rem 0.45rem;
		border-left: 2px solid var(--cobalt);
		border-radius: var(--radius-sm);
		background: var(--quote-tint);
		/* U5 — when rendered as a button (jump-to-quote available), reset button
		   chrome so the inset reads as the same quote, just clickable. */
		text-align: left;
		font: inherit;
		width: 100%;
		cursor: pointer;
	}
	.quote:disabled {
		cursor: default;
	}
	.quote:not(:disabled):hover,
	.quote:not(:disabled):focus-visible {
		background: color-mix(in srgb, var(--cobalt) 10%, var(--quote-tint));
		outline: none;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cobalt) 40%, transparent);
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
	:global(.quote-icon) {
		/* The clamp above needs `display: -webkit-box`, which rules out flexing
		   this row — so space and align the icon inline instead. */
		display: inline;
		vertical-align: -0.15em;
		margin-right: 0.25rem;
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
		color: var(--cobalt);
		text-decoration: underline;
		text-underline-offset: 0.15rem;
	}
	.react-popover {
		position: relative;
	}
	.react-picker {
		position: absolute;
		bottom: 100%;
		right: 0;
		margin-bottom: 0.3rem;
		display: flex;
		gap: 0.15rem;
		padding: 0.2rem 0.25rem;
		background: var(--surface-raised);
		border: 1px solid var(--hairline-soft);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-bevel);
		z-index: 10;
	}
	.react-pick {
		appearance: none;
		border: 0;
		background: transparent;
		padding: 0.1rem 0.2rem;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}
	.react-pick:hover,
	.react-pick:focus-visible {
		background: var(--surface-sunken);
	}
	.react-pick[aria-pressed='true'] {
		background: color-mix(in srgb, var(--cobalt) 15%, transparent);
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
		cursor: pointer;
	}
	.reaction-chip:hover,
	.reaction-chip:focus-visible {
		border-color: var(--cobalt);
	}
	.reaction-mine {
		border-color: var(--cobalt);
		background: color-mix(in srgb, var(--cobalt) 8%, var(--surface-raised));
	}
	.reaction-chip-count {
		font-size: 0.62rem;
		color: var(--ink-70);
	}
</style>
