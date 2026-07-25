<script lang="ts">
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { BellOff, Pencil } from '@lucide/svelte';
	import type { Chat } from '$lib/client/types.js';
	import { draftBadge, toChatRow } from '$lib/client/view.js';

	let {
		chat,
		selected = false,
		now = Date.now(),
		onselect
	}: {
		chat: Chat;
		selected?: boolean;
		now?: number;
		onselect?: (jid: string) => void;
	} = $props();

	const row = $derived(toChatRow(chat, now));
	const badge = $derived(row.draftStatus ? draftBadge(row.draftStatus) : null);
</script>

<button
	type="button"
	class="chat-row"
	class:selected
	aria-current={selected ? 'true' : undefined}
	onclick={() => onselect?.(row.jid)}
>
	<Avatar class="row-avatar">
		<AvatarFallback>{row.initials}</AvatarFallback>
	</Avatar>

	<span class="row-body">
		<span class="row-top">
			<span class="row-name">{row.name}</span>
			<span class="row-time">{row.time}</span>
		</span>
		<span class="row-bottom">
			<span class="row-preview">{row.preview || 'No messages yet'}</span>
			<span class="row-markers">
				{#if row.muted}
					<BellOff class="size-3 text-ink-50" aria-label="Muted" />
				{/if}
				{#if badge}
					<Badge variant="secondary" class="row-draft">
						<Pencil class="size-3" />
						{badge.label}
					</Badge>
				{/if}
				{#if row.unread > 0}
					<span class="row-unread">{row.unread > 99 ? '99+' : row.unread}</span>
				{/if}
			</span>
		</span>
	</span>
</button>

<style>
	.chat-row {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		width: 100%;
		padding: 0.55rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition:
			background 120ms ease,
			box-shadow 120ms ease,
			border-color 120ms ease;
	}
	.chat-row:hover {
		background: var(--surface-raised);
		border-color: var(--hairline-soft);
	}
	.chat-row:focus-visible {
		outline: 2px solid var(--terracotta);
		outline-offset: 1px;
	}
	/* Pressed = the active chat, per the neumorphic accessibility rule. */
	.chat-row.selected {
		background: var(--surface-sunken);
		border-color: var(--hairline);
		box-shadow: var(--shadow-pressed);
	}

	/* Classes handed to catalog components are invisible to the scoper. */
	:global(.row-avatar) {
		flex: none;
	}
	:global(.row-draft) {
		font-size: 0.62rem;
		gap: 0.2rem;
		padding-inline: 0.35rem;
	}

	.row-body {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}
	.row-top,
	.row-bottom {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.row-name {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--ink-90);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}
	.row-time {
		font-size: 0.68rem;
		color: var(--ink-50);
		flex: none;
	}
	.row-preview {
		font-size: 0.8rem;
		color: var(--ink-70);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}
	.row-markers {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex: none;
	}
	.row-unread {
		min-width: 1.25rem;
		height: 1.25rem;
		padding-inline: 0.35rem;
		border-radius: var(--radius-full, 999px);
		background: var(--terracotta);
		color: var(--surface-raised);
		font-size: 0.66rem;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
</style>
