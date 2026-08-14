<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { api } from '$lib/client/api.js';
	import { phoneFailCopy, startChatFailureCopy } from '$lib/client/start-chat-copy.js';
	import type { Chat } from '$lib/client/types.js';
	import { normalizePhone } from '../../../../shared/phone.js';

	let { onstarted }: { onstarted?: (chat: Chat) => void | Promise<unknown> } = $props();

	let open = $state(false);
	let phone = $state('');
	let submitting = $state(false);
	let submitError = $state<string | null>(null);

	const parsed = $derived(normalizePhone(phone));
	const inlineHint = $derived(
		phone.trim() && !parsed.ok ? phoneFailCopy(parsed.reason) : null
	);
	const canSubmit = $derived(parsed.ok && !submitting);

	$effect(() => {
		if (!open) {
			phone = '';
			submitError = null;
			submitting = false;
		}
	});

	async function submit(e: Event) {
		e.preventDefault();
		if (!parsed.ok || submitting) return;
		submitting = true;
		submitError = null;
		try {
			const result = await api.startChat(phone);
			open = false;
			await onstarted?.(result.chat);
		} catch (error) {
			submitError = startChatFailureCopy(error);
		} finally {
			submitting = false;
		}
	}
</script>

<Button
	variant="outline"
	size="sm"
	class="new-chat-trigger"
	data-testid="new-chat"
	onclick={() => (open = true)}
>
	<Plus class="size-3.5" />
	New chat
</Button>
<Dialog.Root bind:open>
	<Dialog.Content class="new-chat-dialog" data-testid="new-chat-dialog">
		<Dialog.Header>
			<Dialog.Title>New chat</Dialog.Title>
			<Dialog.Description>
				Start a conversation with a number in full international form. A country code is
				required — none is assumed.
			</Dialog.Description>
		</Dialog.Header>
		<form class="new-chat-form" onsubmit={submit}>
			<label class="field" for="new-chat-phone">
				<span class="field-label">Phone number</span>
				<Input
					id="new-chat-phone"
					data-testid="new-chat-phone"
					type="tel"
					autocomplete="tel"
					inputmode="tel"
					placeholder="+31 6 …"
					autofocus
					bind:value={phone}
					aria-invalid={inlineHint || submitError ? true : undefined}
					aria-describedby={inlineHint || submitError ? 'new-chat-status' : undefined}
				/>
			</label>
			{#if inlineHint || submitError}
				<p
					id="new-chat-status"
					class="new-chat-status"
					data-testid="new-chat-error"
					role="alert"
				>
					{submitError ?? inlineHint}
				</p>
			{/if}
			<Dialog.Footer class="new-chat-footer">
				<Button
					type="submit"
					data-testid="new-chat-submit"
					disabled={!canSubmit}
				>
					{submitting ? 'Starting…' : 'Start chat'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.new-chat-trigger) {
		width: 100%;
		justify-content: center;
		font-size: 0.78rem;
		border-color: var(--hairline);
		background: var(--surface-raised);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	:global(.new-chat-trigger:hover),
	:global(.new-chat-trigger:focus-visible) {
		border-color: color-mix(in srgb, var(--ring) 45%, var(--hairline));
		box-shadow: var(--shadow-focus);
	}
	.new-chat-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.field-label {
		font-size: 0.78rem;
		color: var(--ink-70);
	}
	.new-chat-status {
		margin: 0;
		font-size: 0.78rem;
		color: var(--destructive);
	}
	:global(.new-chat-footer) {
		margin-top: 0.25rem;
	}
</style>
