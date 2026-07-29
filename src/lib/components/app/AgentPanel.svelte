<script lang="ts">
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { CornerDownLeft, Sparkles, Wrench, TriangleAlert } from '@lucide/svelte';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import type { AppState } from '$lib/client/state.svelte.js';
	import {
		groupTurns,
		hasActiveSessions,
		isTurnInFlight,
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
	 * WS events. The placeholder transcript is gone. Sessions are grouped into
	 * turns by `step-start` / `step-finish` markers; text parts stream as
	 * prose; tool parts render as a compact, legible line each with their
	 * result available. The tool trace IS the interesting output for a meta
	 * agent whose job is taking actions, so it reads like "opened Boris chat,
	 * generated a draft, shortened it" as it happens — not a wall of raw JSON
	 * and not a spinner that hides what is happening.
	 *
	 * THE INPUT STAYS UNWIRED. There is no agent runtime, so the composer
	 * cannot send a message to anything. It stays visibly disabled and clearly
	 * marked. The attachment point for the runtime is `onsubmit` below —
	 * marked `TODO: agent runtime` — and replacing the disabled affordance
	 * with a real send is the join point.
	 */

	let { app }: { app: AppState } = $props();

	// Sessions in stable insertion order; the most recent session last (matches
	// how the dev emitter and a future runtime append).
	const sessions = $derived(Object.values(app.agentSessions));
	const anyActive = $derived(hasActiveSessions(app.agentSessions));
	// True while any turn is mid-flight — drives the header shimmer so a glance
	// at the rail tells the owner the agent is working.
	const working = $derived(
		sessions.some((s) => groupTurns(s.parts).some((t) => isTurnInFlight(t)))
	);

	let value = $state('');

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
	}

	// TODO: agent runtime — when a runtime exists, this is where the panel
	// sends an owner instruction to it. Today there is nothing to send to, so
	// the form is disabled and the textarea reads as a scratchpad. Never fake
	// a reply: the honest "not wired" treatment is a disabled affordance.
	function submit(e: Event) {
		e.preventDefault();
		// Intentionally a no-op until the runtime attaches. Keeping the handler
		// here (rather than deleting the form) makes the join point explicit.
	}
</script>

<section class="agent-pane" aria-label="Agent panel">
	<header class="agent-head">
		<Sparkles class="size-3.5" />
		<span class="agent-title">Agent</span>
		<span class="agent-sub" class:working>
			{#if working}
				<Shimmer children="working…" as="span" />
			{:else}
				not running
			{/if}
		</span>
	</header>

	<div class="agent-scroll scrollbar-contextual" use:scrollActivity>
		{#if !anyActive}
			<!-- The normal resting state: no session yet. Not an error. -->
			<div class="agent-empty" data-testid="agent-empty">
				<Sparkles class="size-5 empty-icon" />
				<p class="empty-title">Agent is idle</p>
				<p class="empty-body">
					When a chat needs a reply, the agent's tool calls and reasoning will stream here.
				</p>
			</div>
		{:else}
			{#each sessions as session (session.sessionId)}
				{@const turns = groupTurns(session.parts)}
				{#each turns as turn (turn.id)}
					<div class="turn" class:in-flight={isTurnInFlight(turn)} data-testid="agent-turn">
						{#each turn.parts as part (part.partId)}
							{#if part.kind === 'text'}
								<Message from="assistant">
									<MessageContent>{part.text}</MessageContent>
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
				{/each}
			{/each}
		{/if}
	</div>

	<!--
	  Panel input — pinned to the bottom of the pane and grows upward. A fixed
	  flex child below the scroll viewport (the same shape as .conv-foot), so it
	  stays on screen at any viewport height and never drifts up the column.
	  The textarea auto-grows with field-sizing-content up to a max, then
	  scrolls internally — the conversation composer's approach. Visibly
	  disabled affordance: the submit button is disabled and the textarea reads
	  as a local scratchpad. The real agent runtime (TODO: agent runtime) will
	  attach at onsubmit and replace the disabled affordance. Do not fake a
	  reply — there is nothing to send to yet.
	-->
	<form class="agent-input" onsubmit={submit}>
		<InputGroup.Root class="agent-field">
			<div class="contents">
				<InputGroup.Textarea
					class="field-sizing-content max-h-40 min-h-12"
					name="agent-message"
					placeholder="Notes to the agent (not wired)…"
					bind:value
					onkeydown={handleKeydown}
					disabled
				/>
			</div>
			<InputGroup.Addon align="block-end" class="justify-end gap-1">
				<InputGroup.Button
					aria-label="Submit"
					size="icon-sm"
					type="submit"
					variant="default"
					class="agent-hero"
					disabled
				>
					<CornerDownLeft class="size-4" />
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	</form>
</section>

<style>
	/* Owns the full pane layout. The `.pane` flex-column rules live in
	   +page.svelte's scoped styles and do not cross into this component, so
	   this is the structural mirror of `.pane` + `.list` from ChatList.svelte:
	   position relative, container-type inline-size, flex column, full height,
	   the same surround (0.6rem) and gap (0.5rem) as the other panes. The
	   recessed surface (sunken fill + inset shadow) is kept from PL-A2 — two
	   recessed rails flank one raised conversation. */
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
	/* The flexible scrolling middle — mirrors .rows in ChatList.svelte: flex 1,
	   min-height 0, overflow-y auto. Absorbs all spare height and scrolls
	   internally when the transcript is long, so a long conversation never
	   pushes the input off screen and a short one never leaves it floating.
	   Uses the scrollbar-contextual utility like every other scroller in the
	   app, so the bar is hidden at rest. */
	.agent-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: 0.75rem 0.9rem;
	}
	/* Empty state — the normal resting state, not an error. Centred and quiet. */
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
	/* A turn is a run of parts bounded by step markers. The gap between turns
	   is wider than the gap between parts inside one, so the reader sees step
	   boundaries as rhythm, not as noise. */
	.turn {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.turn + .turn {
		margin-top: 0.35rem;
		padding-top: 0.55rem;
		border-top: 1px solid var(--hairline-soft);
	}
	/* The compact tool line — the point most likely to be underdone. One row,
	   readable at a glance: icon · name · arg · state · result. The state
	   carries colour so a glance distinguishes done from running from failed
	   without reading the word. The result sits at the right when there is one,
	   available but not shouted. */
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
	/* The input is a fixed flex child below the scroll viewport — the same
	   shape as .conv-foot in the conversation pane — so it stays pinned to the
	   bottom of the pane at all times and never drifts up the column. The top
	   hairline matches the left rail's .list-footer treatment. */
	.agent-input {
		flex: none;
		padding: 0.5rem 0.5rem 0.35rem;
		border-top: 1px solid var(--hairline-soft);
	}
	.agent-input :global(textarea) {
		font-size: 0.82rem;
	}
	/* Same well treatment as the composer field, cut into the sunken surface. */
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