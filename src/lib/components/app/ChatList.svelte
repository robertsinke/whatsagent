<script lang="ts">
	import { flip } from 'svelte/animate';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Inbox, Search } from '@lucide/svelte';
	import type { Chat } from '$lib/client/types.js';
	import { displayName, filterChats, jidDigits, type ChatTab } from '$lib/client/view.js';
	import ChatRow from './ChatRow.svelte';
	import NeedsReplyTabs from './NeedsReplyTabs.svelte';

	let {
		chats,
		selectedJid = null,
		syncing = false,
		onselect
	}: {
		chats: Chat[];
		selectedJid?: string | null;
		syncing?: boolean;
		onselect?: (jid: string) => void;
	} = $props();

	let tab = $state<ChatTab>('all');
	let query = $state('');
	const now = Date.now();

	const visible = $derived.by(() => {
		const filtered = filterChats(chats, tab);
		const needle = query.trim().toLowerCase();
		if (!needle) return filtered;
		// A digits-only query is a phone-number search: match against the jid with
		// separators stripped, so "+31 6 0000 0002", "31600000002" and "0600000002"
		// all find the same chat. Name search stays the common path and is
		// unaffected — this only adds a second way in for the contacts WhatsApp
		// never gave us a name for.
		const digits = needle.replace(/\D/g, '');
		return filtered.filter((c) => {
			if (displayName(c).toLowerCase().includes(needle)) return true;
			if ((c.preview ?? '').toLowerCase().includes(needle)) return true;
			return digits.length >= 3 && jidDigits(c).includes(digits);
		});
	});

	const emptyCopy = $derived(
		tab === 'needs-reply'
			? {
					title: 'Nothing waiting on you',
					body: 'Chats where the last message is theirs will land here.'
				}
			: syncing
				? { title: 'Still catching up', body: 'Chats appear as history arrives.' }
				: { title: 'No chats', body: 'Once WhatsApp syncs, your conversations show up here.' }
	);
</script>

<div class="list">
	<NeedsReplyTabs {chats} bind:value={tab} />

	<div class="search">
		<Search class="size-3.5 text-ink-50" />
		<Input bind:value={query} placeholder="Search chats" class="search-input" />
	</div>

	<div class="rows">
		{#each visible as chat (chat.jid)}
			<div animate:flip={{ duration: 180 }}>
				<ChatRow {chat} {now} selected={chat.jid === selectedJid} {onselect} />
			</div>
		{:else}
			<Empty.Root class="list-empty">
				<Empty.Header>
					<Empty.Media variant="icon"><Inbox class="size-5" /></Empty.Media>
					<Empty.Title>{emptyCopy.title}</Empty.Title>
					<Empty.Description>{emptyCopy.body}</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/each}
	</div>
</div>

<style>
	.list {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		height: 100%;
		min-height: 0;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 0.15rem;
	}
	:global(.search-input) {
		height: 2rem;
		font-size: 0.82rem;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		padding-right: 0.15rem;
	}
	:global(.list-empty) {
		margin-top: 2rem;
	}
</style>
