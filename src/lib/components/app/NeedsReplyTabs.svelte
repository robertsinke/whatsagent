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
</script>

<Tabs.Root bind:value={() => value, (v) => (value = v as ChatTab)}>
	<Tabs.List class="tab-list">
		<Tabs.Trigger value="all" class="tab-trigger">
			<MessageSquare class="size-3.5" />
			All
			<span class="tab-count">{counts.all}</span>
		</Tabs.Trigger>
		<Tabs.Trigger value="needs-reply" class="tab-trigger">
			<Inbox class="size-3.5" />
			Needs reply
			<span class="tab-count">{counts['needs-reply']}</span>
		</Tabs.Trigger>
		<Tabs.Trigger value="groups" class="tab-trigger">
			<Users class="size-3.5" />
			Groups
			<span class="tab-count">{counts.groups}</span>
		</Tabs.Trigger>
	</Tabs.List>
</Tabs.Root>

<style>
	:global(.tab-list) {
		width: 100%;
	}
	:global(.tab-trigger) {
		flex: 1;
		gap: 0.3rem;
		font-size: 0.78rem;
	}
	.tab-count {
		font-size: 0.66rem;
		color: var(--ink-50);
		background: var(--surface-sunken);
		border-radius: 999px;
		padding: 0 0.35rem;
		line-height: 1.25;
	}
</style>
