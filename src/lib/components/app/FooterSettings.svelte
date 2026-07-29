<script lang="ts">
	import { goto } from '$app/navigation';
	import { Settings } from '@lucide/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';

	/**
	 * Settings entry point in the chat-list footer. Icon-only; `.chip-label`
	 * stays in the DOM as the accessible name but is permanently visually
	 * hidden (F10: hover reveal widened chips and shifted neighbours — tooltip
	 * carries the word). Matches the other footer chips. A plain anchor
	 * (client-side goto) rather than a Sheet — Settings is a full route, not a
	 * panel.
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
		   than floating on it as a pill. Hover lifts it to the raised surface —
		   that is the hover affordance (F10: the label no longer expands).
		   Semantic states (live, warn, bad) re-assert their own border and tint
		   below — those carry meaning and must stay visible at rest. */
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
		border: 0;
	}
	.tip {
		margin: 0;
		max-width: 220px;
		font-size: 0.72rem;
	}
</style>