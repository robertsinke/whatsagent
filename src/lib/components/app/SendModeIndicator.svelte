<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Radio, ShieldAlert } from '@lucide/svelte';

	/**
	 * Always-visible send-mode indicator. The owner must never be unsure whether
	 * a send is live. Lives in the chat-list footer so it stays in view on every
	 * conversation screen.
	 *
	 * - `sendsLive === true`  → live (cobalt, Radio icon): approving a draft
	 *   or pressing send transmits over WhatsApp to a real recipient.
	 * - `sendsLive === false` → dry-run (muted, ShieldAlert icon): approving a
	 *   draft marks it sent and nothing reaches the recipient.
	 *
	 * Both states are icon-only; the `.chip-label` span stays in the DOM as the
	 * accessible name but is permanently visually hidden. The live vs off
	 * distinction stays legible without text through the cobalt-tinted
	 * border/icon colour and the Radio vs ShieldAlert icon swap. An earlier
	 * revision kept the "Sends live" label permanently visible as a safety
	 * carve-out; then hover/focus reveal was asked for across the footer chips;
	 * F10 drops the reveal (it widened chips and shifted neighbours) — the
	 * tooltip still carries the full sentence on hover and keyboard focus. Do
	 * not reinstate a visible label without re-asking.
	 */
	let {
		sendsLive = false,
		pending = false
	}: { sendsLive: boolean; pending: boolean } = $props();
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<span
					class="chip"
					data-mode={sendsLive ? 'live' : 'dry-run'}
					data-pending={pending || undefined}
					role="status"
					aria-live="polite"
					{...props}
				>
					{#if sendsLive}
						<Radio class="size-3" />
					{:else}
						<ShieldAlert class="size-3" />
					{/if}
					<span class="chip-label">{sendsLive ? 'Sends live' : 'Sends off'}</span>
				</span>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p class="tip">
				{#if sendsLive}
					Live sends are ON. Approving a draft or pressing send transmits over WhatsApp
					to a real recipient.
				{:else}
					Sends are OFF (dry-run). Approving a draft marks it sent and nothing reaches
					the recipient — the safe default.
				{/if}
			</p>
			{#if pending}
				<p class="tip">Updating…</p>
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
	   four footer controls behave the same. Live keeps cobalt on hover — that
	   colour is the live-send signal, not decoration — so only dry-run darkens,
	   and it needs an explicit rule because `[data-mode]` would otherwise
	   out-specify a bare `.chip:hover`. */
	.chip:hover,
	.chip:focus-visible {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	.chip[data-mode='live'] {
		border-color: color-mix(in srgb, var(--cobalt) 55%, var(--hairline));
		color: var(--cobalt);
		background: color-mix(in srgb, var(--cobalt) 8%, var(--surface-raised));
	}
	.chip[data-mode='dry-run'] {
		color: var(--ink-60);
	}
	.chip[data-mode='dry-run']:hover,
	.chip[data-mode='dry-run']:focus-visible {
		color: var(--ink-90);
	}
	.chip[data-pending] {
		opacity: 0.6;
	}
	.chip-label {
		white-space: nowrap;
	}
	/* Permanently visually hidden — keeps the accessible name without ever
	   expanding the chip. Live vs off is carried by cobalt border/icon colour
	   and the Radio vs ShieldAlert icon, not by text. See the header comment. */
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
		max-width: 260px;
		font-size: 0.72rem;
	}
</style>
