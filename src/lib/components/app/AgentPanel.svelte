<script lang="ts">
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { CornerDownLeft, Eraser, Sparkles, Square, Wrench, TriangleAlert } from '@lucide/svelte';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { AppState } from '$lib/client/state.svelte.js';
	import AgentMarkdown from './AgentMarkdown.svelte';
	import {
		hasActiveSessions,
		isTurnInFlight,
		panelEmptyState,
		panelTimeline,
		toolArgSummary,
		toolResultSummary,
		toolStateLabel
	} from './agent-panel.js';

	/**
	 * PL-U4 — the agent panel: a recessed third pane flanking the conversation.
	 *
	 * LAYOUT. The panel mirrors the left rail (ChatList.svelte), not a third
	 * idiom: a fixed header at the top, a flexible scrolling middle that
	 * absorbs all spare height, and a fixed composer pinned at the bottom. The
	 * pane fills the full column height — it is a rail, not a card pinned to
	 * the ceiling of an empty column. DO NOT restructure this layout — Robert
	 * signed off on it in PL-A3.
	 *
	 * The `.pane` flex-column layout lives in +page.svelte's scoped styles and
	 * does NOT cross into this component, so this component owns its own
	 * identical layout here (height 100%, flex column, the same surround and
	 * gap). The recessed surface (sunken fill + inset shadow) is kept from
	 * PL-A2 — symmetric depth axis: two recessed rails flank one raised
	 * conversation.
	 *
	 * RENDERING. The scroll region renders `AppState.agentSessions` — the real
	 * event stream accumulated by `state.svelte.ts` from `agent-part-updated`
	 * WS events. Sessions are grouped into turns; PANEL-S3 interleaves the
	 * owner's local-echo prompts so ordering is owner → reply across turns.
	 * Agent text is markdown (safe node render, never raw HTML).
	 *
	 * THE INPUT IS WIRED (PL-U7). `submit` below calls `app.sendAgentTurn`.
	 * PANEL-S3: the composer stays typable while a turn runs; submitting then
	 * cancels and starts (steering). Stop still works alone.
	 */

	let { app }: { app: AppState } = $props();

	const sessions = $derived(Object.values(app.agentSessions));
	const anyActive = $derived(
		hasActiveSessions(app.agentSessions) || app.agentOwnerEchoes.length > 0
	);
	const working = $derived(
		sessions.some((s) =>
			panelTimeline(s.parts, []).some((e) => e.kind === 'turn' && isTurnInFlight(e.turn))
		)
	);

	/** Flat timeline across sessions (normally one) with owner echoes interleaved. */
	const timeline = $derived.by(() => {
		const parts = sessions.flatMap((s) => s.parts);
		return panelTimeline(parts, app.agentOwnerEchoes);
	});

	let value = $state('');
	let clearConfirmOpen = $state(false);

	const available = $derived(app.agent.available);
	const running = $derived(app.agent.running);
	const emptyState = $derived(panelEmptyState(app.agent));
	const busy = $derived(running || working);
	/** PANEL-S3 — always submittable when there is text; running no longer blocks. */
	const canSubmit = $derived(available && value.trim().length > 0);
	const canClear = $derived(available && (anyActive || running));

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
	}

	async function submit(e: Event) {
		e.preventDefault();
		const text = value.trim();
		if (!text || !canSubmit) return;
		value = '';
		const started = await app.sendAgentTurn(text);
		if (!started) value = text;
	}

	function cancel() {
		void app.cancelAgentTurn();
	}

	async function confirmClear() {
		const ok = await app.clearAgentPanel();
		if (ok) clearConfirmOpen = false;
	}
</script>

