<script lang="ts">
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Wifi, WifiOff } from '@lucide/svelte';
	import type { SessionView } from '$lib/client/types.js';
	import { sessionBanner } from '$lib/client/view.js';

	let {
		session,
		socketConnected = true
	}: { session: SessionView; socketConnected?: boolean } = $props();

	const banner = $derived(sessionBanner(session));
	// Indeterminate by construction — a spinner, never a percentage bar (D5).
	const busy = $derived(banner.tone === 'progress');
	// Only the steady "Connected" state collapses to icon-only. Warn/bad/progress
	// labels stay permanently visible — those are the states that need action.
	const compact = $derived(banner.tone === 'good');
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<span class="chip" data-tone={banner.tone} data-compact={compact || undefined} {...props}>
					{#if busy}
						<Spinner class="size-3" />
					{:else if socketConnected}
						<Wifi class="size-3" />
					{:else}
						<WifiOff class="size-3" />
					{/if}
					<span class="chip-label">{banner.label}</span>
				</span>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p class="tip">{banner.detail}</p>
			{#if !socketConnected}
				<p class="tip">UI disconnected from the local backend — reconnecting.</p>
			{/if}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-70);
		cursor: default;
	}
	.chip[data-tone='good'] {
		color: var(--ink-80);
	}
	.chip[data-tone='warn'] {
		border-color: color-mix(in srgb, var(--cobalt) 40%, var(--hairline));
		color: var(--cobalt);
	}
	.chip[data-tone='bad'] {
		border-color: var(--destructive);
		color: var(--destructive);
	}
	.chip-label {
		white-space: nowrap;
	}
	.chip[data-compact] .chip-label {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.chip[data-compact]:hover .chip-label,
	.chip[data-compact]:focus-visible .chip-label,
	.chip[data-compact]:focus-within .chip-label {
		position: static;
		width: auto;
		height: auto;
		margin: 0;
		overflow: visible;
		clip: auto;
	}
	.tip {
		margin: 0;
		max-width: 240px;
		font-size: 0.72rem;
	}
</style>
