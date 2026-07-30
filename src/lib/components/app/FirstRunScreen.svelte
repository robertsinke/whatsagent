<script lang="ts">
	/**
	 * OSS-P3.4 — the first-run experience: risk disclosure → drafting setup →
	 * pairing. Rendered instead of the chat shell when {@link isFirstRun} holds,
	 * which is an empty, unlinked app — the natural state of the desktop build,
	 * which keeps its own data directory.
	 *
	 * Three things here are deliberate:
	 *
	 * 1. **The QR is not in the DOM until the last step.** The ban-risk
	 *    disclosure is not a banner beside a scannable code, it is a gate in
	 *    front of it. `{#if step === 'pair'}` is the mechanism.
	 * 2. **Zero detected providers is a supported outcome, not an error.** The
	 *    continue button is always live: drafting off is a usable app, a dead end
	 *    is not.
	 * 3. **Nothing claims the user is logged in.** Provider detection proves a
	 *    binary answered `--version`; `auth` is always `unknown` and is never
	 *    read. See `provider-setup.ts`.
	 */
	import { onMount } from 'svelte';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { AlertTriangle, ArrowLeft, ExternalLink, ShieldAlert, Terminal } from '@lucide/svelte';
	import { api } from '$lib/client/api.js';
	import type { ProvidersResponse, SessionView } from '$lib/client/types.js';
	import PairingScreen from './PairingScreen.svelte';
	import ProviderPicker from './ProviderPicker.svelte';
	import {
		AUTH_DISCLAIMER,
		anyProviderUsable,
		panelSetupSummary,
		providerRoleLabel,
		providerSetupRows,
		setupSummary,
		type ProviderSetupRow
	} from './provider-setup.js';

	let { session, onregenerate }: { session: SessionView; onregenerate?: () => void } = $props();

	type Step = 'risk' | 'providers' | 'pair';
	const STEPS: { id: Step; label: string }[] = [
		{ id: 'risk', label: 'Risk' },
		{ id: 'providers', label: 'Drafting' },
		{ id: 'pair', label: 'Link WhatsApp' }
	];

	/**
	 * Not persisted, on purpose. A reload re-shows the disclosure, which is the
	 * safe direction to fail in — and it keeps first-run free of any stored flag
	 * that could later claim a wiped data directory had already been set up.
	 */
	let step = $state<Step>('risk');

	let snapshot = $state<ProvidersResponse | null>(null);
	let providersLoading = $state(false);
	let providersError = $state<string | null>(null);
	let provider = $state('claude');
	let providerModel = $state('');
	let saveError = $state<string | null>(null);
	let saving = $state(false);

	/** Which missing row has its install panel open (explicit click, not auto). */
	let installOpenFor = $state<string | null>(null);
	let installBusy = $state<string | null>(null);
	let installLog = $state<Record<string, { ok: boolean; output: string; version: string | null; error?: string }>>(
		{}
	);
	let copyFlash = $state<string | null>(null);

	const rows = $derived(providerSetupRows(snapshot));
	const usable = $derived(anyProviderUsable(snapshot));
	const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));
	const panelSummary = $derived(panelSetupSummary(snapshot));

	async function loadProviders(refresh = false) {
		providersLoading = true;
		providersError = null;
		try {
			snapshot = refresh ? await api.refreshProviders() : await api.providers();
		} catch (err) {
			providersError = err instanceof Error ? err.message : String(err);
		} finally {
			providersLoading = false;
		}
	}

	async function copyInstallCommand(row: ProviderSetupRow) {
		if (!row.installCommand) return;
		try {
			await navigator.clipboard.writeText(row.installCommand);
			copyFlash = row.name;
			setTimeout(() => {
				if (copyFlash === row.name) copyFlash = null;
			}, 1500);
		} catch {
			// Fallback: leave the command visible for manual selection.
		}
	}

	/**
	 * ONB-1 — explicit install click. The command was already shown; this is
	 * the only path that runs it. Never a side effect of opening the screen.
	 */
	async function runInstall(row: ProviderSetupRow) {
		if (row.name !== 'claude' && row.name !== 'codex') return;
		if (!row.installCommand) return;
		installBusy = row.name;
		try {
			const result = await api.installProvider(row.name);
			installLog = {
				...installLog,
				[row.name]: {
					ok: result.ok,
					output: result.output || (result.error ?? ''),
					version: result.installedVersion,
					...(result.error ? { error: result.error } : {})
				}
			};
			await loadProviders(true);
		} catch (err) {
			installLog = {
				...installLog,
				[row.name]: {
					ok: false,
					output: err instanceof Error ? err.message : String(err),
					version: null,
					error: err instanceof Error ? err.message : String(err)
				}
			};
		} finally {
			installBusy = null;
		}
	}

	onMount(() => {
		void loadProviders();
		// A fresh app has no saved provider; read anyway so a half-configured one
		// (settings written, never paired) shows what it already has.
		void api
			.settings()
			.then((settings) => {
				provider = settings.provider?.trim() || 'claude';
				providerModel = settings.provider_model ?? '';
			})
			.catch(() => {
				// Non-fatal: the picker still works from the vendored catalog.
			});
	});

	/**
	 * Persist the picked provider, then continue regardless of the outcome —
	 * pairing must never be blocked by a drafting setting. A failed write is
	 * surfaced and left for Settings.
	 */
	async function continueFromProviders() {
		saving = true;
		saveError = null;
		try {
			await api.setSetting('provider', provider);
			await api.setSetting('provider_model', providerModel);
			// Refresh so `restartRequired` reflects what was just written: this
			// process booted before the choice existed.
			await loadProviders();
		} catch (err) {
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
			step = 'pair';
		}
	}
