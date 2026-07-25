<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { ArrowLeft } from '@lucide/svelte';
	import { goto } from '$app/navigation';
</script>

<main class="page">
	<header class="neumorphic-raised settings-header">
		<Button variant="ghost" size="sm" onclick={() => goto('/')}>
			<ArrowLeft class="size-4" /> Back
		</Button>
		<h1>Settings</h1>
		<p class="subtitle">Phase 1 placeholder — provider pick, pacing, memory land in U6/U10.</p>
	</header>

	<section class="neumorphic-raised settings-body">
		<Tabs.Root value="provider" orientation="vertical" class="h-full">
			<Tabs.List class="flex-col h-full justify-start">
				<Tabs.Trigger value="provider">Provider</Tabs.Trigger>
				<Tabs.Trigger value="pacing">Pacing</Tabs.Trigger>
				<Tabs.Trigger value="memory">Memory</Tabs.Trigger>
			</Tabs.List>
			<Tabs.Content value="provider" class="panel-content">
				<h2>Provider</h2>
				<p class="muted">Draft provider selection (Claude / Codex / Ollama) lands in U7.</p>
			</Tabs.Content>
			<Tabs.Content value="pacing" class="panel-content">
				<h2>Pacing</h2>
				<p class="muted">Outbox send pacing (30–90s jitter) lands in U9.</p>
			</Tabs.Content>
			<Tabs.Content value="memory" class="panel-content">
				<h2>Memory</h2>
				<p class="muted">Voice memory (NullMemory / Hindsight) lands in U10.</p>
			</Tabs.Content>
		</Tabs.Root>
	</section>
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
	:global(.panel-content) {
		padding: 0.5rem 1.25rem;
	}
	:global(.panel-content h2) {
		font-size: 1rem;
		font-weight: 600;
		color: var(--ink-90);
		margin: 0 0 0.4rem;
	}
	.muted {
		color: var(--ink-50);
		font-size: 0.85rem;
	}
</style>