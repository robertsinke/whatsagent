<script lang="ts">
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { CornerDownLeft, Sparkles } from '@lucide/svelte';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	/**
	 * PL-A3 — the agent panel: a recessed third pane flanking the conversation.
	 *
	 * LAYOUT. The panel mirrors the left rail (ChatList.svelte), not a third
	 * idiom: a fixed header at the top, a flexible scrolling middle that
	 * absorbs all spare height, and a fixed composer pinned at the bottom. The
	 * pane fills the full column height — it is a rail, not a card pinned to
	 * the ceiling of an empty column.
	 *
	 * The `.pane` flex-column layout lives in +page.svelte's scoped styles and
	 * does NOT cross into this component, so this component owns its own
	 * identical layout here (height 100%, flex column, the same surround and
	 * gap). The recessed surface (sunken fill + inset shadow) is kept from
	 * PL-A2 — symmetric depth axis: two recessed rails flank one raised
	 * conversation.
	 *
	 * The composer is a fixed flex child below the scroll viewport (the same
	 * shape as .conv-foot / Composer.svelte), so it stays on screen at any
	 * viewport height. The textarea auto-grows upward with
	 * `field-sizing-content` up to a max, then scrolls internally — the
	 * conversation composer's approach, not a second one.
	 *
	 * Structure, collapse behaviour and chat scaffold only — there is no agent
	 * runtime yet, so this renders a PLACEHOLDER transcript. The real event
	 * stream will replace this; the attachment point is marked below
	 * (TODO: PL-A3 agent events).
	 */

	// Local-only placeholder turns. Appending to the input below is the honest
	// "not-yet-wired" treatment: it shows the scaffold round-trips locally
	// without faking a live agent. The real event stream will replace this.
	// The transcript is deliberately long enough to prove the middle scrolls;
	// the copy stays obviously a placeholder, never a fake agent that reads
	// as real.
	type Turn = { id: number; from: 'user' | 'assistant'; text: string };
	let turns = $state<Turn[]>([
		{ id: 1, from: 'assistant', text: 'Draft ready for Anna: "Sounds good — see you at 7."' },
		{ id: 2, from: 'user', text: 'Make it a bit warmer.' },
		{
			id: 3,
			from: 'assistant',
			text:
				'Warmer draft: "Hey Anna — sounds great, looking forward to it. See you at 7! 🙌" (placeholder, not wired)'
		},
		{
			id: 4,
			from: 'user',
			text:
				'Placeholder note: this transcript is a local stub so the scaffold round-trips. The real agent event stream is not wired yet.'
		},
		{
			id: 5,
			from: 'assistant',
			text:
				'Understood — this is still a placeholder. When the agent runtime is attached, draft turns will stream here and the owner will approve from the conversation composer. (stub)'
		},
		{
			id: 6,
			from: 'user',
			text:
				'Another placeholder line so the scroll region is genuinely taller than the pane — proving the middle scrolls and the input stays pinned. (stub)'
		},
		{
			id: 7,
			from: 'assistant',
			text:
				'One more stub turn: the panel should read as a full-height rail symmetric with the left chat list, with the input pinned to the bottom and growing upward. (stub)'
		},
		{
			id: 8,
			from: 'user',
			text:
				'Final placeholder: keep scrolling. The input below must never drift up the column, and a long transcript must never push it off screen. (stub)'
		}
	]);
	let nextId = $state(9);
	let value = $state('');
	let busy = $state(false);

	function submit(e: Event) {
		e.preventDefault();
		const trimmed = value.trim();
		if (!trimmed) return;
		turns = [...turns, { id: nextId++, from: 'user', text: trimmed }];
		value = '';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
	}
</script>

<section class="agent-pane" aria-label="Agent panel">
	<header class="agent-head">
		<Sparkles class="size-3.5" />
		<span class="agent-title">Agent</span>
		<span class="agent-sub">Placeholder · not wired</span>
	</header>

	<div class="agent-scroll scrollbar-contextual" use:scrollActivity>
		{#each turns as turn (turn.id)}
			<Message from={turn.from}>
				<MessageContent>{turn.text}</MessageContent>
			</Message>
		{/each}
		{#if busy}
			<Message from="assistant">
				<MessageContent>
					<Shimmer children="Thinking…" />
				</MessageContent>
			</Message>
		{/if}
	</div>

	<!--
	  Panel input — pinned to the bottom of the pane and grows upward. A fixed
	  flex child below the scroll viewport (the same shape as .conv-foot), so it
	  stays on screen at any viewport height and never drifts up the column.
	  The textarea auto-grows with field-sizing-content up to a max, then
	  scrolls internally — the conversation composer's approach. Visibly
	  disabled affordance: the submit button is disabled and the textarea
	  reads as a local scratchpad. The real event stream (TODO: PL-A3 agent
	  events) will attach at onsubmit and replace the local-append behaviour.
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
					{#if busy}
						<Spinner />
					{:else}
						<CornerDownLeft class="size-4" />
					{/if}
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
		gap: 0.35rem;
		padding: 0.75rem 0.9rem;
	}
	/* The input is a fixed flex child below the scroll viewport — the same
	   shape as .conv-foot in the conversation pane — so it stays pinned to the
	   bottom of the pane at all times and never drifts up the column. The
	   top hairline matches the left rail's .list-footer treatment. */
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