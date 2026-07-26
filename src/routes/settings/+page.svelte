<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { ArrowLeft, Check, Radio, ShieldAlert } from '@lucide/svelte';
	import { api } from '$lib/client/api.js';

	type Field = { key: string; label: string; help: string; placeholder: string };

	const PACING_FIELDS: Field[] = [
		{
			key: 'pacing_min_seconds',
			label: 'Global spacing floor (s)',
			help: 'Minimum delay before the next queued draft. Defaults to 0 for near-immediate sending.',
			placeholder: '0'
		},
		{
			key: 'pacing_max_seconds',
			label: 'Global spacing ceiling (s)',
			help: 'Upper jitter bound. Defaults to 1 second; values below the floor use the floor.',
			placeholder: '1'
		}
	];

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
			key: 'memory',
			label: 'Voice memory',
			help: 'hindsight (default) · null · off. Hindsight consolidates your edits and skips into two markdown voice documents — one global, one per contact — mirrored to voice/ in your data folder. Drafting reads those files, so drafts keep their voice even when Hindsight is down. Null keeps a static local profile; off learns nothing.',
			placeholder: 'hindsight'
		}
	];

	let values = $state<Record<string, string>>({});
	let saved = $state<string | null>(null);
	let error = $state<string | null>(null);

	/**
	 * W4-U8: outbox send-mode, owned by the dedicated endpoint (not the generic
	 * settings PUT). `sendsLive === true` means the pacer transmits over
	 * WhatsApp; `false` (the fail-safe default) means approving a draft marks it
	 * sent and nothing reaches the recipient.
	 */
	let sendsLive = $state(false);
	let sendingMode = $state(false);
	/** Confirmation dialog open state — only the unsafe direction (live) confirms. */
	let confirmLiveOpen = $state(false);
	let confirmLiveError = $state<string | null>(null);

	onMount(() => {
		void api
			.settings()
			.then((settings) => (values = settings))
			.catch((err) => (error = err instanceof Error ? err.message : String(err)));
		void api
			.sendMode()
			.then((mode) => (sendsLive = mode.live))
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

	/**
	 * The safe direction is always one click: turning sends OFF takes effect
	 * immediately and is never confirmed. Only enabling live sends opens the
	 * confirmation dialog, so an accidental click never puts real messages on
	 * the wire.
	 */
	async function toggleSends(nextLive: boolean) {
		if (nextLive === sendsLive || sendingMode) return;
		if (nextLive) {
			confirmLiveOpen = true;
			confirmLiveError = null;
			return;
		}
		await applyToggle(false);
	}

	async function confirmEnableLive() {
		const ok = await applyToggle(true);
		if (ok) confirmLiveOpen = false;
	}

	async function applyToggle(live: boolean): Promise<boolean> {
		sendingMode = true;
		try {
			const result = await api.setSendMode(live);
			sendsLive = result.live;
			confirmLiveError = null;
			return result.live === live;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (live) confirmLiveError = msg;
			else error = msg;
			return false;
		} finally {
			sendingMode = false;
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
				<div class="send-mode-card" data-mode={sendsLive ? 'live' : 'dry-run'}>
					<div class="send-mode-head">
						<span class="send-mode-icon" data-mode={sendsLive ? 'live' : 'dry-run'}>
							{#if sendsLive}
								<Radio class="size-4" />
							{:else}
								<ShieldAlert class="size-4" />
							{/if}
						</span>
						<div class="send-mode-titles">
							<span class="field-label">WhatsApp sends</span>
							<span class="send-mode-state" data-mode={sendsLive ? 'live' : 'dry-run'}>
								{#if sendsLive}
									LIVE — approving a draft or pressing send transmits over WhatsApp to a real recipient.
								{:else}
									OFF — approving a draft marks it sent and nothing reaches the recipient.
								{/if}
							</span>
						</div>
					</div>

					<div class="send-mode-controls">
						<Button
							size="sm"
							variant={sendsLive ? 'outline' : 'default'}
							onclick={() => toggleSends(false)}
							disabled={sendingMode || !sendsLive}
						>
							{#if !sendsLive}
								<Check class="size-3.5" /> Sends off
							{:else}
								Turn sends off
							{/if}
						</Button>
						<Button
							size="sm"
							variant={sendsLive ? 'default' : 'outline'}
							class="enable-live"
							onclick={() => toggleSends(true)}
							disabled={sendingMode || sendsLive}
							data-mode={sendsLive ? 'live' : 'dry-run'}
						>
							{#if sendsLive}
								<Radio class="size-3.5" /> Sends live
							{:else}
								Enable live sends
							{/if}
						</Button>
					</div>

					<p class="send-mode-help">
						Off is the safe default and the safe direction — turning it off is always one
						click and never asks to confirm. Enabling live sends asks you to confirm
						first, because approving a draft then puts a real message on a real
						recipient's phone. Takes effect immediately without a restart.
					</p>
				</div>

				{#each PACING_FIELDS as field (field.key)}
					<label class="field safety-field">
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
				<h2>What this app will never do</h2>
				<ul class="safety">
					<li>The agent never sends. Every message leaves only after you press send or approve.</li>
					<li>All sends route through the outbox pacer — there is no other path to WhatsApp.</li>
					<li>Group chats are readable but structurally excluded from drafting.</li>
					<li>Media is fetched only when you ask for it, never bulk-downloaded.</li>
				</ul>
				<p class="muted">Spacing is tunable after restart. The guarantees above are structural.</p>
			</Tabs.Content>
		</Tabs.Root>
	</section>

	<Dialog.Root bind:open={confirmLiveOpen}>
		<Dialog.Content class="confirm-live">
			<Dialog.Header>
				<Dialog.Title>Enable live WhatsApp sends?</Dialog.Title>
				<Dialog.Description>
					With live sends ON, approving a draft or pressing send transmits over WhatsApp
					to a real recipient. There is no second gate after this — only the outbox pacer
					(same as today, same pacing). You can turn sends off at any time with one
					click; that direction never asks to confirm.
				</Dialog.Description>
			</Dialog.Header>
			{#if confirmLiveError}
				<p class="error" role="alert">{confirmLiveError}</p>
			{/if}
			<Dialog.Footer>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => (confirmLiveOpen = false)}
					disabled={sendingMode}
				>
					Cancel
				</Button>
				<Button
					size="sm"
					class="enable-live"
					onclick={confirmEnableLive}
					disabled={sendingMode}
				>
					{#if sendingMode}
						Enabling…
					{:else}
						<Radio class="size-3.5" /> Enable live sends
					{/if}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

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

	/* W4-U8 — send-mode card */
	.send-mode-card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.7rem 0.8rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
	}
	.send-mode-card[data-mode='live'] {
		border-color: color-mix(in srgb, var(--terracotta) 45%, var(--hairline));
		background: color-mix(in srgb, var(--terracotta) 6%, var(--surface-raised));
	}
	.send-mode-head {
		display: flex;
		gap: 0.55rem;
		align-items: flex-start;
	}
	.send-mode-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 999px;
		flex: none;
		color: var(--ink-60);
		background: color-mix(in srgb, var(--ink-10) 12%, transparent);
	}
	.send-mode-icon[data-mode='live'] {
		color: var(--terracotta);
		background: color-mix(in srgb, var(--terracotta) 14%, transparent);
	}
	.send-mode-titles {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.send-mode-state {
		font-size: 0.78rem;
		color: var(--ink-70);
		line-height: 1.35;
	}
	.send-mode-state[data-mode='live'] {
		color: var(--terracotta);
		font-weight: 500;
	}
	.send-mode-controls {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.send-mode-help {
		font-size: 0.72rem;
		color: var(--ink-50);
		margin: 0;
		line-height: 1.4;
	}
	:global(.enable-live[data-mode='dry-run']) {
		border-color: color-mix(in srgb, var(--terracotta) 40%, var(--hairline));
		color: var(--terracotta);
	}
	:global(.enable-live[data-mode='dry-run']:hover) {
		background: color-mix(in srgb, var(--terracotta) 10%, var(--surface-raised));
	}
	:global(.confirm-live) {
		max-width: 460px;
	}
</style>