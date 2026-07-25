<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { Clock, Send, X } from '@lucide/svelte';
	import type { Chat, OutboxRow } from '$lib/client/types.js';
	import { displayName, formatMessageTime } from '$lib/client/view.js';

	let {
		outbox,
		chats,
		oncancel
	}: {
		outbox: OutboxRow[];
		chats: Chat[];
		oncancel?: (id: number) => void;
	} = $props();

	const pending = $derived(outbox.filter((row) => row.status === 'pending'));

	function chatName(jid: string): string {
		const chat = chats.find((c) => c.jid === jid);
		return chat ? displayName(chat) : jid;
	}
</script>

<Sheet.Root>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<Button variant="ghost" size="sm" {...props}>
				<Send class="size-3.5" />
				Outbox
				{#if pending.length}
					<Badge variant="secondary" class="tray-count">{pending.length}</Badge>
				{/if}
			</Button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content side="right" class="tray">
		<Sheet.Header>
			<Sheet.Title>Outbox</Sheet.Title>
			<Sheet.Description>
				Every send — typed or approved — waits here. Queued items can still be cancelled.
			</Sheet.Description>
		</Sheet.Header>

		<div class="tray-rows">
			{#each outbox as row (row.id)}
				<div class="tray-row" class:sent={row.status === 'sent'}>
					<div class="tray-top">
						<span class="tray-name">{chatName(row.chat_jid)}</span>
						<Badge variant={row.status === 'sent' ? 'secondary' : 'outline'} class="tray-status">
							{row.status}
						</Badge>
					</div>
					<p class="tray-text">{row.text}</p>
					<div class="tray-bottom">
						<span class="tray-when">
							<Clock class="size-3" />
							{row.sent_at
								? `sent ${formatMessageTime(row.sent_at)}`
								: `due ${formatMessageTime(row.send_after)}`}
						</span>
						{#if row.status === 'pending'}
							<Button variant="ghost" size="sm" onclick={() => oncancel?.(row.id)}>
								<X class="size-3.5" /> Cancel
							</Button>
						{/if}
					</div>
				</div>
			{:else}
				<p class="tray-empty">Nothing queued.</p>
			{/each}
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	:global(.tray) {
		width: min(420px, 92vw);
	}
	:global(.tray-count) {
		font-size: 0.62rem;
	}
	:global(.tray-status) {
		font-size: 0.62rem;
	}
	.tray-rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 1rem 1rem;
		overflow-y: auto;
	}
	.tray-row {
		border: 1px solid var(--hairline-soft);
		border-radius: var(--radius-md);
		background: var(--surface-raised);
		padding: 0.55rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.tray-row.sent {
		opacity: 0.65;
	}
	.tray-top,
	.tray-bottom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.tray-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--ink-90);
	}
	.tray-text {
		margin: 0;
		font-size: 0.8rem;
		color: var(--ink-70);
		white-space: pre-wrap;
	}
	.tray-when {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.68rem;
		color: var(--ink-50);
	}
	.tray-empty {
		color: var(--ink-50);
		font-size: 0.82rem;
		padding: 0 0.2rem;
	}
</style>
