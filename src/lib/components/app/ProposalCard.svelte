<script lang="ts">
	import { AlertTriangle, Check, Send, SmilePlus, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { SendProposal } from '$lib/client/types.js';

	/**
	 * PANEL-S6 — the owner's half of the permission channel.
	 *
	 * The agent asked to put something on the wire (a send, or a reaction);
	 * nothing is queued and nothing will be unless the button below is clicked.
	 * Send proposals render the full text; reaction proposals render chat,
	 * target message, and emoji so the click authorises exactly what is on
	 * screen.
	 */
	let {
		proposal,
		chatName = null,
		targetMessageText = null,
		stale = false,
		deciding = false,
		onconfirm,
		onreject
	}: {
		proposal: SendProposal;
		/** Display name of the chat this proposal targets (reaction cards). */
		chatName?: string | null;
		/** Preview of the message being reacted to, when known. */
		targetMessageText?: string | null;
		/** Server refused a first confirmation because newer inbound arrived. */
		stale?: boolean;
		deciding?: boolean;
		onconfirm?: () => void | Promise<unknown>;
		onreject?: () => void | Promise<unknown>;
	} = $props();

	const isReaction = $derived(proposal.kind === 'reaction');
	const emoji = $derived(proposal.reaction_emoji ?? '');
	const targetId = $derived(proposal.reaction_target_msg_id ?? '');
</script>

<div class="proposal" class:stale class:reaction={isReaction}>
	<div class="proposal-head">
		{#if stale}
			<AlertTriangle class="size-3.5" />
			<span class="proposal-title">New message arrived after the agent wrote this</span>
		{:else if isReaction}
			<SmilePlus class="size-3.5" />
			<span class="proposal-title">The agent wants to react</span>
		{:else}
			<Send class="size-3.5" />
			<span class="proposal-title">The agent wants to send this</span>
		{/if}
	</div>

	{#if isReaction}
		<div class="reaction-body" data-testid="proposal-reaction">
			<span class="reaction-emoji" aria-label={`React with ${emoji || 'no emoji'}`}>{emoji || '∅'}</span>
			<div class="reaction-meta">
				{#if chatName}
					<p class="reaction-chat">in <strong>{chatName}</strong></p>
				{/if}
				<p class="reaction-target">
					{#if targetMessageText}
						on “{targetMessageText}”
					{:else if targetId}
						on message <code>{targetId}</code>
					{:else}
						on an unknown message
					{/if}
				</p>
			</div>
		</div>
	{:else}
		<p class="proposal-text">{proposal.text}</p>
	{/if}

	<p class="proposal-note">
		{#if stale}
			Re-read the thread. Sending now replies to an older message.
		{:else}
			Nothing is queued until you confirm.
		{/if}
	</p>
	<div class="proposal-actions">
		<Button size="sm" onclick={() => onconfirm?.()} disabled={deciding}>
			<Check class="size-3.5" />
			{#if stale}
				Send anyway
			{:else if isReaction}
				React
			{:else}
				Send this
			{/if}
		</Button>
		<Button size="sm" variant="outline" onclick={() => onreject?.()} disabled={deciding}>
			<X class="size-3.5" /> Discard
		</Button>
	</div>
</div>

<style>
	.proposal {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	.proposal-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--ink-70);
	}

	.stale .proposal-head {
		color: var(--ink-90);
	}

	.proposal-title {
		letter-spacing: 0.01em;
	}

	.proposal-text {
		margin: 0;
		font-size: 0.86rem;
		line-height: 1.45;
		color: var(--ink-90);
		white-space: pre-wrap;
		padding: 0.35rem 0.45rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--hairline);
		max-height: 9rem;
		overflow-y: auto;
	}

	.reaction-body {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.45rem 0.55rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--hairline);
	}

	.reaction-emoji {
		font-size: 1.75rem;
		line-height: 1;
		min-width: 2rem;
		text-align: center;
	}

	.reaction-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.reaction-chat,
	.reaction-target {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--ink-90);
		overflow-wrap: anywhere;
	}

	.reaction-chat strong {
		font-weight: 600;
	}

	.reaction-target code {
		font-size: 0.75rem;
		color: var(--ink-60);
	}

	.proposal-note {
		margin: 0;
		font-size: 0.75rem;
		color: var(--ink-60);
	}

	.proposal-actions {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
</style>
