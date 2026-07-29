<script lang="ts">
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Inbox, MessageSquare, Users } from '@lucide/svelte';
	import type { Chat } from '$lib/client/types.js';
	import { tabCounts, type ChatTab } from '$lib/client/view.js';

	let {
		chats,
		value = $bindable('all' as ChatTab)
	}: { chats: Chat[]; value?: ChatTab } = $props();

	const counts = $derived(tabCounts(chats));

	const tabs = $derived([
		{ value: 'all' as const, label: 'All', Icon: MessageSquare, count: counts.all },
		{
			value: 'needs-reply' as const,
			label: 'Needs reply',
			Icon: Inbox,
			count: counts['needs-reply']
		},
		{ value: 'groups' as const, label: 'Groups', Icon: Users, count: counts.groups }
	]);
</script>

<Tabs.Root bind:value={() => value, (v) => (value = v as ChatTab)}>
	<Tabs.List class="tab-list">
		{#each tabs as tab (tab.value)}
			<!-- aria-label + title keep the name when the visible label is clipped
			     by the pane's container query. -->
			<Tabs.Trigger
				value={tab.value}
				class="tab-trigger"
				aria-label={tab.label}
				title={tab.label}
			>
				<tab.Icon class="size-3.5" />
				<span class="tab-label">{tab.label}</span>
				<span class="tab-count">{tab.count}</span>
			</Tabs.Trigger>
		{/each}
	</Tabs.List>
</Tabs.Root>

<style>
	:global(.tab-list) {
		width: 100%;
		/* The tab strip is cut into the recess, not a pill floating on it.
		   Same treatment as the search field below it: hairline, sunken fill,
		   inset shadow, --radius-md. The two read as one well, and the left/
		   right edges align with the chat rows. */
		background: var(--surface-sunken);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-pressed);
	}
	:global(.tab-trigger) {
		flex: 1;
		gap: 0.3rem;
		font-size: 0.78rem;
		min-width: 0;
		/* The trigger has no surface of its own at rest — it is part of the
		   recess. The active state is a shallow raised bevel (the one lifted
		   surface in the well), focus is the cobalt inner glow. No outer ring:
		   it would float on top of the recess language. */
		border-radius: calc(var(--radius-md) - 3px);
	}
	/* Keyboard focus shows the same cobalt inner glow as the search field and
	   the textarea. :focus-visible (not :focus) so a mouse-clicked tab keeps
	   its raised bevel and does not light up — the selected state is the
	   affordance there. Arrow-key navigation both focuses AND activates a tab
	   (bits-ui roving tabindex), so the focused tab is always [data-state=active]
	   too: the combined selector must outrank the bare active rule AND the
	   catalog trigger's data-active:shadow-sm utility, or the bevel/sm shadow
	   wins and the focus glow never paints. !important is the reliable beat
	   against Tailwind utilities on the same property. */
	:global(.tab-trigger[data-state='active']) {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
	}
	:global(.tab-trigger:focus-visible),
	:global(.tab-trigger[data-state='active']:focus-visible) {
		outline: none;
		border-color: color-mix(in srgb, var(--ring) 45%, transparent);
		box-shadow: var(--shadow-focus) !important;
		--tw-ring-shadow: 0 0 #0000;
	}
	.tab-label {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Cobalt chip with white numerals — data, not selection state. Same treatment
	   on every tab whether active or not. Queried against .list's inline-size
	   container (ChatList), not the window — the pane is user-resizable. */
	.tab-count {
		font-size: 0.66rem;
		font-variant-numeric: tabular-nums;
		min-width: 1.5ch;
		line-height: 1.1;
		text-align: center;
		color: var(--primary-foreground);
		background: var(--primary);
		border-radius: 999px;
		padding: 0.12rem 0.35rem;
	}

	/* Below ~260px pane: icon + chip only; label lives in aria-label + title. */
	@container (max-width: 260px) {
		.tab-label {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border: 0;
		}
	}

	/* Below ~200px: tighten the count chip. Trigger px overrides were abandoned —
	   even inline padding:!important on [data-slot=tabs-trigger] still computed to
	   the Tailwind px-1.5 used value in headless Chrome, while this scoped rule
	   in the same @container block applies cleanly. */
	@container (max-width: 200px) {
		.tab-count {
			padding: 0.1rem 0.28rem;
		}
	}
</style>
