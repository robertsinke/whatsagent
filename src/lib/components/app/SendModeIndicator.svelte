<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Radio, ShieldAlert } from '@lucide/svelte';

	/**
	 * W4-U8 — always-visible send-mode indicator. The owner must never be
	 * unsure whether a send is live. Surfaced in the topbar so it is visible on
	 * every screen, not buried in settings.
	 *
	 * - `sendsLive === true`  → live (terracotta, Radio icon): approving a draft
	 *   or pressing send transmits over WhatsApp to a real recipient.
	 * - `sendsLive === false` → dry-run (muted, ShieldAlert icon): approving a
	 *   draft marks it sent and nothing reaches the recipient. This is the
	 *   fail-safe default and the safe direction of the toggle.
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
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-70);
		cursor: default;
		white-space: nowrap;
	}
	.chip[data-mode='live'] {
		border-color: color-mix(in srgb, var(--terracotta) 55%, var(--hairline));
		color: var(--terracotta);
		background: color-mix(in srgb, var(--terracotta) 8%, var(--surface-raised));
	}
	.chip[data-mode='dry-run'] {
		color: var(--ink-60);
	}
	.chip[data-pending] {
		opacity: 0.6;
	}
	.tip {
		margin: 0;
		max-width: 260px;
		font-size: 0.72rem;
	}
</style>