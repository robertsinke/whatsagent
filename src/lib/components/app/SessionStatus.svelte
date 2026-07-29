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
	// Icon-only for every tone; the `.chip-label` span stays in the DOM as the
	// accessible name but is permanently visually hidden. Connected vs warn vs
	// bad is carried by the icon swap (Wifi/WifiOff/Spinner) and the tone-driven
	// colour, not by text. An earlier revision kept warn/bad/progress labels
	// permanently visible as a safety carve-out; then hover/focus reveal was
	// asked for across the footer chips; F10 drops the reveal (it widened chips
	// and shifted neighbours) — the tooltip still carries banner.detail on hover
	// and keyboard focus. Do not reinstate a visible label without re-asking.
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<span class="chip" data-tone={banner.tone} {...props}>
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
		line-height: 1;
	}
	/* Hover/focus feedback identical to the Outbox and Settings chips, so all
	   four footer controls behave the same. Tone-bearing states keep their own
	   colour on hover — warn and bad are meaning, not decoration — so only the
	   neutral states darken, and they get an explicit rule because the tone
	   selectors below would otherwise out-specify a bare `.chip:hover`. */
	.chip:hover,
	.chip:focus-visible {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	.chip[data-tone='good'] {
		color: var(--ink-80);
	}
	.chip[data-tone='good']:hover,
	.chip[data-tone='good']:focus-visible {
		color: var(--ink-90);
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
	/* Permanently visually hidden — keeps the accessible name without ever
	   expanding the chip. Connected vs warn vs bad is carried by the icon swap
	   and the tone-driven colour, not by text. See the header comment above. */
	.chip .chip-label {
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
	.tip {
		margin: 0;
		max-width: 240px;
		font-size: 0.72rem;
	}
</style>
