<script lang="ts">
	import { AlertTriangle, Check, Send, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { SendProposal } from '$lib/client/types.js';

	/**
	 * PL-U3 — the owner's half of the permission channel.
	 *
	 * The agent asked to send this text; nothing is queued and nothing will be
	 * unless the button below is clicked. The full text is rendered rather than
	 * summarised on purpose: the click authorises exactly what is on screen, and
	 * a truncated preview would make that claim untrue.
	 */
	let {
		proposal,
		stale = false,
		deciding = false,
		onconfirm,
		onreject
	}: {
		proposal: SendProposal;
		/** Server refused a first confirmation because newer inbound arrived. */
		stale?: boolean;
		deciding?: boolean;
		onconfirm?: () => void | Promise<unknown>;
		onreject?: () => void | Promise<unknown>;
	} = $props();
</script>

<div class="proposal" class:stale>
	<div class="proposal-head">
		{#if stale}
			<AlertTriangle class="size-3.5" />
			<span class="proposal-title">New message arrived after the agent wrote this</span>
		{:else}
			<Send class="size-3.5" />
			<span class="proposal-title">The agent wants to send this</span>
		{/if}
	</div>
	<p class="proposal-text">{proposal.text}</p>
	<p class="proposal-note">
		{#if stale}
			Re-read the thread. Sending now replies to an older message.
		{:else}
			Nothing is queued until you send it.
		{/if}
	</p>
	<div class="proposal-actions">
		<Button size="sm" onclick={() => onconfirm?.()} disabled={deciding}>
			<Check class="size-3.5" />
			{stale ? 'Send anyway' : 'Send this'}
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
