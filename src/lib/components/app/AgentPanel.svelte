<script lang="ts">
	import {
		Conversation,
		ConversationContent,
		ConversationScrollButton
	} from '$lib/components/ai-elements/conversation/index.js';
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { CornerDownLeft, Sparkles } from '@lucide/svelte';
	import * as InputGroup from '$lib/components/ui/input-group/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	/**
	 * PL-A2 — the agent panel: a recessed third pane flanking the conversation.
	 * Structure, collapse behaviour and chat scaffold only — there is no agent
	 * runtime yet, so this renders a PLACEHOLDER transcript. A sibling worker is
	 * building the ServerEvent variants that will feed the live transcript in
	 * later; the attachment point is marked below (TODO: PL-A3 agent events).
	 *
	 * The panel is RECESSED into the canvas (matches .list-pane depth), not a
	 * raised card — the owner chose a symmetric depth axis: two recessed rails
	 * flanking one raised conversation, so the conversation stays the figure.
	 */

	// Local-only placeholder turns. Appending to the input below is the honest
	// "not-yet-wired" treatment: it shows the scaffold round-trips locally
	// without faking a live agent. The real event stream will replace this.
	type Turn = { id: number; from: 'user' | 'assistant'; text: string };
	let turns = $state<Turn[]>([
		{ id: 1, from: 'assistant', text: 'Draft ready for Anna: "Sounds good — see you at 7."' },
		{ id: 2, from: 'user', text: 'Make it a bit warmer.' }
	]);
	let nextId = $state(3);
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

<section class="pane agent-pane" aria-label="Agent panel">
	<header class="agent-head">
		<Sparkles class="size-3.5" />
		<span class="agent-title">Agent</span>
		<span class="agent-sub">Placeholder · not wired</span>
	</header>

	<Conversation class="agent-conv">
		<ConversationContent class="agent-content">
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
		</ConversationContent>
		<ConversationScrollButton />
	</Conversation>

	<!--
	  Panel input — a small sibling of Composer, NOT a revival of the deleted
	  prompt-input.svelte primitive. Visibly disabled affordance: the submit
	  button is disabled and the textarea reads as a local scratchpad. The real
	  event stream (TODO: PL-A3 agent events) will attach at onsubmit and replace
	  the local-append behaviour.
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
	.agent-pane {
		/* Matches .list-pane: RECESSED into the canvas, not a raised card.
		   Symmetric depth axis — two recessed rails flank one raised conversation. */
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
	:global(.agent-conv) {
		flex: 1;
		min-height: 0;
	}
	:global(.agent-content) {
		gap: 0.35rem;
		padding: 0.75rem 0.9rem;
	}
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