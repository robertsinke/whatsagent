<script lang="ts">
	import { onMount } from 'svelte';
	import { AppState } from '$lib/client/state.svelte.js';
	import type { AgentPart } from '$lib/client/types.js';

	const app = new AppState();
	let demoStatus = $state<'idle' | 'requested' | 'error'>('idle');
	let demoError = $state<string | null>(null);

	onMount(() => {
		app.start();
		return () => app.stop();
	});

	const sessions = $derived(Object.values(app.agentSessions));

	async function runDemo() {
		demoStatus = 'requested';
		demoError = null;
		try {
			const res = await fetch('/api/dev/agent-demo', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			if (!res.ok) {
				demoStatus = 'error';
				demoError =
					res.status === 404
						? 'Dev emitter off — start preview with WHATSAGENT_DEV_EVENTS=1'
						: `HTTP ${res.status}`;
				return;
			}
		} catch (err) {
			demoStatus = 'error';
			demoError = err instanceof Error ? err.message : String(err);
		}
	}

	function partLabel(part: AgentPart): string {
		switch (part.kind) {
			case 'text':
				return part.text;
			case 'tool':
				return `${part.name} [${part.state}]`;
			case 'step-start':
				return 'step-start';
			case 'step-finish':
				return 'step-finish';
		}
	}
</script>

<main class="trace" data-testid="agent-trace">
	<header class="head">
		<h1>Agent event trace</h1>
		<p>
			Temporary PL-A1 debug page. Streams <code>agent-part-updated</code> into
			<code>AppState.agentSessions</code>. Sibling owns the real panel.
		</p>
		<button type="button" class="run" onclick={() => void runDemo()} data-testid="run-demo">
			Run demo sequence
		</button>
		{#if demoStatus === 'error' && demoError}
			<p class="err" data-testid="demo-error">{demoError}</p>
		{/if}
		<p class="meta" data-testid="selected-jid">
			selectedJid: {app.selectedJid ?? '(none)'}
		</p>
	</header>

	{#if sessions.length === 0}
		<p class="empty" data-testid="trace-empty">No agent parts yet.</p>
	{:else}
		{#each sessions as session (session.sessionId)}
			<section class="session" data-testid="agent-session" data-session={session.sessionId}>
				<h2>{session.sessionId}</h2>
				<ol>
					{#each session.parts as part (part.partId)}
						<li
							class="part"
							data-kind={part.kind}
							data-part-id={part.partId}
							data-testid="agent-part"
						>
							<span class="kind">{part.kind}</span>
							<span class="body">{partLabel(part)}</span>
							{#if part.kind === 'tool'}
								<pre class="tool-io">{JSON.stringify(
									{ input: part.input, output: part.output, error: part.error },
									null,
									2
								)}</pre>
							{/if}
						</li>
					{/each}
				</ol>
			</section>
		{/each}
	{/if}
</main>

<style>
	.trace {
		min-height: 100vh;
		padding: 2rem;
		font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
		background: var(--bg, #fbfbf8);
		color: var(--ink, #1a1a1a);
	}
	.head {
		max-width: 42rem;
		margin-bottom: 2rem;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0 0 0.5rem;
	}
	p {
		margin: 0 0 1rem;
		line-height: 1.45;
		opacity: 0.85;
	}
	.run {
		appearance: none;
		border: none;
		border-radius: 0.5rem;
		padding: 0.6rem 1rem;
		background: var(--primary, #17529b);
		color: var(--primary-foreground, #fbfbf8);
		font-weight: 600;
		cursor: pointer;
	}
	.err {
		color: var(--destructive, #b00020);
		margin-top: 0.75rem;
	}
	.meta {
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
		margin-top: 1rem;
	}
	.empty {
		opacity: 0.6;
	}
	.session h2 {
		font-size: 1rem;
		font-family: ui-monospace, monospace;
		margin: 0 0 0.75rem;
	}
	ol {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-width: 42rem;
	}
	.part {
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		background: var(--surface-raised, #fff);
		border: 1px solid color-mix(in oklab, var(--ink, #1a1a1a) 12%, transparent);
	}
	.kind {
		display: inline-block;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-right: 0.75rem;
		opacity: 0.55;
	}
	.body {
		white-space: pre-wrap;
	}
	.tool-io {
		margin: 0.5rem 0 0;
		font-size: 0.75rem;
		opacity: 0.75;
		overflow: auto;
	}
</style>
