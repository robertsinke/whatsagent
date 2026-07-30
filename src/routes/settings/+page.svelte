<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import {
		ArrowLeft,
		Bot,
		Check,
		Eye,
		Pencil,
		Radio,
		RefreshCw,
		ShieldAlert,
		Sparkles,
		X
	} from '@lucide/svelte';
	import {
		api,
		type VoiceDocumentResponse,
		type VoiceSaveResponse,
		type VoiceSuggestion
	} from '$lib/client/api.js';
	import { ApiError, type AgentStatus, type ProvidersResponse } from '$lib/client/types.js';
	// OSS-P3.4 — the provider + model control is shared with first-run setup.
	// Do not re-implement it here; the two screens must not drift apart.
	import ProviderPicker from '$lib/components/app/ProviderPicker.svelte';
	import MarkdownEditor from '$lib/components/app/MarkdownEditor.svelte';

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

	/** P3.2 GET shape — hash/mirrorGuard/memory are what the editor round-trips on. */
	type VoiceView = VoiceDocumentResponse;

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

	/**
	 * PANEL-S1 — the agent panel's opt-in. Three rows (`panel_enabled`,
	 * `panel_harness`, `panel_model`).
	 *
	 * PANEL-S2: writing one of them reconciles the running panel inside the same
	 * request, so the saved value and the running process cannot disagree. This
	 * is re-fetched after every panel write and describes what IS running — never
	 * a client-side guess at what the write will eventually produce.
	 */
	let agentStatus = $state<AgentStatus | null>(null);
	/**
	 * Harness ids are not provider ids: discovery's `codex` slot holds the
	 * OpenCode binary (see BINARY_NAMES in providers/discovery.ts), so the
	 * panel's `opencode` harness is gated on `codex` being installed. Mirrors
	 * PANEL_HARNESS_PROVIDERS on the server.
	 */
	const PANEL_HARNESSES = [
		{ value: 'opencode', label: 'OpenCode', provider: 'codex', binary: 'opencode' },
		{ value: 'claude', label: 'Claude Code', provider: 'claude', binary: 'claude' }
	] as const;
	const installedHarnesses = $derived(
		PANEL_HARNESSES.filter((h) =>
			(providersSnapshot?.providers ?? []).some((p) => p.name === h.provider && p.installed)
		)
	);
	const panelEnabled = $derived(values.panel_enabled === 'true');
	/** Only offer Save once a harness is chosen — an enabled row with none is the warn-and-stay-off path. */
	const panelHarnessChosen = $derived(
		PANEL_HARNESSES.some((h) => h.value === values.panel_harness)
	);
	const runningHarnessLabel = $derived(
		agentStatus?.available && panelEnabled
			? (PANEL_HARNESSES.find((h) => h.value === values.panel_harness)?.label ?? null)
			: null
	);

	/**
	 * P3.4 Voice tab — editable with explicit save (never autosave). Conflict half
	 * of SlayZone's useWatchedFile: baseline hash, in-flight dedupe, ignore-own-echo,
	 * diskChanged banner with Reload / Keep mine. Autosave is deliberately NOT
	 * ported: every save also writes a durable Hindsight directive.
	 */
	let settingsTab = $state('agent');
	let voice = $state<VoiceView | null>(null);
	let voiceLoading = $state(true);
	let voiceError = $state<string | null>(null);
	let voiceMode = $state<'view' | 'edit'>('view');
	/** Live draft — what the editor holds / what Save writes. */
	let voiceDraft = $state('');
	/** Content as last loaded or successfully saved — dirty = draft !== baseline. */
	let voiceBaseline = $state('');
	/** SHA-256 from the server; sent back as baseHash on PUT. */
	let voiceBaseHash = $state('');
	let voiceDirty = $derived(voiceDraft !== voiceBaseline);
	let voiceDiskChanged = $state(false);
	/** Content/hash on disk when a conflict was detected (Reload takes these). */
	let voiceConflict = $state<{ content: string; hash: string } | null>(null);
	let voiceSaving = $state(false);
	/** Dedupes identical in-flight saves (Strict-mode / double Cmd-S). */
	let voiceSavingTarget: string | null = null;
	let voiceSavedFlash = $state(false);
	let voiceSaveError = $state<string | null>(null);
	/** Last successful save — drives guard-state line + shape warning + directive copy. */
	let voiceLastSave = $state<VoiceSaveResponse | null>(null);
	let voiceRefreshing = $state(false);
	let voiceRefreshNote = $state<string | null>(null);
	/** PL-U5 — pending agent suggestions; inert until promote/discard. */
	let voiceSuggestions = $state<VoiceSuggestion[]>([]);
	let voiceSuggestionBusyId = $state<string | null>(null);
	/** Live Milkdown instance — Save reads currentMarkdown() so the draft cannot lag the DOM. `$state.raw` so bind:this identity stays a plain ref (not a deep proxy). */
	let voiceEditor = $state.raw<{ currentMarkdown?: () => string } | null>(null);

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

	async function loadAgentStatus() {
		try {
			agentStatus = await api.agentStatus();
		} catch {
			// Enrichment only: an older server or a failed call leaves the banner
			// off rather than claiming a state we cannot observe.
			agentStatus = null;
		}
	}

	/**
	 * Writing the enable row without a harness produces a startup warning and no
	 * panel, so the toggle writes both in one gesture: turning it on with exactly
	 * one harness installed picks that one. Never silently picks between two.
	 */
	async function togglePanel(next: boolean) {
		if (next && !panelHarnessChosen && installedHarnesses.length === 1) {
			values.panel_harness = installedHarnesses[0]!.value;
			await save('panel_harness');
		}
		values.panel_enabled = next ? 'true' : 'false';
		await save('panel_enabled');
	}

	function applyVoiceDocument(doc: VoiceView) {
		voice = doc;
		const content = doc.content ?? '';
		voiceDraft = content;
		voiceBaseline = content;
		voiceBaseHash = doc.hash;
		voiceDiskChanged = false;
		voiceConflict = null;
		voiceSaveError = null;
		voiceSuggestions = doc.suggestions ?? [];
	}

	async function loadVoice() {
		voiceLoading = true;
		voiceError = null;
		try {
			applyVoiceDocument(await api.voiceGlobal());
		} catch (err) {
			voiceError = err instanceof Error ? err.message : String(err);
		} finally {
			voiceLoading = false;
		}
	}

	/**
	 * Poll for disk moves under an open editor (mirror tick, another tab, or a
	 * hand rewrite). There is no file-watcher WS event for voice/, so this is
	 * the conflict half of useWatchedFile. Skips while a save is in flight so
	 * our own write is not flagged as a conflict (ignore-own-echo).
	 */
	async function pollVoiceDisk() {
		if (settingsTab !== 'voice' || voiceSaving || voiceSavingTarget !== null) return;
		if (!voice || voice.content === null) return;
		try {
			const doc = await api.voiceGlobal();
			// Suggestions can arrive without the document body moving.
			if (doc.hash === voiceBaseHash) {
				voiceSuggestions = doc.suggestions ?? [];
				return;
			}
			// Disk moved. Dirty OR an unresolved conflict banner → keep the banner;
			// clean with no banner → silent reload (useWatchedFile contract).
			// Without the voiceDiskChanged arm, a 409 on a clean Save (stale
			// baseHash, draft === baseline) would set the banner and then the
			// next poll would auto-reload and wipe it.
			if (voiceDirty || voiceDiskChanged) {
				voiceDiskChanged = true;
				voiceConflict = { content: doc.content ?? '', hash: doc.hash };
				voice = { ...doc, content: voice.content };
			} else {
				applyVoiceDocument(doc);
			}
		} catch {
			// Transient — next tick retries. Don't surface as voiceError mid-edit.
		}
	}

	function onVoiceDraftChange(markdown: string) {
		voiceDraft = markdown;
	}

	async function saveVoiceDocument() {
		if (!voice || voice.content === null) return;
		// Prefer the live editor serialization when mounted — see MarkdownEditor.currentMarkdown.
		if (voiceMode === 'edit' && voiceEditor?.currentMarkdown) {
			try {
				voiceDraft = voiceEditor.currentMarkdown();
			} catch {
				// Fall through with the last onchange draft.
			}
		}
		const target = voiceDraft;
		// In-flight dedupe: identical concurrent saves collapse to one PUT.
		if (voiceSavingTarget === target) return;
		voiceSavingTarget = target;
		voiceSaving = true;
		voiceSaveError = null;
		try {
			const result = await api.saveVoice(target, voiceBaseHash);
			// Only advance the baseline if no newer keystrokes landed during the save.
			if (voiceDraft === target) {
				voiceBaseline = target;
				voiceBaseHash = result.hash;
				voiceDiskChanged = false;
				voiceConflict = null;
			} else {
				// Newer edits — still adopt the new hash so the next save is not a
				// spurious 409 against our own write.
				voiceBaseHash = result.hash;
			}
			if (voice) {
				voice = {
					...voice,
					hash: result.hash,
					byteLength: result.byteLength,
					modifiedAt: result.modifiedAt,
					mirrorGuard: result.mirrorGuard,
					content: voiceDraft === target ? target : voice.content
				};
			}
			voiceLastSave = result;
			voiceSavedFlash = true;
			setTimeout(() => (voiceSavedFlash = false), 1500);
		} catch (err) {
			const status =
				err instanceof ApiError
					? err.status
					: typeof err === 'object' && err && 'status' in err
						? Number((err as { status: unknown }).status)
						: 0;
			const body =
				err instanceof ApiError
					? err.body
					: typeof err === 'object' && err && 'body' in err
						? ((err as { body: Record<string, unknown> }).body ?? {})
						: {};
			if (status === 409) {
				voiceDiskChanged = true;
				voiceConflict = {
					content: typeof body.content === 'string' ? body.content : '',
					hash: typeof body.hash === 'string' ? body.hash : voiceBaseHash
				};
				voiceSaveError =
					'The file changed on disk since you loaded it. Reload or keep your edit, then save again.';
			} else {
				voiceSaveError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			if (voiceSavingTarget === target) voiceSavingTarget = null;
			voiceSaving = false;
		}
	}

	function reloadVoiceFromDisk() {
		if (!voiceConflict) {
			void loadVoice();
			return;
		}
		voiceDraft = voiceConflict.content;
		voiceBaseline = voiceConflict.content;
		voiceBaseHash = voiceConflict.hash;
		voiceDiskChanged = false;
		voiceConflict = null;
		voiceSaveError = null;
		voiceLastSave = null;
		if (voice) {
			voice = {
				...voice,
				content: voiceDraft,
				hash: voiceBaseHash,
				byteLength: new TextEncoder().encode(voiceDraft).length
			};
		}
	}

	/** Keep local draft; adopt the disk hash so the next save overwrites with ours. */
	function keepMineVoice() {
		if (voiceConflict) {
			voiceBaseHash = voiceConflict.hash;
		}
		voiceDiskChanged = false;
		voiceConflict = null;
		voiceSaveError = null;
	}

	async function refreshVoiceNow() {
		voiceRefreshing = true;
		voiceRefreshNote = null;
		try {
			const result = await api.refreshVoice();
			if (!result.available) {
				voiceRefreshNote =
					'No memory service is available — nothing to refresh. Your file on disk is unchanged.';
			} else if (result.error) {
				voiceRefreshNote = `Refresh failed: ${result.error}`;
			} else {
				voiceRefreshNote =
					'Refresh requested. The regenerated document lands on a later mirror tick — not immediately. If a hand edit is guarded, the guard holds until the model actually moves on.';
			}
		} catch (err) {
			voiceRefreshNote = err instanceof Error ? err.message : String(err);
		} finally {
			voiceRefreshing = false;
		}
	}

	async function promoteVoiceSuggestion(id: string) {
		if (voiceSuggestionBusyId) return;
		voiceSuggestionBusyId = id;
		voiceSaveError = null;
		try {
			const result = await api.promoteVoiceSuggestion(id);
			voiceSuggestions = result.suggestions;
			const content = result.content ?? '';
			voiceDraft = content;
			voiceBaseline = content;
			voiceBaseHash = result.hash;
			voiceDiskChanged = false;
			voiceConflict = null;
			if (voice) {
				voice = {
					...voice,
					content: result.content,
					hash: result.hash,
					byteLength: result.byteLength,
					modifiedAt: result.modifiedAt,
					mirrorGuard: result.mirrorGuard,
					suggestions: result.suggestions
				};
			}
		} catch (err) {
			voiceSaveError = err instanceof Error ? err.message : String(err);
		} finally {
			voiceSuggestionBusyId = null;
		}
	}

	async function discardVoiceSuggestion(id: string) {
		if (voiceSuggestionBusyId) return;
		voiceSuggestionBusyId = id;
		try {
			const result = await api.discardVoiceSuggestion(id);
			voiceSuggestions = result.suggestions;
		} catch (err) {
			voiceSaveError = err instanceof Error ? err.message : String(err);
		} finally {
			voiceSuggestionBusyId = null;
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

	/** Memory mode from the voice GET — drives the three honest help states. */
	function voiceMemoryMode(): string {
		return voice?.memory.mode ?? values.memory ?? 'hindsight';
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
		void loadAgentStatus();

		const onKey = (e: KeyboardEvent) => {
			if (settingsTab !== 'voice' || voiceMode !== 'edit') return;
			if ((e.metaKey || e.ctrlKey) && e.key === 's') {
				e.preventDefault();
				void saveVoiceDocument();
			}
		};
		window.addEventListener('keydown', onKey);
		const poll = setInterval(() => void pollVoiceDisk(), 2500);
		return () => {
			window.removeEventListener('keydown', onKey);
			clearInterval(poll);
		};
	});

	// Prefetch Milkdown chunks when the Voice tab is selected — ProseMirror is
	// the largest thing in the bundle and lives on one tab of one route.
	$effect(() => {
		if (settingsTab !== 'voice') return;
		void Promise.all([
			import('@milkdown/core'),
			import('@milkdown/preset-commonmark'),
			import('@milkdown/preset-gfm'),
			import('@milkdown/plugin-history'),
			import('@milkdown/plugin-listener'),
			import('@milkdown/utils')
		]);
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
			// PANEL-S2: the write reconfigured the runtime server-side, so re-ask
			// what is running rather than deriving it here from what we just wrote.
			if (key.startsWith('panel_')) void loadAgentStatus();
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
		<Tabs.Root bind:value={settingsTab}>
			<Tabs.List class="settings-tabs">
				<Tabs.Trigger value="agent">Agent</Tabs.Trigger>
				<Tabs.Trigger value="safety">Safety</Tabs.Trigger>
				<Tabs.Trigger value="voice">Voice</Tabs.Trigger>
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

				<!--
				  PANEL-S1 — the agent panel's opt-in, and the only one there is: the
				  old WHATSAGENT_MCP=1 instruction was unreachable from a double-clicked
				  .app. This is a capability AND a spend decision, so the copy states
				  both what the panel can do and what it structurally cannot, rather
				  than leaving the owner to infer either.
				-->
				<div class="panel-card" data-enabled={panelEnabled} data-testid="agent-panel-setting">
					<div class="panel-head">
						<span class="panel-icon" data-enabled={panelEnabled}><Bot class="size-4" /></span>
						<div class="panel-titles">
							<span class="field-label">Agent panel</span>
							<span class="panel-state" data-testid="panel-runtime-state">
								{#if agentStatus?.available}
									<!-- `agentStatus.harness` is TURN state and is null while idle, so
									     the name comes from the saved row — which PANEL-S2 keeps in step
									     with what is running, because the write that changed the row is
									     the write that rebuilt the panel. With no row (the developer
									     path) there is no name to claim, so none is claimed. -->
									Running now{runningHarnessLabel ? ` on ${runningHarnessLabel}` : ''}.
								{:else}
									Not running.
								{/if}
							</span>
						</div>
					</div>

					<p class="panel-help">
						Turning this on gives you a chat panel next to your conversations. It can read
						your chats, generate and refine drafts, and propose a send for your approval.
					</p>
					<p class="panel-help">
						<strong>It can never send, and it can never approve its own proposal.</strong> That
						is structural — every message still leaves only after you press send or approve —
						not something this setting can change.
					</p>
					<p class="panel-help">
						It runs by spawning the coding-agent CLI you pick below, under the subscription
						you are already logged into there. Every turn costs whatever that subscription
						charges for it.
					</p>

					{#if installedHarnesses.length === 0}
						<!-- Never an empty picker: name the binaries, so the owner has
						     something to go and install. Derived from the same list the
						     picker filters, so the two cannot name different CLIs. -->
						<p class="panel-warn" data-testid="panel-no-harness">
							No harness found. Install
							{#each PANEL_HARNESSES as harness, i (harness.value)}<code>{harness.binary}</code
								>{i < PANEL_HARNESSES.length - 1 ? ' or ' : ''}{/each} and press Re-scan above —
							the panel needs one of them to run.
						</p>
					{:else}
						<label class="field">
							<span class="field-label">Harness</span>
							<span class="field-row">
								<Select.Root type="single" bind:value={values.panel_harness}>
									<Select.Trigger class="field-select" data-testid="panel-harness-select">
										{installedHarnesses.find((h) => h.value === values.panel_harness)?.label ??
											'Select a harness'}
									</Select.Trigger>
									<Select.Content>
										{#each installedHarnesses as harness (harness.value)}
											<Select.Item value={harness.value} label={harness.label} />
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									size="sm"
									variant="outline"
									data-testid="panel-harness-save"
									onclick={() => save('panel_harness')}
								>
									{#if saved === 'panel_harness'}
										<Check class="size-3.5" /> Saved
									{:else}
										Save
									{/if}
								</Button>
							</span>
							<span class="field-help">
								Only installed CLIs are listed. Ollama is not offered here: the panel needs a
								tool surface, and Ollama models reach one by running inside OpenCode.
							</span>
						</label>

						<label class="field">
							<span class="field-label">Panel model (optional)</span>
							<span class="field-row">
								<Input
									bind:value={values.panel_model}
									placeholder="harness default"
									class="field-input"
								/>
								<Button
									size="sm"
									variant="outline"
									data-testid="panel-model-save"
									onclick={() => save('panel_model')}
								>
									{#if saved === 'panel_model'}
										<Check class="size-3.5" /> Saved
									{:else}
										Save
									{/if}
								</Button>
							</span>
							<span class="field-help">
								Leave empty to use whatever the harness defaults to. Free text on purpose — a
								model released today must be settable without a new build.
							</span>
						</label>

						<div class="panel-controls">
							<Button
								size="sm"
								variant={panelEnabled ? 'outline' : 'default'}
								data-testid="panel-toggle"
								disabled={!panelEnabled && !panelHarnessChosen && installedHarnesses.length !== 1}
								onclick={() => togglePanel(!panelEnabled)}
							>
								{#if panelEnabled}
									Turn the agent panel off
								{:else}
									Turn the agent panel on
								{/if}
							</Button>
							{#if saved === 'panel_enabled'}
								<span class="panel-saved"><Check class="size-3.5" /> Saved</span>
							{:else if !panelEnabled && !panelHarnessChosen && installedHarnesses.length !== 1}
								<!-- Disabled on purpose: enabling with no harness writes a row the
								     boot path warns about and refuses to act on. Say which of the
								     two fields is missing rather than leaving a dead button. -->
								<span class="panel-hint" data-testid="panel-needs-harness">Pick a harness first.</span>
							{/if}
						</div>

						<p class="panel-help" data-testid="panel-apply-note">
							Changes here take effect immediately — turning the panel on starts it,
							turning it off stops it and ends any turn it was running.
						</p>
					{/if}
				</div>
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
						<div class="voice-help">
							<p>
								This is the markdown file drafting actually reads (decision D2): a mirror of the
								Hindsight mental model. You can edit and save it here — Save writes the file and
								arms a mirror guard so the next tick does not silently overwrite your correction.
							</p>
							{#if voiceMemoryMode() === 'hindsight'}
								<p>
									Memory is <strong>hindsight</strong>: a successful save is protected until the
									next refresh incorporates your correction into the model. Until then the guard
									holds the mirror off this file.
								</p>
							{:else if voiceMemoryMode() === 'off' || voiceMemoryMode() === 'null'}
								<p>
									Memory is <strong>{voiceMemoryMode()}</strong>: nothing will ever overwrite this
									file from a model — your edit is permanent on disk. There is no Hindsight
									directive to record.
								</p>
							{:else}
								<p>
									Memory mode is <strong>{voiceMemoryMode()}</strong>. Persistence of a hand edit
									depends on whether a memory service is available to record the correction.
								</p>
							{/if}
							{#if voiceLastSave?.directive === 'failed'}
								<p class="voice-help-warn" role="status">
									Last save wrote the file but the correction directive <strong>failed</strong> —
									the edit is on disk and guarded for now, but it is <strong>not</strong> permanent
									in memory. When memory reconnects, mirroring can resume and may eventually move
									past this guard if the model never absorbs the correction. Retry Save once
									Hindsight is back, or use Refresh now after it recovers.
								</p>
							{:else if voiceLastSave?.directive === 'skipped'}
								<p role="status">
									Last save wrote the file; no memory service was wired, so no directive was
									recorded. With memory off/null that is expected — the file is the source of
									truth.
								</p>
							{/if}
						</div>
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
							<div>
								<dt>Mirror</dt>
								<dd>{voice.mirrorGuard ? 'guarded (hand edit held)' : 'open'}</dd>
							</div>
						</dl>

						<div class="voice-toolbar">
							<div class="voice-mode-toggle" role="group" aria-label="View or edit">
								<Button
									size="sm"
									variant={voiceMode === 'view' ? 'default' : 'outline'}
									onclick={() => (voiceMode = 'view')}
								>
									<Eye class="size-3.5" /> View
								</Button>
								<Button
									size="sm"
									variant={voiceMode === 'edit' ? 'default' : 'outline'}
									onclick={() => (voiceMode = 'edit')}
								>
									<Pencil class="size-3.5" /> Edit
								</Button>
							</div>
							<div class="voice-toolbar-actions">
								<Button
									size="sm"
									variant="outline"
									disabled={voiceRefreshing}
									onclick={() => void refreshVoiceNow()}
								>
									<RefreshCw class="size-3.5" />
									{voiceRefreshing ? 'Refreshing…' : 'Refresh now'}
								</Button>
								{#if voiceMode === 'edit'}
									<Button
										size="sm"
										disabled={voiceSaving}
										onclick={() => void saveVoiceDocument()}
									>
										{#if voiceSavedFlash}
											<Check class="size-3.5" /> Saved
										{:else if voiceSaving}
											Saving…
										{:else}
											Save
										{/if}
									</Button>
								{/if}
							</div>
						</div>

						{#if voiceDiskChanged}
							<div class="voice-conflict" role="alert" data-testid="voice-conflict">
								<p>
									The file changed on disk while you were editing. Reload to take the disk
									version, or Keep mine to keep your draft (the next Save will overwrite disk).
								</p>
								<div class="voice-conflict-actions">
									<Button size="sm" variant="outline" onclick={reloadVoiceFromDisk}>Reload</Button>
									<Button size="sm" onclick={keepMineVoice}>Keep mine</Button>
								</div>
							</div>
						{/if}

						{#if voiceSuggestions.length}
							<div class="voice-suggestions" data-testid="voice-suggestions">
								<p class="voice-suggestions-label">
									<Sparkles class="size-3.5" />
									Agent suggestions — inert until you promote one into the document
								</p>
								{#each voiceSuggestions as suggestion (suggestion.id)}
									<div class="voice-suggestion" data-testid="voice-suggestion">
										<p class="voice-suggestion-text">{suggestion.text}</p>
										<div class="voice-suggestion-actions">
											<Button
												size="sm"
												disabled={voiceSuggestionBusyId !== null}
												onclick={() => void promoteVoiceSuggestion(suggestion.id)}
											>
												<Check class="size-3.5" />
												Promote
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={voiceSuggestionBusyId !== null}
												onclick={() => void discardVoiceSuggestion(suggestion.id)}
											>
												<X class="size-3.5" />
												Discard
											</Button>
										</div>
									</div>
								{/each}
							</div>
						{/if}

						{#if voiceSaveError}
							<p class="error" role="alert">{voiceSaveError}</p>
						{/if}

						{#if voiceRefreshNote}
							<p class="voice-refresh-note" role="status">{voiceRefreshNote}</p>
						{/if}

						{#if voiceLastSave}
							<p class="voice-guard-line" role="status">
								{#if voiceLastSave.mirrorGuard}
									Mirror guard is on — your hand edit is held against the next mirror tick.
								{:else}
									Mirror guard is off.
								{/if}
								Directive: {voiceLastSave.directive}.
							</p>
							{#if !voiceLastSave.looksLikeVoiceDocument}
								<p class="voice-shape-warn" role="alert">
									Warning: the saved text does not look like a voice document (tables/habits
									shape). The save still succeeded — check that the editor did not mangle the
									GFM tables before relying on this draft.
								</p>
							{/if}
						{/if}

						{#if voiceMode === 'view'}
							<pre class="voice-body scrollbar-contextual" use:scrollActivity>{voiceDraft}</pre>
						{:else}
							<div class="voice-editor">
								<MarkdownEditor
									bind:this={voiceEditor}
									value={voiceDraft}
									onchange={onVoiceDraftChange}
									variant="inline"
									readability="compact"
									width="wide"
									class="voice-mk"
								/>
							</div>
							<p class="voice-save-hint muted">
								Explicit Save only — Cmd/Ctrl+S also saves. No autosave (each save records a
								durable memory directive).
							</p>
						{/if}
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
		height: 100dvh;
		/* overflow: both axes — .page is a flex item of .app-shell, so the
		   flexbox automatic minimum size on the cross axis (width) defaults to
		   min-content and refuses to shrink below a wide child (a long
		   unbreakable token inside the Voice Milkdown). `overflow-y: auto`
		   alone leaves overflow-x at visible → CSS computes it to `auto` when
		   the other axis is non-visible, BUT the flex min-width:auto still
		   holds, so the item still grows to min-content. Declaring the
		   shorthand sets both axes explicitly AND pairs with `min-width: 0`
		   below to kill the flex auto-min — the same idiom as .field-select.
		   The max-width:720px ceiling is unchanged (it is a ceiling that gets
		   hit, not the cause). */
		overflow: auto;
		min-width: 0;
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
		/* `.page` is a 100dvh flex column, so this section defaults to
		   `flex-shrink: 1` and is squeezed to whatever height is left — its
		   content then spills OUT of the raised surface and paints against the
		   page background, rounded bottom edge and all. Pre-existing (the Voice
		   tab already overflowed by ~90px); PANEL-S1 made it obvious because the
		   Agent tab grew past the viewport too. `.page` already scrolls, so the
		   fix is to stop shrinking and let it. */
		flex-shrink: 0;
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

	/* PANEL-S1 — agent panel opt-in. Same card idiom as the send-mode card, and
	   the same cobalt "this is on" accent, so the two capability switches in
	   Settings read as one family rather than two inventions. */
	.panel-card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.7rem 0.8rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
	}
	.panel-card[data-enabled='true'] {
		border-color: color-mix(in srgb, var(--cobalt) 45%, var(--hairline));
		background: color-mix(in srgb, var(--cobalt) 6%, var(--surface-raised));
	}
	.panel-head {
		display: flex;
		gap: 0.55rem;
		align-items: flex-start;
	}
	.panel-icon {
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
	.panel-icon[data-enabled='true'] {
		color: var(--cobalt);
		background: color-mix(in srgb, var(--cobalt) 14%, transparent);
	}
	.panel-titles {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.panel-state {
		font-size: 0.78rem;
		color: var(--ink-70);
		line-height: 1.35;
	}
	.panel-help {
		font-size: 0.72rem;
		color: var(--ink-50);
		margin: 0;
		line-height: 1.4;
	}
	.panel-help strong {
		color: var(--ink-70);
		font-weight: 600;
	}
	.panel-warn {
		font-size: 0.72rem;
		color: var(--ink-70);
		margin: 0;
		line-height: 1.4;
	}
	.panel-warn code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.95em;
	}
	.panel-controls {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.panel-saved {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.72rem;
		color: var(--cobalt);
	}
	.panel-hint {
		font-size: 0.72rem;
		color: var(--ink-50);
	}

	/* W4-U10 / P3.4 — voice inspector + editor tab */
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
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.voice-help p {
		margin: 0;
	}
	.voice-help-warn {
		/* Cobalt carries every warning in this app (see DeepenHistoryButton,
		   ProviderPicker field-warning, OutboxTray). The previous #b45309 was a
		   warm amber ported from another project: in dark mode its mix onto
		   --hairline/#0b0e12 collapsed to a muddy brown the canvas swallowed. */
		color: color-mix(in srgb, var(--cobalt) 85%, var(--ink-70));
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
	.voice-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.voice-mode-toggle,
	.voice-toolbar-actions,
	.voice-conflict-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.voice-conflict {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: 0.55rem 0.65rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--cobalt) 45%, var(--hairline));
		background: color-mix(in srgb, var(--cobalt) 8%, var(--surface-sunken));
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--ink-90);
	}
	.voice-conflict p {
		margin: 0;
	}
	.voice-suggestions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.55rem 0.65rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}
	.voice-suggestions-label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--ink-70);
	}
	.voice-suggestion {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.45rem 0.5rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
	}
	.voice-suggestion-text {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--ink-90);
		white-space: pre-wrap;
	}
	.voice-suggestion-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.voice-refresh-note,
	.voice-guard-line {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--ink-70);
	}
	.voice-shape-warn {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.4;
		color: color-mix(in srgb, var(--cobalt) 90%, var(--ink-90));
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
	.voice-editor {
		max-height: 26rem;
		overflow: auto;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline-soft);
		background: var(--surface-sunken);
	}
	:global(.voice-mk) {
		min-height: 12rem;
	}
	:global(.voice-mk .mk-doc-scroll) {
		max-height: 24rem;
	}
	.voice-save-hint {
		margin: 0;
		font-size: 0.7rem;
	}
	.voice-empty {
		font-size: 0.82rem;
		color: var(--ink-70);
		margin: 0;
		line-height: 1.45;
		padding: 0.4rem 0;
	}
</style>
