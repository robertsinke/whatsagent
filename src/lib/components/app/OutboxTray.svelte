<script lang="ts">
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import { AlertTriangle, Clock, RotateCcw, Send, X } from '@lucide/svelte';
	import type { Chat, OutboxRow } from '$lib/client/types.js';
	import { displayName, formatMessageTime } from '$lib/client/view.js';

	let {
		outbox,
		chats,
		oncancel,
		onretry
	}: {
		outbox: OutboxRow[];
		chats: Chat[];
		oncancel?: (id: number) => void;
		onretry?: (id: number) => void;
	} = $props();

	const pending = $derived(outbox.filter((row) => row.status === 'pending'));
	/**
	 * OUTBOX-1: the collapsed chip is the only outbox surface the owner sees
	 * without opening the sheet, so a message that never went must be visible
	 * here. A failed count overrides the pending tint — "one did not send" is
	 * more urgent than "three are queued".
	 */
	const failed = $derived(outbox.filter((row) => row.status === 'failed'));

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
				data-has-failed={failed.length ? true : undefined}
				aria-label="Outbox{failed.length
					? `, ${failed.length} failed`
					: ''}{pending.length ? `, ${pending.length} pending` : ''}"
				title="Outbox{failed.length ? ` · ${failed.length} failed` : ''}{pending.length
					? ` · ${pending.length} pending`
					: ''}"
				{...props}
			>
				{#if failed.length}
					<AlertTriangle class="size-3" />
				{:else}
					<Send class="size-3" />
				{/if}
				<span class="chip-label">Outbox</span>
				{#if failed.length}
					<Badge variant="destructive" class="tray-count">{failed.length}</Badge>
				{:else if pending.length}
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
				<div
					class="tray-row"
					class:sent={row.status === 'sent'}
					class:failed={row.status === 'failed'}
				>
					<div class="tray-top">
						<span class="tray-name">{chatName(row.chat_jid)}</span>
						<Badge
							variant={row.status === 'failed'
								? 'destructive'
								: row.status === 'sent'
									? 'secondary'
									: 'outline'}
							class="tray-status"
						>
							{row.source} · {row.status}
						</Badge>
					</div>
					<p class="tray-text">{row.text}</p>
					<!-- OUTBOX-1: the reason, not just the state — "failed" alone leaves
					     the owner unable to tell a dropped socket from a bad payload. -->
					{#if row.status === 'failed'}
						<p class="tray-error">
							<AlertTriangle class="size-3" />
							<span>
								Not sent after {row.attempts}
								{row.attempts === 1 ? 'attempt' : 'attempts'}{row.last_error
									? `: ${row.last_error}`
									: '.'}
							</span>
						</p>
					{/if}
					<div class="tray-bottom">
						<span class="tray-when">
							<Clock class="size-3" />
							{#if row.sent_at}
								sent {formatMessageTime(row.sent_at)}
							{:else if row.failed_at}
								failed {formatMessageTime(row.failed_at)}
							{:else}
								due {formatMessageTime(row.send_after)}
							{/if}
						</span>
						{#if row.status === 'pending'}
							<Button variant="ghost" size="sm" onclick={() => oncancel?.(row.id)}>
								<X class="size-3.5" /> Cancel
							</Button>
						{:else if row.status === 'failed'}
							<span class="tray-actions">
								<Button variant="ghost" size="sm" onclick={() => onretry?.(row.id)}>
									<RotateCcw class="size-3.5" /> Retry
								</Button>
								<Button variant="ghost" size="sm" onclick={() => oncancel?.(row.id)}>
									<X class="size-3.5" /> Discard
								</Button>
							</span>
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
	/* Trigger chip: matches SendModeIndicator / SessionStatus so all footer
	   controls read as one row. Icon-only; `.chip-label` stays in the DOM as the
	   accessible name but is permanently visually hidden (F10: hover reveal
	   widened chips and shifted neighbours — tooltip carries the word). The
	   pending count badge stays visible — a count is meaningful even when the
	   word is clipped. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
		/* Transparent at rest so the control sits IN the recessed footer rather
		   than floating on it as a pill. Hover lifts it to the raised surface —
		   that is the hover affordance (F10: the label no longer expands).
		   Semantic states (live, warn, bad) re-assert their own border and tint
		   below — those carry meaning and must stay visible at rest. */
		border: 1px solid transparent;
		background: transparent;
		box-shadow: none;
		color: var(--ink-70);
		cursor: default;
		white-space: nowrap;
		font-family: inherit;
		line-height: 1;
	}
	.chip:hover,
	.chip:focus-visible {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	.chip[data-has-pending] {
		border-color: color-mix(in srgb, var(--cobalt) 40%, var(--hairline));
		color: var(--cobalt);
	}
	/* OUTBOX-1 — a send that will never go is the one outbox state the owner
	   must not have to open the sheet to notice. Same `bad` tone SessionStatus
	   uses, and it out-specifies the pending tint on purpose: written after it,
	   equal specificity, so a tray holding both reads as failed. */
	.chip[data-has-failed] {
		border-color: var(--destructive);
		color: var(--destructive);
	}
	.chip[data-has-failed]:hover,
	.chip[data-has-failed]:focus-visible {
		color: var(--destructive);
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
		border: 0;
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
	.tray-row.failed {
		border-color: color-mix(in srgb, var(--destructive) 45%, var(--hairline));
	}
	.tray-error {
		margin: 0;
		display: flex;
		align-items: flex-start;
		gap: 0.3rem;
		font-size: 0.72rem;
		line-height: 1.35;
		color: var(--destructive);
		overflow-wrap: anywhere;
	}
	.tray-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
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
