<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { ArrowLeft, Check, Radio, RefreshCw, ShieldAlert } from '@lucide/svelte';
	import { api } from '$lib/client/api.js';
	import type { ProviderInfo, ProvidersResponse } from '$lib/client/types.js';
	import { PROVIDER_CATALOG } from '../../../shared/provider-catalog.generated.js';
	import type { CatalogModel, DraftProviderName, ProviderModelOption } from '../../../shared/provider-types.js';
	import {
		CUSTOM_MODEL_VALUE,
		DEFAULT_MODEL_LABEL,
		DEFAULT_MODEL_VALUE,
		DRAFT_PROVIDER_NAMES,
		mergeModelOptions,
		normalizeDraftProviderName
	} from '../../../shared/providers.js';

	type TextField = {
		kind: 'text';
		key: string;
		label: string;
		help: string;
		placeholder: string;
	};

	type SelectField = {
		kind: 'select';
		key: 'provider' | 'provider_model' | 'memory';
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

	type ProviderOption = {
		value: DraftProviderName;
		label: string;
		disabled: boolean;
		reason: string | null;
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

	const FIELDS: Field[] = [
		{
			kind: 'select',
			key: 'provider',
			label: 'Draft provider',
			help: 'claude · codex · ollama. Runs under your existing subscription login.',
			placeholder: 'claude'
		},
		{
			kind: 'select',
			key: 'provider_model',
			label: 'Model',
			help: 'Optional model override for the selected provider. Custom… keeps the saved id and opens a text field.',
			placeholder: 'default'
		},
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
	 * Model select value is a VIEW value, never the setting value. Choosing
	 * Custom sets this flag and deliberately does not write the underlying
	 * setting; the text input then binds to the same setting value, prefilled.
	 * Sentinels never reach the wire.
	 */
	let modelCustom = $state(false);
	let modelView = $state<string>(DEFAULT_MODEL_VALUE);

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

	function unavailableReasonLabel(info: ProviderInfo): string {
		switch (info.unavailableReason) {
			case 'not_found':
				return 'not found on PATH';
			case 'probe_failed':
				return 'version probe failed';
			case 'not_running':
				return 'installed but not running';
			default:
				return info.unavailableDetail ?? 'unavailable';
		}
	}

	function providerOptions(): ProviderOption[] {
		const byName = new Map(
			(providersSnapshot?.providers ?? []).map((p) => [p.name, p] as const)
		);
		const current = normalizeDraftProviderName(values.provider);
		return DRAFT_PROVIDER_NAMES.map((name) => {
			const info = byName.get(name);
			if (!info) {
				return { value: name, label: name, disabled: false, reason: null };
			}
			const unavailable = !info.installed || info.unavailableReason !== null;
			let label = info.label || name;
			if (info.installed && info.version) {
				label = `${name} — installed, v${info.version}`;
			} else if (info.installed) {
				label = `${name} — installed`;
			} else {
				label = `${name} — ${unavailableReasonLabel(info)}`;
			}
			if (unavailable && info.unavailableReason) {
				label = `${name} — ${unavailableReasonLabel(info)}`;
				if (info.version) label = `${name} — v${info.version} (${unavailableReasonLabel(info)})`;
			}
			return {
				value: name,
				label,
				// Keep the currently saved provider selectable so a missing binary
				// cannot silently clear the owner's choice from the control.
				disabled: unavailable && name !== current,
				reason: unavailable ? unavailableReasonLabel(info) : null
			};
		});
	}

	function catalogFor(provider: DraftProviderName): readonly CatalogModel[] {
		if (provider === 'ollama') return [];
		return PROVIDER_CATALOG[provider] ?? [];
	}

	function modelOptions(): ProviderModelOption[] {
		const provider = normalizeDraftProviderName(values.provider);
		const info = providersSnapshot?.providers.find((p) => p.name === provider);
		const live = info?.models ?? [];
		const merged = mergeModelOptions(catalogFor(provider), live, values.provider_model);
		if (!merged.some((m) => m.value === DEFAULT_MODEL_VALUE)) {
			merged.push({
				value: DEFAULT_MODEL_VALUE,
				label: DEFAULT_MODEL_LABEL,
				source: 'default'
			});
		}
		return merged;
	}

	function syncModelViewFromValue() {
		if (modelCustom) {
			modelView = CUSTOM_MODEL_VALUE;
			return;
		}
		const trimmed = (values.provider_model ?? '').trim();
		modelView = trimmed === '' ? DEFAULT_MODEL_VALUE : trimmed;
	}

	function handleModelViewChange(next: string | undefined) {
		if (next === undefined) return;
		if (next === CUSTOM_MODEL_VALUE) {
			modelCustom = true;
			modelView = CUSTOM_MODEL_VALUE;
			// Deliberately do not touch values.provider_model — Custom is a view
			// mode. The text input stays bound to the prefilled setting value.
			return;
		}
		modelCustom = false;
		modelView = next;
		if (next === DEFAULT_MODEL_VALUE) {
			values.provider_model = '';
		} else {
			values.provider_model = next;
		}
	}

	function modelTriggerLabel(): string {
		if (modelCustom || modelView === CUSTOM_MODEL_VALUE) return 'Custom…';
		if (modelView === DEFAULT_MODEL_VALUE || (values.provider_model ?? '').trim() === '') {
			return DEFAULT_MODEL_LABEL;
		}
		const opt = modelOptions().find((m) => m.value === modelView);
		return opt?.label ?? modelView;
	}

	function savedModelWarning(): boolean {
		const trimmed = (values.provider_model ?? '').trim();
		if (trimmed === '') return false;
		return modelOptions().some((m) => m.value === trimmed && m.source === 'saved');
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
				modelCustom = false;
				syncModelViewFromValue();
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
			// Sentinels are view-only; never persist Custom / Default tokens.
			let value = values[key] ?? '';
			if (key === 'provider_model') {
				if (value === CUSTOM_MODEL_VALUE || value === DEFAULT_MODEL_VALUE) {
					value = value === DEFAULT_MODEL_VALUE ? '' : (values.provider_model ?? '');
				}
				if (modelCustom) {
					value = values.provider_model ?? '';
				}
			}
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

	function activeDraftLabel(): string {
		const active = providersSnapshot?.active;
		if (!active) return 'the boot provider';
		const model = active.model?.trim();
		return model ? `${active.provider} / ${model}` : active.provider;
	}

	function savedDraftLabel(): string {
		const savedInfo = providersSnapshot?.saved;
		if (!savedInfo) return 'the saved settings';
		const provider = savedInfo.provider?.trim() || 'claude';
		const model = savedInfo.providerModel?.trim();
		return model ? `${provider} / ${model}` : `${provider} (provider default)`;
	}
</script>

<main class="page">
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
			</Tabs.List>

			<Tabs.Content value="agent" class="panel-content">
				{#if providersSnapshot?.restartRequired}
					<div class="restart-banner" role="status" data-testid="restart-required">
						Restart required. The agent is still drafting with <strong>{activeDraftLabel()}</strong>;
						after restart it will use <strong>{savedDraftLabel()}</strong>.
					</div>
				{/if}
				{#if providersSnapshot?.active.coercedFrom}
					<div class="coerced-banner" role="alert" data-testid="provider-coerced">
						Saved provider <code>{providersSnapshot.active.coercedFrom}</code> was invalid at
						boot; drafting fell back to <strong>{providersSnapshot.active.provider}</strong>.
					</div>
				{/if}

				<div class="discovery-row">
					<span class="discovery-status">
						{#if providersLoading}
							Scanning providers…
						{:else if providersError}
							Discovery unavailable — using catalog + saved + Custom.
						{:else if providersSnapshot}
							Providers scanned.
						{:else}
							Waiting for discovery…
						{/if}
					</span>
					<Button
						size="sm"
						variant="outline"
						onclick={() => loadProviders(true)}
						disabled={providersLoading}
						data-testid="providers-rescan"
					>
						<RefreshCw class="size-3.5" /> Re-scan
					</Button>
				</div>

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
						{:else if field.key === 'provider'}
							<span class="field-row">
								<Select.Root type="single" bind:value={values.provider}>
									<Select.Trigger class="field-select" data-testid="provider-select">
										{providerOptions().find((o) => o.value === values.provider)?.label ??
											values.provider ??
											'Select provider'}
									</Select.Trigger>
									<Select.Content>
										{#each providerOptions() as opt (opt.value)}
											<Select.Item
												value={opt.value}
												label={opt.label}
												disabled={opt.disabled}
											>
												<span class="option-main">{opt.label}</span>
												{#if opt.disabled && opt.reason}
													<span class="option-reason">{opt.reason}</span>
												{/if}
											</Select.Item>
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
						{:else if field.key === 'provider_model'}
							<span class="field-row">
								<Select.Root
									type="single"
									value={modelView}
									onValueChange={handleModelViewChange}
								>
									<Select.Trigger class="field-select" data-testid="model-select">
										{modelTriggerLabel()}
									</Select.Trigger>
									<Select.Content>
										{#each modelOptions() as opt (opt.value)}
											<Select.Item value={opt.value} label={opt.label}>
												<span class="option-main">{opt.label}</span>
												{#if opt.source === 'saved'}
													<span class="option-reason">saved, not detected</span>
												{:else if opt.note}
													<span class="option-reason">{opt.note}</span>
												{/if}
											</Select.Item>
										{/each}
										<Select.Item value={CUSTOM_MODEL_VALUE} label="Custom…">
											Custom…
										</Select.Item>
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
							{#if modelCustom}
								<span class="field-row custom-row">
									<Input
										bind:value={values.provider_model}
										placeholder="model id"
										class="field-input"
										data-testid="model-custom-input"
									/>
								</span>
							{/if}
							{#if savedModelWarning()}
								<span class="field-warning" data-testid="model-saved-warning">
									Saved model is not in the detected list — it will be kept until you change it.
								</span>
							{/if}
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
						<pre class="voice-body">{voice.content}</pre>
					{:else}
						<p class="voice-empty">
							No voice has been learned yet. It appears after the agent has observed enough
							of your sent messages to consolidate a style — usually once the memory tick has
							run after a handful of conversations.
						</p>
					{/if}
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
</style>
