<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { Check, DownloadCloud, RotateCw, X } from '@lucide/svelte';
	import { deepenStatusView, type DeepenKind } from '$lib/client/view.js';

	let {
		status,
		disabled = false,
		ondeepen
	}: {
		status: { kind: DeepenKind; at: number | null };
		disabled?: boolean;
		ondeepen?: () => void;
	} = $props();

	const kind = $derived(status.kind);
	const view = $derived(deepenStatusView(kind));
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					size="sm"
					variant="ghost"
					class="deepen-btn"
					data-kind={kind}
					{...props}
					onclick={() => ondeepen?.()}
					disabled={disabled || view.busy}
					aria-label="Ask the phone for older messages in this chat"
				>
					{#if view.busy}
						<Spinner class="size-3" /> {view.label}
					{:else if kind === 'success'}
						<Check class="size-3.5" /> {view.label}
					{:else if view.failed}
						<RotateCw class="size-3.5" /> {view.label}
					{:else}
						<DownloadCloud class="size-3.5" /> {view.label}
					{/if}
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p class="tip">
				{#if view.busy}
					Asking your phone for older messages. New (older) messages will appear here as they arrive.
				{:else if view.accepted}
					Request accepted. Older messages will merge into the thread as the phone delivers them.
				{:else if view.failed}
					Last deepen request failed — usually because WhatsApp was disconnected. Try again once reconnected.
				{:else}
					Ask the phone for older messages than the initial sync delivered. Useful for thin history before voice bootstrap. Read-only — never sends anything.
				{/if}
			</p>
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>

{#if kind === 'error'}
	<button class="dismiss" type="button" aria-label="Dismiss deepen error" onclick={() => ondeepen?.()}>
		<X class="size-3" />
	</button>
{/if}

<style>
	:global(.deepen-btn) {
		height: 1.7rem;
		font-size: 0.72rem;
		padding: 0 0.5rem;
		gap: 0.3rem;
		color: var(--ink-70);
	}
	:global(.deepen-btn[data-kind='success']) {
		color: var(--ink-50);
	}
	:global(.deepen-btn[data-kind='error']) {
		color: var(--cobalt);
		border-color: color-mix(in srgb, var(--cobalt) 35%, var(--hairline));
	}
	.dismiss {
		display: inline-flex;
		align-items: center;
		border: none;
		background: transparent;
		color: var(--ink-50);
		cursor: pointer;
		padding: 0.15rem;
		margin-left: 0.1rem;
	}
	.tip {
		margin: 0;
		max-width: 260px;
		font-size: 0.72rem;
	}
</style>