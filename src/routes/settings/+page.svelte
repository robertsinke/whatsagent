<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { ArrowLeft, Check } from '@lucide/svelte';
	import { api } from '$lib/client/api.js';

	type Field = { key: string; label: string; help: string; placeholder: string };

	const DRY_RUN_FIELD: Field = {
		key: 'outbox_dry_run',
		label: 'Outbox dry-run',
		help: 'true blocks WhatsApp delivery while exercising the full queue. Only explicit false enables live sends after restart.',
		placeholder: 'true'
	};

	const FIELDS: Field[] = [
		{
			key: 'provider',
			label: 'Draft provider',
			help: 'claude · codex · ollama. Runs under your existing subscription login.',
			placeholder: 'claude'
		},
		{
			key: 'provider_model',
			label: 'Model',
			help: 'Optional model override for the selected provider.',
			placeholder: 'default'
		},
		{
			key: 'pacing_min_seconds',
			label: 'Pacing floor (s)',
			help: 'Approved drafts are spaced by randomized jitter. Manual sends skip the wait.',
			placeholder: '30'
		},
		{
			key: 'pacing_max_seconds',
			label: 'Pacing ceiling (s)',
			help: 'Upper bound of the send jitter window.',
			placeholder: '90'
		},
		{
			key: 'memory',
			label: 'Voice memory',
			help: 'off · null · hindsight. Null keeps a static local voice profile; Hindsight learns over time after restart.',
			placeholder: 'null'
		}
	];

	let values = $state<Record<string, string>>({});
	let saved = $state<string | null>(null);
	let error = $state<string | null>(null);

	// Fetched on mount, not in `load()` — this route prerenders.
	onMount(() => {
		void api
			.settings()
			.then((settings) => (values = settings))
			.catch((err) => (error = err instanceof Error ? err.message : String(err)));
	});

	async function save(key: string) {
		try {
			await api.setSetting(key, values[key] ?? '');
			saved = key;
			setTimeout(() => (saved = saved === key ? null : saved), 1500);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}
</script>

<main class="page">
	<header class="neumorphic-raised settings-header">
		<Button variant="ghost" size="sm" onclick={() => goto('/')}>
			<ArrowLeft class="size-4" /> Back
		</Button>
		<h1>Settings</h1>
		<p class="subtitle">
			Stored locally in SQLite. Provider and memory changes take effect after restart.
		</p>
	</header>

	<section class="neumorphic-raised settings-body">
		<Tabs.Root value="agent">
			<Tabs.List class="settings-tabs">
				<Tabs.Trigger value="agent">Agent</Tabs.Trigger>
				<Tabs.Trigger value="safety">Safety</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="agent" class="panel-content">
				{#each FIELDS as field (field.key)}
					<label class="field">
					<span class="field-label">{field.label}</span>
						<span class="field-row">
							<Input
								bind:value={values[field.key]}
								placeholder={field.placeholder}
								class="field-input"
							/>
							<Button size="sm" variant="outline" onclick={() => save(field.key)}>
								{#if saved === field.key}
									<Check class="size-3.5" /> Saved
								{:else}
									Save
								{/if}
							</Button>
						</span>
						<span class="field-help">{field.help}</span>
					</label>
				{/each}
			</Tabs.Content>

			<Tabs.Content value="safety" class="panel-content">
				<label class="field safety-field">
					<span class="field-label">{DRY_RUN_FIELD.label}</span>
					<span class="field-row">
						<Input
							bind:value={values[DRY_RUN_FIELD.key]}
							placeholder={DRY_RUN_FIELD.placeholder}
							class="field-input"
						/>
						<Button
							size="sm"
							variant="outline"
							onclick={() => save(DRY_RUN_FIELD.key)}
						>
							{#if saved === DRY_RUN_FIELD.key}
								<Check class="size-3.5" /> Saved
							{:else}
								Save
							{/if}
						</Button>
					</span>
					<span class="field-help">{DRY_RUN_FIELD.help}</span>
				</label>
				<h2>What this app will never do</h2>
				<ul class="safety">
					<li>The agent never sends. Every message leaves only after you press send or approve.</li>
					<li>All sends route through the outbox pacer — there is no other path to WhatsApp.</li>
					<li>Group chats are readable but structurally excluded from drafting.</li>
					<li>Media is fetched only when you ask for it, never bulk-downloaded.</li>
				</ul>
				<p class="muted">These are structural, not toggles — there is nothing to configure here.</p>
			</Tabs.Content>
		</Tabs.Root>
	</section>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
</main>

<style>
	.page {
		min-height: 100vh;
		max-width: 720px;
		margin: 0 auto;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.settings-header {
		border-radius: var(--radius-lg);
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		align-items: flex-start;
	}
	.settings-header h1 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--ink-solid);
		margin: 0.25rem 0 0;
	}
	.subtitle {
		color: var(--ink-70);
		font-size: 0.85rem;
		margin: 0;
	}
	.settings-body {
		border-radius: var(--radius-lg);
		padding: 1rem;
		min-height: 320px;
	}
	:global(.settings-tabs) {
		width: 100%;
	}
	:global(.panel-content) {
		padding: 0.75rem 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	:global(.panel-content h2) {
		font-size: 1rem;
		font-weight: 600;
		color: var(--ink-90);
		margin: 0;
	}
	.safety-field {
		padding-bottom: 0.9rem;
		border-bottom: 1px solid var(--hairline);
	}
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
	.field-help {
		font-size: 0.72rem;
		color: var(--ink-50);
	}
	.safety {
		margin: 0;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.84rem;
		color: var(--ink-80);
	}
	.muted {
		color: var(--ink-50);
		font-size: 0.8rem;
		margin: 0;
	}
	.error {
		color: var(--destructive);
		font-size: 0.8rem;
	}
</style>
