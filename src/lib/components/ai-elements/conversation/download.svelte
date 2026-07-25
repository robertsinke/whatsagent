<script lang="ts" module>
	export type ConversationMessage = {
		role: string;
		parts?: Array<{ type: string; text?: string }>;
		text?: string;
	};

	function getMessageText(message: ConversationMessage): string {
		if (message.text) return message.text;
		return (message.parts ?? [])
			.filter((part) => part.type === 'text')
			.map((part) => part.text ?? '')
			.join('');
	}

	function defaultFormatMessage(message: ConversationMessage): string {
		const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
		return `**${roleLabel}:** ${getMessageText(message)}`;
	}

	export function messagesToMarkdown(
		messages: ConversationMessage[],
		formatMessage: (
			message: ConversationMessage,
			index: number
		) => string = defaultFormatMessage
	): string {
		return messages.map((msg, i) => formatMessage(msg, i)).join('\n\n');
	}
</script>

<script lang="ts">
	import { Download } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/utils';
	import type { ComponentProps, Snippet } from 'svelte';

	type ButtonProps = ComponentProps<typeof Button>;

	let {
		messages = [],
		filename = 'conversation.md',
		formatMessage = defaultFormatMessage,
		class: className = '',
		children,
		...rest
	}: Omit<ButtonProps, 'onclick'> & {
		messages?: ConversationMessage[];
		filename?: string;
		formatMessage?: (message: ConversationMessage, index: number) => string;
		children?: Snippet;
	} = $props();

	function handleDownload() {
		const markdown = messagesToMarkdown(messages, formatMessage);
		const blob = new Blob([markdown], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}
</script>

<Button
	class={cn(
		'absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted',
		className
	)}
	onclick={handleDownload}
	size="icon"
	type="button"
	variant="outline"
	{...rest}
>
	{#if children}
		{@render children()}
	{:else}
		<Download class="size-4" />
	{/if}
</Button>