</script>

<div class="first-run scrollbar-contextual" data-testid="first-run" data-step={step} use:scrollActivity>
	<div class="card neumorphic-raised">
		<ol class="stepper" aria-label="Setup progress">
			{#each STEPS as s, i (s.id)}
				<li
					class="step"
					data-state={i === stepIndex ? 'current' : i < stepIndex ? 'done' : 'todo'}
				>
					<span class="step-num">{i + 1}</span>
					<span class="step-label">{s.label}</span>
				</li>
			{/each}
		</ol>

		{#if step === 'risk'}
			<!-- Safety disclosure. Wording follows README's "Safety and risk"
			     section; it is not marketing copy and must not be softened. -->
			<section class="pane" data-testid="risk-disclosure">
				<h1>Before you link your account</h1>

				<div class="risk">
					<p class="risk-head">
						<AlertTriangle class="size-4" />
						<strong>Account-ban risk is real.</strong>
					</p>
					<p>
						whatsagent talks to WhatsApp through
						<a
							href="https://github.com/WhiskeySockets/Baileys"
							target="_blank"
							rel="noopener noreferrer">Baileys</a
						>, an unofficial reimplementation of the WhatsApp Web protocol. WhatsApp does not
						sanction third-party clients and can ban accounts that use them.
					</p>
					<p>
						Repeated re-pairing is the main trigger, more than ordinary message traffic — but
						the risk is never zero, and it is a risk to the phone number you actually use.
					</p>
					<p><strong>Pair only if you accept that.</strong></p>
				</div>

				<h2>What this app will not do</h2>
				<ul class="facts">
					<li>
						<strong>The agent never sends on its own.</strong> Exactly one code path can call
						WhatsApp's send function — the outbox — and its only inputs are messages you
						approved or typed yourself. There is no toggle that makes it autonomous, because
						there is no code to enable.
					</li>
					<li>
						<strong>Sends are human-paced.</strong> Approving ten drafts at once does not
						produce ten instant messages.
					</li>
					<li>
						<strong>Nothing leaves this machine except your own messages.</strong> History
						lives in a local SQLite file, and drafting runs through a CLI you already have
						installed under your own login.
					</li>
				</ul>

				<div class="actions">
					<Button onclick={() => (step = 'providers')} data-testid="accept-risk">
						I understand the risk — continue
					</Button>
				</div>
			</section>
		{:else if step === 'providers'}
			<section class="pane" data-testid="provider-setup">
				<h1>Drafting setup</h1>
				<p class="summary" data-testid="provider-summary">{setupSummary(snapshot)}</p>
				{#if panelSummary}
					<p class="summary panel-summary" data-testid="panel-summary">{panelSummary}</p>
				{/if}

				{#if providersError}
					<p class="warn">Could not scan for drafting tools: {providersError}</p>
				{/if}

				<ul class="providers">
					{#each rows as row (row.name)}
						<li class="provider-row" data-status={row.status} data-testid={`provider-${row.name}`}>
							<div class="provider-main">
								<span class="provider-title">{row.title}</span>
								<span class="provider-roles" data-testid={`roles-${row.name}`}>
									{providerRoleLabel(row.roles)}
								</span>
								<span class="provider-status" data-status={row.status}>{row.statusLabel}</span>
								{#if row.versionMismatch}
									<span class="provider-mismatch" data-testid={`mismatch-${row.name}`}>
										{row.versionMismatch}
									</span>
								{/if}
								{#if row.path}
									<code class="provider-path">{row.path}</code>
								{/if}
								{#if row.hint}
									<span class="provider-hint">
										<Terminal class="size-3" />
										{row.hint}
									</span>
								{/if}

								{#if row.showInstallLink && installOpenFor === row.name}
									<div class="install-panel" data-testid={`install-panel-${row.name}`}>
										{#if row.installCommand}
											<p class="install-lead">
												This runs the vendor’s installer, pinned to v{row.pinnedVersion}.
												Read the command before you run it — nothing runs until you click
												Install.
											</p>
											<pre class="install-command" data-testid={`install-command-${row.name}`}>{row.installCommand}</pre>
											<div class="install-actions">
												<Button
													size="sm"
													variant="outline"
													onclick={() => void copyInstallCommand(row)}
													data-testid={`copy-install-${row.name}`}
												>
													{copyFlash === row.name ? 'Copied' : 'Copy command'}
												</Button>
												<Button
													size="sm"
													onclick={() => void runInstall(row)}
													disabled={installBusy === row.name}
													data-testid={`run-install-${row.name}`}
												>
													{installBusy === row.name ? 'Installing…' : row.installLabel}
												</Button>
											</div>
											{#if installLog[row.name]}
												<pre
													class="install-log"
													data-ok={installLog[row.name].ok}
													data-testid={`install-log-${row.name}`}
												>{installLog[row.name].ok
														? `Installed${installLog[row.name].version ? ` — v${installLog[row.name].version}` : ''}\n`
														: `Failed${installLog[row.name].error ? `: ${installLog[row.name].error}` : ''}\n`}{installLog[row.name].output}</pre>
											{/if}
										{:else}
											<p class="install-lead">{row.installLinkReason}</p>
											<a
												class="install"
												href={row.installUrl}
												target="_blank"
												rel="noopener noreferrer"
												data-testid={`install-${row.name}`}
											>
												{row.installLabel}
												<ExternalLink class="size-3" />
											</a>
										{/if}
									</div>
								{/if}
							</div>
							{#if row.showInstallLink}
								{#if installOpenFor === row.name}
									<Button
										size="sm"
										variant="ghost"
										onclick={() => (installOpenFor = null)}
										data-testid={`hide-install-${row.name}`}
									>
										Hide
									</Button>
								{:else}
									<Button
										size="sm"
										variant="outline"
										onclick={() => (installOpenFor = row.name)}
										data-testid={`show-install-${row.name}`}
									>
										{row.installLabel}
									</Button>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>

				<p class="disclaimer">{AUTH_DISCLAIMER}</p>

				{#if usable}
					<div class="picker">
						<ProviderPicker
							bind:provider
							bind:providerModel
							{snapshot}
							loading={providersLoading}
							error={providersError}
							onrescan={(refresh) => void loadProviders(refresh)}
						/>
					</div>
				{:else}
					<div class="picker rescan-only">
						<Button
							size="sm"
							variant="outline"
							onclick={() => void loadProviders(true)}
							disabled={providersLoading}
							data-testid="providers-rescan"
						>
							{providersLoading ? 'Scanning…' : 'Re-scan'}
						</Button>
						<p class="disclaimer">
							Nothing to choose yet. Install one of the three above and pick it in Settings —
							the app works either way, with drafting off.
						</p>
					</div>
				{/if}

				{#if saveError}
					<p class="warn">Could not save the drafting choice: {saveError}. Set it in Settings.</p>
				{/if}

				<div class="actions">
					<Button variant="ghost" size="sm" onclick={() => (step = 'risk')}>
						<ArrowLeft class="size-4" /> Back
					</Button>
					<Button
						onclick={() => void continueFromProviders()}
						disabled={saving}
						data-testid="continue-to-pairing"
					>
						{usable ? 'Continue to pairing' : 'Continue without drafting'}
					</Button>
				</div>
			</section>
		{:else}
			<section class="pane pair-pane" data-testid="pair-step">
				<!-- The disclosure is a gate, but it is also worth repeating at the
				     moment of the scan itself. -->
				<p class="risk-reminder" role="note">
					<ShieldAlert class="size-4" />
					<span>
						Scanning links this device through an unofficial client. Account bans are a real
						risk, and frequent re-pairing is the main trigger — pair once and stay paired.
					</span>
				</p>

				{#if snapshot?.restartRequired}
					<p class="disclaimer" data-testid="restart-after-pairing">
						Drafting uses the provider this process started with. Restart the app once to pick
						up the choice you just made.
					</p>
				{/if}

				<PairingScreen {session} {onregenerate} />

				<div class="actions">
					<Button variant="ghost" size="sm" onclick={() => (step = 'providers')}>
						<ArrowLeft class="size-4" /> Back to drafting setup
					</Button>
				</div>
			</section>
		{/if}
	</div>
</div>

<style>
	.first-run {
		flex: 1;
		min-height: 0;
		display: grid;
		place-items: start center;
		overflow-y: auto;
		padding: 1.25rem 1rem 2rem;
	}
	.card {
		border-radius: var(--radius-lg);
		padding: 1.4rem 1.5rem 1.2rem;
		width: 100%;
		max-width: 620px;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.stepper {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		align-items: center;
		gap: 1.1rem;
	}
	.step {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.75rem;
		color: var(--ink-50);
	}
	.step[data-state='current'] {
		color: var(--ink-90);
		font-weight: 600;
	}
	.step[data-state='done'] {
		color: var(--ink-70);
	}
	.step-num {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		font-size: 0.68rem;
		background: var(--surface-raised);
		box-shadow: var(--shadow-bevel);
	}
	.step[data-state='current'] .step-num {
		background: var(--cobalt);
		/* --primary-foreground is the raised surface (near-white in light,
		   near-black in dark) — the same token every cobalt-filled control in
		   the app uses for its label. The previous hardcoded #fbfbf8 was a
		   light-only value: on dark cobalt-400 it dropped to 2.83:1 (below AA). */
		color: var(--primary-foreground);
	}

	.pane {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.pair-pane {
		gap: 0.6rem;
	}
	h1 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		color: var(--ink-90);
	}
	h2 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--ink-90);
	}

	.risk {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--destructive) 40%, var(--hairline));
		background: color-mix(in srgb, var(--destructive) 8%, var(--surface-raised));
		padding: 0.75rem 0.85rem;
	}
	.risk p {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--ink-90);
	}
	.risk-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--destructive);
	}
	.risk a {
		color: inherit;
		text-decoration: underline;
	}

	.facts {
		margin: 0;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: 0.78rem;
		line-height: 1.5;
		color: var(--ink-70);
	}

	.summary {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--ink-90);
	}
	.panel-summary {
		font-size: 0.78rem;
		color: var(--ink-70);
	}
	.warn {
		margin: 0;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--destructive);
	}
	.disclaimer {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--ink-50);
	}

	.providers {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.provider-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
		padding: 0.6rem 0.7rem;
	}
	.provider-main {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		flex: 1;
	}
	.provider-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--ink-90);
	}
	.provider-roles {
		font-size: 0.68rem;
		color: var(--ink-50);
	}
	.provider-status {
		font-size: 0.75rem;
		color: var(--ink-70);
	}
	/* This palette has no green: the "good" tone elsewhere in the app is just
	   stronger ink (see SessionStatus), and cobalt carries every warning. */
	.provider-status[data-status='detected'] {
		color: var(--ink-80);
		font-weight: 600;
	}
	.provider-status[data-status='not_running'] {
		color: var(--cobalt);
	}
	.provider-mismatch {
		font-size: 0.72rem;
		line-height: 1.4;
		color: var(--cobalt);
	}
	.provider-path {
		font-size: 0.68rem;
		color: var(--ink-50);
		overflow-wrap: anywhere;
	}
	.provider-hint {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.72rem;
		color: var(--ink-70);
	}
	.install {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		color: var(--ink-90);
		text-decoration: underline;
		white-space: nowrap;
	}
	.install-panel {
		margin-top: 0.45rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: 0.55rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--hairline);
		background: color-mix(in srgb, var(--surface-raised) 70%, var(--surface));
	}
	.install-lead {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.45;
		color: var(--ink-70);
	}
	.install-command {
		margin: 0;
		padding: 0.5rem 0.55rem;
		border-radius: var(--radius-sm);
		background: var(--surface);
		border: 1px solid var(--hairline-soft);
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--ink-90);
		overflow-x: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.install-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.install-log {
		margin: 0;
		max-height: 8rem;
		overflow: auto;
		padding: 0.45rem 0.5rem;
		border-radius: var(--radius-sm);
		font-size: 0.65rem;
		line-height: 1.4;
		color: var(--ink-70);
		background: var(--surface);
		border: 1px solid var(--hairline-soft);
		white-space: pre-wrap;
	}
	.install-log[data-ok='false'] {
		color: var(--destructive);
		border-color: color-mix(in srgb, var(--destructive) 40%, var(--hairline));
	}

	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		border-top: 1px solid var(--hairline-soft);
		padding-top: 0.8rem;
	}
	/* Zero providers: a lone Re-scan, kept button-sized rather than stretched
	   across the card by the column. Scoped to this branch so it cannot reach
	   the shared picker's own row-aligned buttons. */
	.rescan-only :global(button) {
		align-self: flex-start;
	}

	.risk-reminder {
		margin: 0;
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--destructive) 40%, var(--hairline));
		background: color-mix(in srgb, var(--destructive) 8%, var(--surface-raised));
		padding: 0.6rem 0.7rem;
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--ink-90);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
