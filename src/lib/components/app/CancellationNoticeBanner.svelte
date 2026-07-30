<script lang="ts">
	import { AlertTriangle, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { CancellationNotice, Chat } from '$lib/client/types.js';
	import { displayName } from '$lib/client/view.js';

	/**
	 * PL-U5 — durable warning that the agent cancelled a message the owner had
	 * already approved. Not a toast: survives reload until dismissed. Not a
	 * blocking modal: the decision was warn, not confirm.
	 */
	let {
		notices,
		chats,
		ondismiss,
		onselect
	}: {
		notices: CancellationNotice[];
		chats: Chat[];
		ondismiss?: (id: number) => void | Promise<unknown>;
		onselect?: (jid: string) => void;
	} = $props();

	function chatName(jid: string): string {
		const chat = chats.find((c) => c.jid === jid);
		return chat ? displayName(chat) : jid;
	}
</script>

{#if notices.length}
	<div class="notices" data-testid="cancellation-notices" role="status">
		{#each notices as notice (notice.id)}
			<div class="notice" data-testid="cancellation-notice">
				<div class="notice-head">
					<AlertTriangle class="size-3.5" />
					<span class="notice-title">The agent cancelled a message you had approved</span>
				</div>
				<button
					type="button"
					class="notice-chat"
					onclick={() => onselect?.(notice.chat_jid)}
				>
					{chatName(notice.chat_jid)}
				</button>
				<p class="notice-text">{notice.cancelled_text}</p>
				<div class="notice-actions">
					<Button
						size="sm"
						variant="outline"
						onclick={() => ondismiss?.(notice.id)}
						data-testid="dismiss-cancellation-notice"
					>
						<X class="size-3.5" />
						Got it
					</Button>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	.notices {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: 0 0.15rem;
	}

	.notice {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--cobalt) 35%, var(--hairline));
		background: color-mix(in srgb, var(--cobalt) 10%, var(--surface-sunken));
	}

	.notice-head {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--ink-90);
	}

	.notice-title {
		letter-spacing: 0.01em;
	}

	.notice-chat {
		align-self: flex-start;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--cobalt);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.notice-text {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.4;
		color: var(--ink-90);
		white-space: pre-wrap;
		padding: 0.3rem 0.4rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--hairline);
		max-height: 5.5rem;
		overflow-y: auto;
	}

	.notice-actions {
		display: flex;
		gap: 0.35rem;
	}
</style>
