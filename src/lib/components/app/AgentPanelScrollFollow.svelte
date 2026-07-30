<script lang="ts">
	/**
	 * PANEL-S8 — scroll-follow for the agent panel, using the conversation pane's
	 * ConversationContext rather than a second scroll implementation.
	 *
	 * Renders nothing. Mounted inside <Conversation> so it can read the shared
	 * viewport context; AgentPanel owns the timeline markup beside it.
	 */
	import { getContext, tick } from 'svelte';
	import {
		CONVERSATION_CTX,
		type ConversationContext
	} from '$lib/components/ai-elements/conversation/context.js';
	import {
		panelContentSignature,
		panelScrollFollowDecision,
		type PanelTimelineEntry
	} from './agent-panel.js';

	let { timeline }: { timeline: PanelTimelineEntry[] } = $props();

	const ctx = getContext<ConversationContext>(CONVERSATION_CTX);

	let prevEntryCount = 0;
	let prevContentSig = '';
	let primed = false;

	$effect(() => {
		const entryCount = timeline.length;
		const contentSig = panelContentSignature(timeline);

		if (entryCount === 0) {
			prevEntryCount = 0;
			prevContentSig = '';
			primed = false;
			return;
		}

		const decision = panelScrollFollowDecision({
			prevEntryCount,
			entryCount,
			prevContentSig,
			contentSig,
			isAtBottom: ctx.isAtBottom,
			firstPaint: !primed
		});

		prevEntryCount = entryCount;
		prevContentSig = contentSig;
		primed = true;

		if (decision === 'none') return;
		// Instant: agent text parts re-arrive as growing snapshots many times a
		// second. Smooth scrolling would fight itself (and the owner) on every tick.
		void tick().then(() => ctx.scrollToBottom('instant'));
	});
</script>
