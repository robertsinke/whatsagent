<script lang="ts">
	/**
	 * The shared provider + model control. Extracted from Settings (OSS-P2.5) so
	 * first-run setup and Settings are the same code — a second copy would drift
	 * the moment either side learned something about provider state.
	 *
	 * Two callers, one difference: Settings persists each field with its own Save
	 * button (`onsave`), first-run has no saved state yet and persists on
	 * continue. Passing no `onsave` renders the control without Save buttons.
	 */
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Check, RefreshCw } from '@lucide/svelte';
	import type { ProvidersResponse } from '$lib/client/types.js';
	import { CUSTOM_MODEL_VALUE, DEFAULT_MODEL_VALUE } from '../../../../shared/providers.js';
	import {
		activeDraftLabel,
		modelOptions,
		modelTriggerLabel,
		modelViewValue,
		providerOptions,
		savedDraftLabel,
		savedModelWarning
	} from './provider-picker.js';

	let {
		provider = $bindable(),
		providerModel = $bindable(),
		snapshot,
		loading = false,
		error = null,
		savedKey = null,
		onsave,
		onrescan,
		providerHelp = 'claude · codex · ollama. Runs under your existing subscription login.',
		modelHelp = 'Optional model override for the selected provider. Custom… keeps the saved id and opens a text field.'
	}: {
		provider: string;
		providerModel: string;
		snapshot: ProvidersResponse | null;
		loading?: boolean;
		error?: string | null;
		/** Which field just saved, for the transient tick. Settings only. */
		savedKey?: string | null;
		onsave?: (key: 'provider' | 'provider_model') => void;
		onrescan?: (refresh: boolean) => void;
		providerHelp?: string;
		modelHelp?: string;
	} = $props();

	/**
	 * Custom is a view mode, not a value: choosing it deliberately does not touch
	 * `providerModel`, and the text input below binds to the same prefilled
	 * value. The select's displayed value is derived from it, never mirrored.
	 */
	let modelCustom = $state(false);
	const modelView = $derived(modelViewValue(modelCustom, providerModel));

	function handleModelViewChange(next: string | undefined) {
		if (next === undefined) return;
		if (next === CUSTOM_MODEL_VALUE) {
			modelCustom = true;
			return;
		}
		modelCustom = false;
		// The Default sentinel means "no override" — it must never be persisted.
		providerModel = next === DEFAULT_MODEL_VALUE ? '' : next;
	}
</script>