<section class="agent-pane" aria-label="Agent panel">
	<header class="agent-head">
		<Sparkles class="size-3.5" />
		<span class="agent-title">Agent</span>
		<span class="agent-sub" class:working={busy} data-testid="agent-status">
			{#if busy}
				<Shimmer children="working…" as="span" />
			{:else if !available}
				not enabled
			{:else}
				{app.agent.harness ?? 'ready'}
			{/if}
		</span>
		{#if canClear}
			<button
				type="button"
				class="agent-clear"
				aria-label="Clear conversation"
				data-testid="agent-clear"
				onclick={() => (clearConfirmOpen = true)}
			>
				<Eraser class="size-3.5" />
			</button>
		{/if}
	</header>

	<div class="agent-scroll scrollbar-contextual" use:scrollActivity>
		{#if !anyActive}
			<div class="agent-empty" data-testid="agent-empty">
				<Sparkles class="size-5 empty-icon" />
				<p class="empty-title" data-panel-state={emptyState.state}>{emptyState.title}</p>
				<p class="empty-body">{emptyState.body}</p>
			</div>
		{:else}
			{#each timeline as entry, i (entry.kind === 'owner' ? `owner-${entry.messageId}` : entry.turn.id)}
				{#if entry.kind === 'owner'}
					{@const prev = timeline[i - 1]}
					<div
						class="turn owner-turn"
						class:turn-sep={prev !== undefined}
						data-testid="agent-owner-message"
						data-message-id={entry.messageId}
					>
						<Message from="user">
							<MessageContent>{entry.text}</MessageContent>
						</Message>
					</div>
				{:else}
					{@const turn = entry.turn}
					{@const prev = timeline[i - 1]}
					<div
						class="turn"
						class:in-flight={isTurnInFlight(turn)}
						class:turn-sep={prev !== undefined && prev.kind === 'turn'}
						data-testid="agent-turn"
						data-message-id={entry.messageId}
					>
						{#each turn.parts as part (part.partId)}
							{#if part.kind === 'text'}
								<Message from="assistant">
									<MessageContent>
										<AgentMarkdown source={part.text} />
									</MessageContent>
								</Message>
							{:else if part.kind === 'tool'}
								{@const result = toolResultSummary(part)}
								<div
									class="tool-line"
									data-state={part.state}
									data-testid="agent-tool"
									data-tool-name={part.name}
								>
									<span class="tool-icon">
										{#if part.state === 'pending' || part.state === 'running'}
											<Spinner />
										{:else if part.state === 'error'}
											<TriangleAlert class="size-3.5" />
										{:else}
											<Wrench class="size-3.5" />
										{/if}
									</span>
									<span class="tool-name">{part.name}</span>
									{#if toolArgSummary(part.input)}
										<span class="tool-arg">{toolArgSummary(part.input)}</span>
									{/if}
									<span class="tool-state" data-state={part.state}>
										{toolStateLabel(part.state)}
									</span>
									{#if result}
										<span class="tool-result" data-testid="agent-tool-result">
											→ {result}
										</span>
									{/if}
								</div>
							{/if}
						{/each}
						{#if isTurnInFlight(turn) && !turn.parts.some((p) => p.kind === 'tool' && (p.state === 'pending' || p.state === 'running'))}
							<Message from="assistant">
								<MessageContent>
									<Shimmer children="Thinking…" />
								</MessageContent>
							</Message>
						{/if}
					</div>
				{/if}
			{/each}
		{/if}
	</div>

	<form class="agent-input" onsubmit={submit}>
		{#if app.agentError}
			<p class="agent-error" role="status" data-testid="agent-error">
				<TriangleAlert class="size-3" />
				{app.agentError}
			</p>
		{/if}
		<InputGroup.Root class="agent-field">
			<div class="contents">
				<InputGroup.Textarea
					class="field-sizing-content max-h-40 min-h-12"
					name="agent-message"
					placeholder={emptyState.placeholder}
					bind:value
					onkeydown={handleKeydown}
					disabled={!available}
					data-testid="agent-composer"
				/>
			</div>
			<InputGroup.Addon align="block-end" class="justify-end gap-1">
				{#if running}
					<InputGroup.Button
						aria-label="Stop"
						size="icon-sm"
						type="button"
						variant="default"
						class="agent-hero"
						data-testid="agent-stop"
						onclick={cancel}
					>
						<Square class="size-3.5" />
					</InputGroup.Button>
				{/if}
				<InputGroup.Button
					aria-label="Submit"
					size="icon-sm"
					type="submit"
					variant="default"
					class="agent-hero"
					data-testid="agent-submit"
					disabled={!canSubmit}
				>
					<CornerDownLeft class="size-4" />
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>
</section>

<Dialog.Root bind:open={clearConfirmOpen}>
	<Dialog.Content class="agent-clear-dialog" data-testid="agent-clear-dialog">
		<Dialog.Header>
			<Dialog.Title>Clear conversation?</Dialog.Title>
			<Dialog.Description>
				This removes the panel transcript. Nothing is saved — there is no undo.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (clearConfirmOpen = false)}>Cancel</Button>
			<Button variant="destructive" data-testid="agent-clear-confirm" onclick={confirmClear}>
				Clear
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.agent-pane {
		position: relative;
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		height: 100%;
		min-height: 0;
		padding: 0.6rem;
		background: var(--surface-sunken);
		box-shadow: var(--shadow-pressed);
	}
	.agent-head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.1rem 0.25rem 0.55rem;
		border-bottom: 1px solid var(--hairline-soft);
		color: var(--ink-70);
	}
	.agent-title {
		font-weight: 600;
		font-size: 0.82rem;
		color: var(--ink-90);
	}
	.agent-sub {
		font-size: 0.66rem;
		color: var(--ink-50);
		margin-left: auto;
		display: inline-flex;
		align-items: center;
	}
	.agent-sub.working {
		color: var(--cobalt);
	}
	.agent-clear {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		margin-left: 0.15rem;
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--ink-50);
		cursor: pointer;
	}
	.agent-clear:hover {
		color: var(--ink-90);
		background: color-mix(in srgb, var(--ink-50) 12%, transparent);
	}
	.agent-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: 0.75rem 0.9rem;
	}
	.agent-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		text-align: center;
		color: var(--ink-50);
		padding: 1.5rem 1rem;
	}
	.agent-empty :global(.empty-icon) {
		opacity: 0.5;
		margin-bottom: 0.3rem;
	}
	.empty-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--ink-70);
		margin: 0;
	}
	.empty-body {
		font-size: 0.75rem;
		line-height: 1.45;
		margin: 0;
		max-width: 22rem;
	}
	.turn {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.turn.turn-sep {
		margin-top: 0.35rem;
		padding-top: 0.55rem;
		border-top: 1px solid var(--hairline-soft);
	}
	.tool-line {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-raised) 55%, transparent);
		border: 1px solid var(--hairline-soft);
	}
	.tool-icon {
		flex: none;
		display: inline-flex;
		align-items: center;
		color: var(--ink-50);
	}
	.tool-name {
		font-weight: 600;
		color: var(--ink-90);
		font-family: ui-monospace, SFMono-Regular, monospace;
		font-size: 0.74rem;
	}
	.tool-arg {
		color: var(--ink-70);
		font-family: ui-monospace, SFMono-Regular, monospace;
		font-size: 0.72rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 12rem;
	}
	.tool-state {
		font-size: 0.66rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.05rem 0.3rem;
		border-radius: 999px;
		color: var(--ink-50);
		background: color-mix(in srgb, var(--ink-50) 12%, transparent);
	}
	.tool-state[data-state='running'],
	.tool-state[data-state='pending'] {
		color: var(--cobalt);
		background: color-mix(in srgb, var(--cobalt) 12%, transparent);
	}
	.tool-state[data-state='error'] {
		color: var(--destructive);
		background: color-mix(in srgb, var(--destructive) 14%, transparent);
	}
	.tool-result {
		margin-left: auto;
		color: var(--ink-70);
		font-size: 0.72rem;
		font-family: ui-monospace, SFMono-Regular, monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 14rem;
	}
	.tool-line[data-state='error'] .tool-icon {
		color: var(--destructive);
	}
	.agent-input {
		flex: none;
		padding: 0.5rem 0.5rem 0.35rem;
		border-top: 1px solid var(--hairline-soft);
	}
	.agent-input :global(textarea) {
		font-size: 0.82rem;
	}
	.agent-error {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin: 0 0.15rem 0.35rem;
		font-size: 0.7rem;
		line-height: 1.35;
		color: var(--destructive);
	}
	.agent-input :global(.agent-field) {
		background: var(--surface-sunken);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-pressed);
		transition: box-shadow 140ms ease, border-color 140ms ease;
	}
	.agent-input :global(.agent-field:focus-within) {
		border-color: color-mix(in srgb, var(--ring) 45%, var(--hairline));
		box-shadow: var(--shadow-focus);
		--tw-ring-shadow: 0 0 #0000;
	}
	.agent-input :global(.agent-field[data-slot='input-group']:focus-within) {
		outline: none;
	}
	:global(.agent-hero) {
		background-image: linear-gradient(135deg, var(--cobalt-700), var(--cobalt-600));
	}
	:global(.agent-hero:disabled) {
		background-image: none;
	}
</style>
