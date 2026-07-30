<script lang="ts">
	/**
	 * SEC-1 — owner-facing harness tool-surface check.
	 * Plain language: pinned vs detected version, last Tier-1 verdict, re-check.
	 * OpenCode Tier 1 is resolved-config only (weaker than Claude) — stated in UI.
	 */
	import { Button } from '$lib/components/ui/button/index.js';
	import { ShieldCheck, ShieldAlert, LoaderCircle } from '@lucide/svelte';
	import { api } from '$lib/client/api.js';
	import type { ProvidersResponse } from '$lib/client/types.js';
	import {
		ISOLATION_HARNESS_ROWS,
		formatCheckedAt,
		parseIsolationStoreView,
		pinnedFor,
		verdictLabel,
		type IsolationHarness,
		type IsolationReportView,
		type IsolationStoreView,
		type IsolationVerdict
	} from './harness-isolation.js';

	let {
		settingsRaw = null,
		providersSnapshot = null
	}: {
		/** Raw `harness_isolation` settings value (JSON), if present. */
		settingsRaw?: string | null;
		providersSnapshot?: ProvidersResponse | null;
	} = $props();

	let store = $state<IsolationStoreView>({});
	let busy = $state<IsolationHarness | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		store = parseIsolationStoreView(settingsRaw);
	});

	function detectedFromDiscovery(harness: IsolationHarness): string | null {
		const info = providersSnapshot?.providers.find((p) => p.name === harness);
		return info?.version ?? null;
	}

	function reportFor(harness: IsolationHarness): IsolationReportView | undefined {
		return store[harness]?.drafting;
	}

	async function runCheck(harness: IsolationHarness) {
		if (busy) return;
		busy = harness;
		error = null;
		try {
			const result = await api.verifyHarnessIsolation({
				harness,
				surface: 'drafting',
				deep: false
			});
			store = result.store as IsolationStoreView;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = null;
		}
	}

	function verdictAttr(verdict: IsolationVerdict | undefined): string {
		return verdict ?? 'none';
	}
</script>

<div class="iso-card" data-testid="harness-isolation">
	<div class="iso-head">
		<span class="iso-icon"><ShieldCheck class="size-4" /></span>
		<div class="iso-titles">
			<span class="field-label">Harness tool isolation</span>
			<span class="iso-sub">
				Re-check that drafting cannot reach tools or your own MCP servers. Run this after
				bumping a harness version.
			</span>
		</div>
	</div>

	{#each ISOLATION_HARNESS_ROWS as row (row.harness)}
		{@const report = reportFor(row.harness)}
		{@const verdict = report?.verdict}
		{@const detected = report?.detectedVersion ?? detectedFromDiscovery(row.harness)}
		{@const pinned = report?.pinnedVersion ?? pinnedFor(row.harness)}
		<div
			class="iso-row"
			data-testid="harness-isolation-{row.harness}"
			data-verdict={verdictAttr(verdict)}
		>
			<div class="iso-row-main">
				<div class="iso-row-title">
					{#if verdict === 'pass'}
						<span class="iso-status pass" aria-hidden="true"><ShieldCheck class="size-3.5" /></span>
					{:else if verdict === 'fail'}
						<span class="iso-status fail" aria-hidden="true"><ShieldAlert class="size-3.5" /></span>
					{:else}
						<span class="iso-status muted" aria-hidden="true"><ShieldAlert class="size-3.5" /></span>
					{/if}
					<strong>{row.title}</strong>
					<span class="iso-binary">{row.binary}</span>
				</div>
				<p class="iso-verdict" data-testid="harness-isolation-verdict-{row.harness}">
					{verdictLabel(verdict)}
				</p>
				{#if report?.summary}
					<p class="iso-summary">{report.summary}</p>
				{/if}
				<p class="iso-meta">
					Pinned {pinned}
					{#if detected}
						· detected {detected}
					{:else}
						· not detected
					{/if}
					· {formatCheckedAt(report?.checkedAt)}
				</p>
				{#if row.harness === 'codex'}
					<p class="iso-caveat">
						OpenCode’s quick check reads the resolved config, not the tools handed to the
						model — it is weaker than Claude’s. A deep check (terminal:
						<code>npm run verify:harness -- --harness codex --deep</code>) is the behavioral proof.
					</p>
				{/if}
			</div>
			<Button
				size="sm"
				variant="outline"
				onclick={() => runCheck(row.harness)}
				disabled={busy !== null}
				data-testid="harness-isolation-check-{row.harness}"
			>
				{#if busy === row.harness}
					<LoaderCircle class="size-3.5 animate-spin" /> Checking…
				{:else}
					Check isolation
				{/if}
			</Button>
		</div>
	{/each}

	{#if error}
		<p class="iso-error" role="alert">{error}</p>
	{/if}
</div>

<style>
	.iso-card {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1rem 1.1rem;
		border-radius: var(--radius-lg, 12px);
		background: var(--color-background);
		box-shadow: var(--shadow-neumorphic-inset, inset 2px 2px 5px color-mix(in oklab, var(--color-foreground) 8%, transparent));
	}
	.iso-head {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}
	.iso-icon {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		background: color-mix(in oklab, var(--color-primary) 18%, transparent);
		color: var(--color-primary);
		flex-shrink: 0;
	}
	.iso-titles {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.iso-sub {
		font-size: 0.85rem;
		color: var(--color-muted-foreground);
		line-height: 1.4;
	}
	.iso-row {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
		justify-content: space-between;
		padding: 0.75rem 0 0;
		border-top: 1px solid color-mix(in oklab, var(--color-foreground) 8%, transparent);
	}
	.iso-row-main {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.iso-row-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.95rem;
	}
	.iso-binary {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.iso-verdict {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 500;
	}
	.iso-row[data-verdict='pass'] .iso-verdict {
		color: color-mix(in oklab, green 70%, var(--color-foreground));
	}
	.iso-row[data-verdict='fail'] .iso-verdict {
		color: color-mix(in oklab, crimson 75%, var(--color-foreground));
	}
	.iso-summary,
	.iso-meta,
	.iso-caveat {
		margin: 0;
		font-size: 0.8rem;
		color: var(--color-muted-foreground);
		line-height: 1.35;
	}
	.iso-caveat code {
		font-size: 0.75rem;
	}
	.iso-status {
		display: inline-flex;
	}
	.iso-status.pass {
		color: color-mix(in oklab, green 70%, var(--color-foreground));
	}
	.iso-status.fail {
		color: color-mix(in oklab, crimson 75%, var(--color-foreground));
	}
	.iso-status.muted {
		opacity: 0.45;
	}
	.iso-error {
		margin: 0;
		font-size: 0.85rem;
		color: color-mix(in oklab, crimson 80%, var(--color-foreground));
	}
	.field-label {
		font-weight: 600;
		font-size: 0.95rem;
	}
</style>
