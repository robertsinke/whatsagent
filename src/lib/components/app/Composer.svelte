<script lang="ts">
	import { tick } from 'svelte';
	import { CornerDownLeft, X } from '@lucide/svelte';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { senderLabel } from '$lib/client/view.js';
	import type { CalendarProposal, Draft, Message, RefinementIntent, SendProposal } from '$lib/client/types.js';
	import type {
		ProposalStalePrompt,
		StalePrompt,
		TextConflictPrompt
	} from '$lib/client/state.svelte.js';
	import DraftStatus from './DraftStatus.svelte';
	import CalendarProposalCard from './CalendarProposalCard.svelte';
	import ProposalCard from './ProposalCard.svelte';

	let {
		value = $bindable(''),
		disabled = false,
		placeholder = 'Write a reply…',
		replyTo = null,
		ondismissreply,
		onsend,
		draft = null,
		stalePrompt = null,
		textConflict = null,
		proposals = [],
		calendarProposals = [],
		proposalChatName = null,
		proposalTargetText = null,
		proposalStalePrompt = null,
		decidingProposalId = null,
		decidingCalendarProposalId = null,
		agentEligible = false,
		refining = false,
		refineError = null,
		generating = false,
		generateError = null,
		hasMessages = true,
		focusNonce = 0,
		onapprove,
		onskip,
		onconfirmstale,
		ondismissstale,
		onreviewchange,
		ondismisschange,
		onconfirmproposal,
		onrejectproposal,
		onconfirmcalendarproposal,
		onrejectcalendarproposal,
		onrefine,
		ongenerate
	}: {
		value?: string;
		disabled?: boolean;
		placeholder?: string;
		replyTo?: Message | null;
		ondismissreply?: () => void;
		onsend?: (text: string) => boolean | void | Promise<boolean | void>;
		draft?: Draft | null;
		stalePrompt?: StalePrompt | null;
		textConflict?: TextConflictPrompt | null;
		/** PANEL-S6 — agent proposals (send or reaction) awaiting this owner's decision. */
		proposals?: SendProposal[];
		/** CAL-2 — calendar event proposals awaiting confirmation. */
		calendarProposals?: CalendarProposal[];
		/** Display name for the open chat — reaction cards show which chat. */
		proposalChatName?: string | null;
		/** Resolve a message id to preview text for reaction cards. */
		proposalTargetText?: ((messageId: string) => string | null) | null;
		proposalStalePrompt?: ProposalStalePrompt | null;
		decidingProposalId?: number | null;
		decidingCalendarProposalId?: number | null;
		agentEligible?: boolean;
		refining?: boolean;
		refineError?: string | null;
		generating?: boolean;
		generateError?: string | null;
		hasMessages?: boolean;
		/** Bump after starting a chat so the composer takes keyboard focus. */
		focusNonce?: number;
		onapprove?: (text?: string) => boolean | void | Promise<boolean | void>;
		onskip?: () => void;
		onconfirmstale?: (text?: string) => boolean | void | Promise<boolean | void>;
		ondismissstale?: () => void;
		onreviewchange?: () => void;
		ondismisschange?: () => void;
		onconfirmproposal?: (id: number) => void | Promise<unknown>;
		onrejectproposal?: (id: number) => void | Promise<unknown>;
		onconfirmcalendarproposal?: (id: number) => void | Promise<unknown>;
		onrejectcalendarproposal?: (id: number) => void | Promise<unknown>;
		onrefine?: (intent: RefinementIntent, text?: string) => Promise<Draft | null>;
		ongenerate?: () => void | Promise<unknown>;
	} = $props();

	let busy = $state(false);
	let textareaEl: HTMLTextAreaElement | null = $state(null);

	$effect(() => {
		if (focusNonce === 0) return;
		void tick().then(() => textareaEl?.focus());
	});
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
	async function submit() {
		const trimmed = value.trim();
		if (!trimmed || disabled || busy) return;
		busy = true;
		try {
			const sent = await onsend?.(trimmed);
			if (sent !== false) value = '';
		} finally {
			busy = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		if (disabled || busy) return;
		(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		await submit();
	}
</script>

<!--
  One composer surface: draft state is the upper extension, input is the lower
  region. DraftStatus keeps approve / skip / refine / stale re-confirm / generate
  behaviour; this shell only owns the shared border.
-->
<div class="composer">
	<!--
	  PL-U3: proposals sit above the draft card because they are the newer claim
	  on the owner's attention, and because confirming one is a send.
	-->
	{#each calendarProposals as proposal (proposal.id)}
		<CalendarProposalCard
			{proposal}
			deciding={decidingCalendarProposalId === proposal.id}
			onconfirm={() => onconfirmcalendarproposal?.(proposal.id)}
			onreject={() => onrejectcalendarproposal?.(proposal.id)}
		/>
	{/each}
	{#each proposals as proposal (proposal.id)}
		<ProposalCard
			{proposal}
			chatName={proposalChatName}
			targetMessageText={
				proposal.kind === 'reaction' && proposal.reaction_target_msg_id
					? (proposalTargetText?.(proposal.reaction_target_msg_id) ?? null)
					: null
			}
			stale={proposalStalePrompt?.proposalId === proposal.id}
			deciding={decidingProposalId === proposal.id}
			onconfirm={() => onconfirmproposal?.(proposal.id)}
			onreject={() => onrejectproposal?.(proposal.id)}
		/>
	{/each}
	<DraftStatus
		{draft}
		{stalePrompt}
		{textConflict}
		{agentEligible}
		{refining}
		{refineError}
		{generating}
		{generateError}
		{hasMessages}
		{onapprove}
		{onskip}
		{onconfirmstale}
		{ondismissstale}
		{onreviewchange}
		{ondismisschange}
		{onrefine}
		{ongenerate}
	/>
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
	<form class="composer-input w-full" onsubmit={handleSubmit}>
		<InputGroup.Root class="composer-field">
			<div class="contents">
				<InputGroup.Textarea
					class="field-sizing-content max-h-48 min-h-16"
					name="message"
					data-testid="composer-input"
					bind:ref={textareaEl}
					{placeholder}
					{disabled}
					bind:value
					onkeydown={handleKeydown}
				/>
			</div>
			<InputGroup.Addon align="block-end" class="justify-end gap-1">
				<InputGroup.Button
					aria-label="Submit"
					size="icon-sm"
					type="submit"
					variant="default"
					class="send-hero"
					{disabled}
				>
					{#if busy}
						<Spinner />
					{:else}
						<CornerDownLeft class="size-4" />
					{/if}
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>
</div>

<style>
	/* No surface of its own: the composer is part of the conversation card, so a
	   bordered box here was a card inside a card. The hairline above it is the
	   only separation it needs. */
	.composer {
		border-top: 1px solid var(--hairline-soft);
		border-radius: 0;
		padding: 0.5rem 0.5rem 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.composer-input :global(textarea) {
		font-size: 0.88rem;
	}
	/* The composer field is cut into the raised conversation surface — a shallow
	   well (sunken fill + hairline + inset shadow), not a bordered card floating
	   on it. Focus deepens the well with the cobalt inner glow instead of the
	   shadcn outer ring, which reads as pasted on top of this surface language.
	   The InputGroup's own border/ring classes are neutralised here. */
	.composer-input :global(.composer-field) {
		background: var(--surface-sunken);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-pressed);
		transition: box-shadow 140ms ease, border-color 140ms ease;
	}
	.composer-input :global(.composer-field:focus-within) {
		border-color: color-mix(in srgb, var(--ring) 45%, var(--hairline));
		box-shadow: var(--shadow-focus);
		--tw-ring-shadow: 0 0 #0000;
	}
	.composer-input :global(.composer-field[data-slot='input-group']:focus-within) {
		outline: none;
	}
	/* P1.2: the one hero control gets a cobalt-700→600 gradient so the brand
	   appears on the single most-touched affordance. The class is handed to a
	   catalog component, so it lives under :global() — the scoper can't see it. */
	:global(.send-hero) {
		background-image: linear-gradient(135deg, var(--cobalt-700), var(--cobalt-600));
	}
	:global(.send-hero:disabled) {
		background-image: none;
	}
	.reply-context {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.45rem;
		border-left: 2px solid var(--cobalt);
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
	   keeps usable space. The outbox invariant lives on OutboxTray's
	   Sheet.Description — this input still grows with content. */
	@media (max-height: 640px) {
		.composer {
			padding: 0.35rem 0.35rem 0.25rem;
		}
		.composer-input :global(textarea) {
			min-height: 2.4rem;
		}
	}
</style>
