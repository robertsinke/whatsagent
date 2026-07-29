<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { ArrowLeft, Check, Monitor, Moon, Radio, RefreshCw, ShieldAlert, Sun } from '@lucide/svelte';
	import { api } from '$lib/client/api.js';
	import type { ProvidersResponse } from '$lib/client/types.js';
	// OSS-P3.4 — the provider + model control is shared with first-run setup.
	// Do not re-implement it here; the two screens must not drift apart.
	import ProviderPicker from '$lib/components/app/ProviderPicker.svelte';
	import { resetMode, setMode, userPrefersMode } from 'mode-watcher';

	type TextField = {
		kind: 'text';
		key: string;
		label: string;
		help: string;
		placeholder: string;
	};

	type SelectField = {
		kind: 'select';
		key: 'memory';
		label: string;
		help: string;
		placeholder: string;
	};

	type Field = TextField | SelectField;

	type VoiceView = {
		stem: string;
		content: string | null;
		byteLength: number;
		modifiedAt: string | null;
		path: string;
	};

	const MEMORY_OPTIONS: { value: string; label: string }[] = [
		{ value: 'hindsight', label: 'hindsight (default)' },
		{ value: 'null', label: 'null — static local profile' },
		{ value: 'off', label: 'off — learn nothing' }
	];

	const PACING_FIELDS: TextField[] = [
		{
			kind: 'text',
			key: 'pacing_min_seconds',
			label: 'Global spacing floor (s)',
			help: 'Minimum delay before the next queued draft. Defaults to 0 for near-immediate sending.',
			placeholder: '0'
		},
		{
			kind: 'text',
			key: 'pacing_max_seconds',
			label: 'Global spacing ceiling (s)',
			help: 'Upper jitter bound. Defaults to 1 second; values below the floor use the floor.',
			placeholder: '1'
		}
	];

	// Provider and model are rendered by the shared <ProviderPicker>, not here.
	const FIELDS: Field[] = [
		{
			kind: 'select',
			key: 'memory',
			label: 'Voice memory',
			help: 'hindsight (default) · null · off. Hindsight consolidates your edits and skips into two markdown voice documents — one global, one per contact — mirrored to voice/ in your data folder. Drafting reads those files, so drafts keep their voice even when Hindsight is down. Null keeps a static local profile; off learns nothing.',
			placeholder: 'hindsight'
		}
	];

	let values = $state<Record<string, string>>({
		provider: 'claude',
		provider_model: '',
		memory: 'hindsight'
	});
	let saved = $state<string | null>(null);
	let error = $state<string | null>(null);

	/**
	 * Discovery is a second, independent promise. Settings populate immediately;
	 * this only enriches the dropdowns. On rejection the page still works from
	 * the vendored catalog + saved value + Custom.
	 */
	let providersSnapshot = $state<ProvidersResponse | null>(null);
	let providersError = $state<string | null>(null);
	let providersLoading = $state(false);

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

	/** W4-U10: read-only voice document inspector — what drafting actually reads (D2). */
	let voice = $state<VoiceView | null>(null);
	let voiceLoading = $state(true);
	let voiceError = $state<string | null>(null);

	/**
	 * PL-P1.3 — appearance mode lives in localStorage (mode-watcher's key), not
	 * the DB. The reason is FOUC: a DB-backed preference needs an async
	 * api.settings() round-trip after hydration, which guarantees a
	 * light-then-dark flash on every launch. mode-watcher applies the class via
	 * an inline head script before first paint, so there is no flash. Do not
	 * route this through save(key)/api.setSetting.
	 */
	type Mode = 'light' | 'dark' | 'system';
	const APPEARANCE_OPTIONS: { value: Mode; label: string; icon: typeof Sun }[] = [
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
		{ value: 'system', label: 'System', icon: Monitor }
	];

	function chooseMode(next: Mode) {
		if (next === 'system') resetMode();
		else setMode(next);
	}

	async function loadProviders(refresh = false) {
		providersLoading = true;
		providersError = null;
		try {
			providersSnapshot = refresh ? await api.refreshProviders() : await api.providers();
		} catch (err) {
			providersError = err instanceof Error ? err.message : String(err);
			// Leave providersSnapshot as-is (null on first failure). Dropdowns
			// still render from catalog + saved + Custom.
		} finally {
			providersLoading = false;
		}
	}

	async function loadVoice() {
		voiceLoading = true;
		voiceError = null;
		try {
			voice = await api.voiceGlobal();
		} catch (err) {
			voiceError = err instanceof Error ? err.message : String(err);
		} finally {
			voiceLoading = false;
		}
	}

	function formatBytes(n: number): string {
		if (n === 0) return '0 B';
		if (n < 1024) return `${n} B`;
		return `${(n / 1024).toFixed(1)} KB`;
	}

	function formatModified(iso: string | null): string {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	onMount(() => {
		void api
			.settings()
			.then((settings) => {
				values = settings;
			})
			.catch((err) => (error = err instanceof Error ? err.message : String(err)));
		// Independent of settings — enrichment only. Rejection must not brick the page.
		void loadProviders();
		void api
			.sendMode()
			.then((mode) => (sendsLive = mode.live))
			.catch((err) => (error = err instanceof Error ? err.message : String(err)));
		void loadVoice();
	});

	async function save(key: string) {
		try {
			// `values` always holds the real setting value: the picker's Custom /
			// Default sentinels are view state inside <ProviderPicker> and never
			// reach this record, so there is nothing to strip here.
			const value = values[key] ?? '';
			await api.setSetting(key, value);
			saved = key;
			setTimeout(() => (saved = saved === key ? null : saved), 1500);
			// Refresh restartRequired after a provider/model write.
			if (key === 'provider' || key === 'provider_model' || key === 'memory') {
				void loadProviders();
			}
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

<main class="page scrollbar-contextual" use:scrollActivity>
	<header class="neumorphic-raised settings-header">
		<Button variant="ghost" size="sm" onclick={() => goto('/')}>
			<ArrowLeft class="size-4" /> Back
		</Button>
		<h1>Settings</h1>
		<p class="subtitle">
			{#if providersSnapshot?.restartRequired}
				Stored locally in SQLite. Provider and memory changes take effect after restart.
			{:else}
				Stored locally in SQLite.
			{/if}
		</p>
	</header>

	<section class="neumorphic-raised settings-body">
		<Tabs.Root value="agent">
			<Tabs.List class="settings-tabs">
				<Tabs.Trigger value="agent">Agent</Tabs.Trigger>
				<Tabs.Trigger value="safety">Safety</Tabs.Trigger>
				<Tabs.Trigger value="voice">Voice</Tabs.Trigger>
				<Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="agent" class="panel-content">
				<!-- Shared with first-run setup (OSS-P3.4): banners, re-scan, provider
				     and model selects, the Custom escape hatch, and the
				     saved-but-undetected warning all live in one component. -->
				<ProviderPicker
					bind:provider={values.provider}
					bind:providerModel={values.provider_model}
					snapshot={providersSnapshot}
					loading={providersLoading}
					error={providersError}
					savedKey={saved}
					onsave={(key) => save(key)}
					onrescan={(refresh) => loadProviders(refresh)}
				/>

				{#each FIELDS as field (field.key)}
					<label class="field">
						<span class="field-label">{field.label}</span>
						{#if field.kind === 'text'}
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
						{:else if field.key === 'memory'}
							<span class="field-row">
								<Select.Root type="single" bind:value={values.memory}>
									<Select.Trigger class="field-select" data-testid="memory-select">
										{MEMORY_OPTIONS.find((o) => o.value === values.memory)?.label ??
											values.memory ??
											'Select memory'}
									</Select.Trigger>
									<Select.Content>
										{#each MEMORY_OPTIONS as opt (opt.value)}
											<Select.Item value={opt.value} label={opt.label} />
										{/each}
									</Select.Content>
								</Select.Root>
								<Button size="sm" variant="outline" onclick={() => save(field.key)}>
									{#if saved === field.key}
										<Check class="size-3.5" /> Saved
									{:else}
										Save
									{/if}
								</Button>
							</span>
						{/if}
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

			<Tabs.Content value="voice" class="panel-content">
				<div class="voice-card">
					<div class="voice-head">
						<span class="field-label">Learned voice document (global)</span>
						<p class="voice-help">
							This is the markdown file drafting actually reads (decision D2): a mirror of the
							Hindsight mental model, rewritten whenever the model changes. Read-only — any
							hand edit is silently overwritten at the next memory tick, so an edit box would
							be a lie. Correcting the voice is a separate future unit that writes to the model,
							not the file.
						</p>
					</div>

					{#if voiceLoading}
						<p class="muted">Loading…</p>
					{:else if voiceError}
						<p class="error" role="alert">{voiceError}</p>
					{:else if voice && voice.content}
						<dl class="voice-meta">
							<div>
								<dt>Size</dt>
								<dd>{formatBytes(voice.byteLength)}</dd>
							</div>
							<div>
								<dt>Last written</dt>
								<dd>{formatModified(voice.modifiedAt)}</dd>
							</div>
							<div>
								<dt>Path</dt>
								<dd class="voice-path">{voice.path}</dd>
							</div>
						</dl>
						<pre class="voice-body scrollbar-contextual" use:scrollActivity>{voice.content}</pre>
					{:else}
						<p class="voice-empty">
							No voice has been learned yet. It appears after the agent has observed enough
							of your sent messages to consolidate a style — usually once the memory tick has
							run after a handful of conversations.
						</p>
					{/if}
				</div>
			</Tabs.Content>

			<Tabs.Content value="appearance" class="panel-content">
				<div class="appearance-card">
					<div class="appearance-head">
						<span class="field-label">Theme</span>
						<p class="appearance-help">
							Light, Dark, or follow the OS. Stored in your browser, not the app
							database, so it applies before first paint with no flash. Changing it
							takes effect immediately across the whole app.
						</p>
					</div>

					<div class="appearance-options">
						{#each APPEARANCE_OPTIONS as opt (opt.value)}
							<button
								type="button"
								class="appearance-option"
								data-active={userPrefersMode.current === opt.value}
								aria-pressed={userPrefersMode.current === opt.value}
								onclick={() => chooseMode(opt.value)}
							>
								<opt.icon class="size-4" />
								<span>{opt.label}</span>
								{#if userPrefersMode.current === opt.value}
									<Check class="size-3.5 appearance-check" />
								{/if}
							</button>
						{/each}
					</div>
					<p class="muted">
						{#if userPrefersMode.current === 'system'}
							Following your OS setting. Switching your OS theme updates this
							automatically.
						{:else}
							Manual override — takes priority over the OS. Switching your OS theme
							will not change the app until you set this back to System.
						{/if}
					</p>
				</div>
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
		height: 100dvh;
		overflow-y: auto;
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
	:global(.field-select) {
		flex: 1;
		width: 100%;
		min-width: 0;
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
		border-color: color-mix(in srgb, var(--cobalt) 45%, var(--hairline));
		background: color-mix(in srgb, var(--cobalt) 6%, var(--surface-raised));
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
		color: var(--cobalt);
		background: color-mix(in srgb, var(--cobalt) 14%, transparent);
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
		color: var(--cobalt);
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
		border-color: color-mix(in srgb, var(--cobalt) 40%, var(--hairline));
		color: var(--cobalt);
	}
	:global(.enable-live[data-mode='dry-run']:hover) {
		background: color-mix(in srgb, var(--cobalt) 10%, var(--surface-raised));
	}
	:global(.confirm-live) {
		max-width: 460px;
	}

	/* W4-U10 — voice inspector tab */
	.voice-card {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.7rem 0.8rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
	}
	.voice-head {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.voice-help {
		font-size: 0.72rem;
		color: var(--ink-50);
		margin: 0;
		line-height: 1.4;
	}
	.voice-meta {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 0.75rem;
		margin: 0;
		padding: 0.5rem 0.65rem;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		font-size: 0.75rem;
	}
	.voice-meta div {
		display: contents;
	}
	.voice-meta dt {
		color: var(--ink-50);
		font-weight: 500;
	}
	.voice-meta dd {
		margin: 0;
		color: var(--ink-90);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.voice-path {
		overflow-wrap: anywhere;
		word-break: break-all;
	}
	.voice-body {
		margin: 0;
		padding: 0.6rem 0.7rem;
		max-height: 26rem;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--ink-90);
		background: var(--surface-sunken);
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline-soft);
	}
	.voice-empty {
		font-size: 0.82rem;
		color: var(--ink-70);
		margin: 0;
		line-height: 1.45;
		padding: 0.4rem 0;
	}

	/* PL-P1.3 — appearance tab */
	.appearance-card {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.7rem 0.8rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
	}
	.appearance-head {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.appearance-help {
		font-size: 0.72rem;
		color: var(--ink-50);
		margin: 0;
		line-height: 1.4;
	}
	.appearance-options {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.appearance-option {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: var(--surface-sunken);
		color: var(--ink-80);
		font-size: 0.82rem;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.appearance-option:hover {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--hairline));
	}
	.appearance-option[data-active='true'] {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-raised));
		color: var(--ink-solid);
		font-weight: 500;
	}
	:global(.appearance-check) {
		color: var(--accent);
	}
</style>
