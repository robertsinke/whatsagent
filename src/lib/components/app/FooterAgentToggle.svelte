<script lang="ts">
	import { PanelRight } from '@lucide/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';

	/**
	 * Agent-panel toggle in the chat-list footer. Sixth footer chip — same shape
	 * as FooterSettings / FooterThemeToggle: icon-only; `.chip-label` stays in the
	 * DOM as the accessible name but is permanently visually hidden (F10: hover
	 * reveal widened chips and shifted neighbours — tooltip carries the word).
	 * Provides a way to toggle the panel that does not require dragging.
	 *
	 * Collapsed state persists in localStorage (first-paint read, no DB
	 * round-trip flash) — same rationale as the theme toggle.
	 */
	let {
		collapsed = false,
		onToggle
	}: {
		collapsed: boolean;
		onToggle: () => void;
	} = $props();

	const label = $derived(collapsed ? 'Show agent panel' : 'Hide agent panel');
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					type="button"
					class="chip"
					data-agent-collapsed={collapsed}
					aria-label={label}
					aria-pressed={!collapsed}
					title={label}
					{...props}
					onclick={onToggle}
				>
					<PanelRight class="size-3" />
					<span class="chip-label">{label}</span>
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p class="tip">{label}</p>
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
		   that is the hover affordance (F10: the label no longer expands). */
		border: 1px solid transparent;
		background: transparent;
		box-shadow: none;
		color: var(--ink-70);
		cursor: default;
		white-space: nowrap;
		line-height: 1;
	}
	.chip:hover,
	.chip:focus-visible {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	/* When the panel is collapsed, tint the icon so the chip reads as "active"
	   (the panel is available to be shown) without a full semantic state. */
	.chip[data-agent-collapsed='true'] {
		color: var(--cobalt);
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