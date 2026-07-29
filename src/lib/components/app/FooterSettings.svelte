<script lang="ts">
	import { goto } from '$app/navigation';
	import { Settings } from '@lucide/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';

	/**
	 * Settings entry point in the chat-list footer. Icon-only at rest, label
	 * reveals on hover/focus, matching the other three footer controls. A plain
	 * anchor (client-side goto) rather than a Sheet — Settings is a full route,
	 * not a panel.
	 */
	function open(e: MouseEvent) {
		e.preventDefault();
		goto('/settings');
	}
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<a
					href="/settings"
					class="chip"
					aria-label="Settings"
					title="Settings"
					onclick={open}
					{...props}
				>
					<Settings class="size-3" />
					<span class="chip-label">Settings</span>
				</a>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p class="tip">Draft provider, memory, send-mode defaults.</p>
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
		/* Transparent at rest so the control sits IN the recessed footer rather
		   than floating on it as a pill. Hover lifts it to the raised surface,
		   which doubles as the hover affordance now that the label reveal is the
		   only other feedback. Semantic states (live, warn, bad) re-assert their
		   own border and tint below — those carry meaning and must stay visible
		   at rest. */
		border: 1px solid transparent;
		background: transparent;
		box-shadow: none;
		color: var(--ink-70);
		cursor: default;
		white-space: nowrap;
		text-decoration: none;
		line-height: 1;
	}
	.chip:hover,
	.chip:focus-visible {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	.chip-label {
		white-space: nowrap;
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
	.chip:hover .chip-label,
	.chip:focus-visible .chip-label,
	.chip:focus-within .chip-label {
		position: static;
		width: auto;
		height: auto;
		margin: 0;
		overflow: visible;
		clip: auto;
	}
	.tip {
		margin: 0;
		max-width: 220px;
		font-size: 0.72rem;
	}
</style>