{#if snapshot?.restartRequired}
	<div class="restart-banner" role="status" data-testid="restart-required">
		Restart required. The agent is still drafting with
		<strong>{activeDraftLabel(snapshot)}</strong>; after restart it will use
		<strong>{savedDraftLabel(snapshot)}</strong>.
	</div>
{/if}
{#if snapshot?.active.coercedFrom}
	<div class="coerced-banner" role="alert" data-testid="provider-coerced">
		Saved provider <code>{snapshot.active.coercedFrom}</code> was invalid at boot; drafting fell
		back to <strong>{snapshot.active.provider}</strong>.
	</div>
{/if}

<div class="discovery-row">
	<span class="discovery-status">
		{#if loading}
			Scanning providers…
		{:else if error}
			Discovery unavailable — using catalog + saved + Custom.
		{:else if snapshot}
			Providers scanned.
		{:else}
			Waiting for discovery…
		{/if}
	</span>
	<Button
		size="sm"
		variant="outline"
		onclick={() => onrescan?.(true)}
		disabled={loading}
		data-testid="providers-rescan"
	>
		<RefreshCw class="size-3.5" /> Re-scan
	</Button>
</div>

<label class="field">
	<span class="field-label">Draft provider</span>
	<span class="field-row">
		<Select.Root type="single" bind:value={provider}>
			<Select.Trigger class="field-select" data-testid="provider-select">
				{providerOptions(snapshot, provider).find((o) => o.value === provider)?.label ??
					provider ??
					'Select provider'}
			</Select.Trigger>
			<Select.Content>
				{#each providerOptions(snapshot, provider) as opt (opt.value)}
					<Select.Item value={opt.value} label={opt.label} disabled={opt.disabled}>
						<span class="option-main">{opt.label}</span>
						{#if opt.disabled && opt.reason}
							<span class="option-reason">{opt.reason}</span>
						{/if}
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		{#if onsave}
			<Button size="sm" variant="outline" onclick={() => onsave?.('provider')}>
				{#if savedKey === 'provider'}
					<Check class="size-3.5" /> Saved
				{:else}
					Save
				{/if}
			</Button>
		{/if}
	</span>
	<span class="field-help">{providerHelp}</span>
</label>

<label class="field">
	<span class="field-label">Model</span>
	<span class="field-row">
		<Select.Root type="single" value={modelView} onValueChange={handleModelViewChange}>
			<Select.Trigger class="field-select" data-testid="model-select">
				{modelTriggerLabel(snapshot, provider, providerModel, modelCustom)}
			</Select.Trigger>
			<Select.Content>
				{#each modelOptions(snapshot, provider, providerModel) as opt (opt.value)}
					<Select.Item value={opt.value} label={opt.label}>
						<span class="option-main">{opt.label}</span>
						{#if opt.source === 'saved'}
							<span class="option-reason">saved, not detected</span>
						{:else if opt.note}
							<span class="option-reason">{opt.note}</span>
						{/if}
					</Select.Item>
				{/each}
				<Select.Item value={CUSTOM_MODEL_VALUE} label="Custom…">Custom…</Select.Item>
			</Select.Content>
		</Select.Root>
		{#if onsave}
			<Button size="sm" variant="outline" onclick={() => onsave?.('provider_model')}>
				{#if savedKey === 'provider_model'}
					<Check class="size-3.5" /> Saved
				{:else}
					Save
				{/if}
			</Button>
		{/if}
	</span>
	{#if modelCustom}
		<span class="field-row custom-row">
			<Input
				bind:value={providerModel}
				placeholder="model id"
				class="field-input"
				data-testid="model-custom-input"
			/>
		</span>
	{/if}
	{#if savedModelWarning(snapshot, provider, providerModel)}
		<span class="field-warning" data-testid="model-saved-warning">
			Saved model is not in the detected list — it will be kept until you change it.
		</span>
	{/if}
	<span class="field-help">{modelHelp}</span>
</label>

<style>
	/* Copied verbatim with the markup from settings/+page.svelte — same rules,
	   now in one place. `:global` on the two class props is required: they are
	   passed into child components (see the catalog-scaffold solutions doc). */
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.field-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--ink-90);
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.field-row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}
	:global(.field-input) {
		height: 2rem;
		font-size: 0.82rem;
	}
	:global(.field-select) {
		flex: 1;
		width: 100%;
		min-width: 0;
	}
	.field-help {
		font-size: 0.72rem;
		color: var(--ink-50);
	}
	.field-warning {
		font-size: 0.72rem;
		color: var(--terracotta, #c45c26);
		line-height: 1.35;
	}
	.option-main {
		display: block;
	}
	.option-reason {
		display: block;
		font-size: 0.7rem;
		color: var(--ink-50);
	}
	.custom-row {
		margin-top: 0.15rem;
	}
	.discovery-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.discovery-status {
		font-size: 0.72rem;
		color: var(--ink-50);
	}
	.restart-banner {
		font-size: 0.8rem;
		line-height: 1.4;
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--terracotta, #c45c26) 35%, var(--hairline));
		background: color-mix(in srgb, var(--terracotta, #c45c26) 8%, var(--surface-raised));
		color: var(--ink-90);
	}
	.coerced-banner {
		font-size: 0.8rem;
		line-height: 1.4;
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--destructive) 40%, var(--hairline));
		background: color-mix(in srgb, var(--destructive) 8%, var(--surface-raised));
		color: var(--ink-90);
	}
</style>
