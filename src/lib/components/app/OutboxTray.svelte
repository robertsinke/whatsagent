<script lang="ts">
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
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
			<button
				type="button"
				class="chip"
				data-has-pending={pending.length ? true : undefined}
				aria-label="Outbox{pending.length ? `, ${pending.length} pending` : ''}"
				title="Outbox{pending.length ? ` · ${pending.length} pending` : ''}"
				{...props}
			>
				<Send class="size-3" />
				<span class="chip-label">Outbox</span>
				{#if pending.length}
					<Badge variant="secondary" class="tray-count">{pending.length}</Badge>
				{/if}
			</button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content side="right" class="tray">
		<Sheet.Header>
			<Sheet.Title>Outbox</Sheet.Title>
			<Sheet.Description>
				Approved drafts are paced. Typed sends jump the queue immediately through the
				same outbox — nothing bypasses it.
			</Sheet.Description>
		</Sheet.Header>

		<div class="tray-rows scrollbar-contextual" use:scrollActivity>
			{#each outbox as row (row.id)}
				<div class="tray-row" class:sent={row.status === 'sent'}>
					<div class="tray-top">
						<span class="tray-name">{chatName(row.chat_jid)}</span>
						<Badge variant={row.status === 'sent' ? 'secondary' : 'outline'} class="tray-status">
							{row.source} · {row.status}
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
	/* Trigger chip: matches SendModeIndicator / SessionStatus so all four footer
	   controls read as one row. Icon-only at rest; label reveals on hover/focus.
	   The pending count badge stays visible — a count is meaningful even when the
	   word is clipped. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		background: var(--surface-raised);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-70);
		cursor: default;
		white-space: nowrap;
		font-family: inherit;
		line-height: 1;
	}
	.chip:hover,
	.chip:focus-visible {
		color: var(--ink-90);
	}
	.chip[data-has-pending] {
		border-color: color-mix(in srgb, var(--cobalt) 40%, var(--hairline));
		color: var(--cobalt);
	}
	.chip-label {
		white-space: nowrap;
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
	.chip:hover .chip-label,
	.chip:focus-visible .chip-label,
	.chip:focus-within .chip-label {
		position: static;
		width: auto;
		height: auto;
		margin: 0;
		overflow: visible;
		clip: auto;
	}
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
