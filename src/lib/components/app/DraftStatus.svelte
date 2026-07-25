<script lang="ts">
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { AlertTriangle, Check, Pencil, RotateCw, X } from '@lucide/svelte';
	import type { Draft } from '$lib/client/types.js';
	import type { StalePrompt } from '$lib/client/state.svelte.js';
	import { canApprove, draftBadge } from '$lib/client/view.js';

	let {
		draft,
		stalePrompt = null,
		/** True for 1:1 chats with no draft — the empty-draft hint is only meaningful where the agent is allowed to act. */
		agentEligible = false,
		onedit,
		onapprove,
		onskip,
		onconfirmstale,
		ondismissstale
	}: {
		draft: Draft | null;
		stalePrompt?: StalePrompt | null;
		agentEligible?: boolean;
		onedit?: (text: string) => void;
		onapprove?: () => void;
		onskip?: () => void;
		onconfirmstale?: () => void;
		ondismissstale?: () => void;
	} = $props();

	const badge = $derived(draft ? draftBadge(draft.status) : null);
</script>

{#if stalePrompt}
	<!--
	  The server returned 409: newer inbound arrived after the draft's basis
	  message. Approval must be re-confirmed against the refreshed conversation —
	  the client never decides this itself.
	-->
	<div class="draft stale">
		<div class="draft-head">
			<AlertTriangle class="size-3.5" />
			<span class="draft-title">New message arrived while you were reading</span>
		</div>
		<p class="draft-note">
			This draft answered an earlier message. Re-read the thread, then approve again if it still
			fits.
		</p>
		<div class="draft-actions">
			<Button size="sm" onclick={() => onconfirmstale?.()}>
				<Check class="size-3.5" /> Queue this draft anyway
			</Button>
			<Button size="sm" variant="outline" onclick={() => ondismissstale?.()}>
				<X class="size-3.5" /> Cancel
			</Button>
		</div>
	</div>
{:else if draft}
	<div class="draft">
		<div class="draft-head">
			<Pencil class="size-3.5" />
			<span class="draft-title">Draft</span>
			{#if badge}
				<Badge variant="secondary" class="draft-badge">{badge.label}</Badge>
			{/if}
			{#if draft.provider}
				<span class="draft-provider">{draft.provider}</span>
			{/if}
		</div>

		{#if draft.status === 'drafting'}
			<Shimmer children="Drafting a reply…" class="draft-shimmer" />
		{:else}
			<p class="draft-text">{draft.text}</p>
		{/if}

		<div class="draft-actions">
			<Button size="sm" onclick={() => onapprove?.()} disabled={!canApprove(draft.status)}>
				<Check class="size-3.5" /> Approve &amp; queue
			</Button>
			<Button size="sm" variant="outline" onclick={() => onedit?.(draft.text)}>
				<Pencil class="size-3.5" /> Edit in composer
			</Button>
			<Button size="sm" variant="ghost" onclick={() => onskip?.()}>
				<X class="size-3.5" /> Skip
			</Button>
			{#if draft.status === 'failed'}
				<span class="draft-note">
					<RotateCw class="size-3" /> Drafting failed — the agent waits for the next inbound
					to retry, or you can reply yourself any time.
				</span>
			{/if}
		</div>
	</div>
{:else if agentEligible}
	<div class="draft muted">
		<div class="draft-head">
			<Pencil class="size-3.5" />
			<span class="draft-title">No draft</span>
		</div>
		<p class="draft-note">
			The agent will draft here once the latest inbound settles (about a minute after the last
			message). Type your own reply any time — nothing sends without you.
		</p>
	</div>
{/if}

<style>
	.draft {
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--lime) 35%, var(--hairline));
		background: color-mix(in srgb, var(--lime) 10%, var(--surface-raised));
		padding: 0.55rem 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.draft.muted {
		border-color: var(--hairline-soft);
		background: var(--surface-raised);
	}
	.draft.stale {
		border-color: color-mix(in srgb, var(--terracotta) 45%, var(--hairline));
		background: color-mix(in srgb, var(--terracotta) 8%, var(--surface-raised));
	}
	.draft-head {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--ink-70);
	}
	.draft-title {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.draft-provider {
		margin-left: auto;
		font-size: 0.66rem;
		color: var(--ink-50);
	}
	.draft-text {
		margin: 0;
		font-size: 0.86rem;
		color: var(--ink-90);
		white-space: pre-wrap;
		line-height: 1.45;
	}
	.draft-note {
		margin: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.76rem;
		color: var(--ink-50);
	}
	.draft-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	:global(.draft-badge) {
		font-size: 0.62rem;
	}
	:global(.draft-shimmer) {
		font-size: 0.86rem;
	}
</style>
