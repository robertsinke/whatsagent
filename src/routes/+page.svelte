<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import * as Item from '$lib/components/ui/item/index.js';
	import { Avatar, AvatarFallback, AvatarBadge } from '$lib/components/ui/avatar/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import {
		Conversation,
		ConversationContent,
		ConversationScrollButton
	} from '$lib/components/ai-elements/conversation/index.js';
	import Message from '$lib/components/ai-elements/message.svelte';
	import MessageContent from '$lib/components/ai-elements/message-content.svelte';
	import PromptInput from '$lib/components/ai-elements/prompt-input.svelte';
	import { Pencil, Send, Inbox, Users } from '@lucide/svelte';

	type DemoChat = {
		name: string;
		initials: string;
		preview: string;
		time: string;
		unread: number;
		hasDraft: boolean;
	};

	const chats: DemoChat[] = [
		{ name: 'Maya Rivera', initials: 'MR', preview: 'Did you send the brief?', time: '2m', unread: 2, hasDraft: true },
		{ name: 'Tom K.', initials: 'TK', preview: 'ok 👍', time: '1h', unread: 0, hasDraft: false },
		{ name: 'Design Sync', initials: 'DS', preview: 'Aiko: updated the figma', time: '3h', unread: 5, hasDraft: false }
	];

	let composerValue = $state('');
	let composerStatus = $state<'ready' | 'submitted' | 'streaming' | 'error'>('ready');
</script>

<main class="page">
	<header class="page-header neumorphic-raised">
		<div class="brand">
			<span class="brand-dot"></span>
			<h1>WhatsAgent</h1>
			<Badge variant="secondary" class="ml-auto">Scaffold · U1</Badge>
		</div>
		<p class="subtitle">
			Neumorphic token layer rendering against copied catalog components — Phase 1 shell.
		</p>
	</header>

	<div class="grid">
		<section class="panel neumorphic-raised list-panel">
			<Tabs.Root value="all">
				<Tabs.List class="w-full">
					<Tabs.Trigger value="all" class="flex-1">All</Tabs.Trigger>
					<Tabs.Trigger value="needs" class="flex-1">
						<Inbox class="size-3.5 inline-block mr-1 -mt-0.5" />Needs reply
						<Badge variant="secondary" class="ml-1.5">{chats.filter((c) => c.hasDraft).length}</Badge>
					</Tabs.Trigger>
					<Tabs.Trigger value="groups" class="flex-1">
						<Users class="size-3.5 inline-block mr-1 -mt-0.5" />Groups
					</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="all" class="mt-3">
					<Item.Root class="gap-1">
						{#each chats as chat (chat.name)}
							<Item.Content class="chat-row" tabindex={0}>
								<Item.Media>
									<Avatar>
										<AvatarFallback>{chat.initials}</AvatarFallback>
										{#if chat.unread}
											<AvatarBadge>{chat.unread}</AvatarBadge>
										{/if}
									</Avatar>
								</Item.Media>
								<Item.Header>
									<Item.Title class="chat-name">{chat.name}</Item.Title>
									<Item.Description class="chat-preview">{chat.preview}</Item.Description>
								</Item.Header>
								<Item.Actions class="chat-actions">
									<span class="chat-time">{chat.time}</span>
									{#if chat.hasDraft}
										<Badge variant="default" class="draft-badge">
											<Pencil class="size-3" />draft
										</Badge>
									{/if}
								</Item.Actions>
							</Item.Content>
						{/each}
					</Item.Root>
				</Tabs.Content>
				<Tabs.Content value="needs" class="mt-3">
					<Item.Root class="gap-1">
						{#each chats.filter((c) => c.hasDraft) as chat (chat.name)}
							<Item.Content class="chat-row" tabindex={0}>
								<Item.Media>
									<Avatar>
										<AvatarFallback>{chat.initials}</AvatarFallback>
										<AvatarBadge>{chat.unread}</AvatarBadge>
									</Avatar>
								</Item.Media>
								<Item.Header>
									<Item.Title class="chat-name">{chat.name}</Item.Title>
									<Item.Description class="chat-preview">{chat.preview}</Item.Description>
								</Item.Header>
								<Item.Actions class="chat-actions">
									<Badge variant="default" class="draft-badge">
										<Pencil class="size-3" />draft
									</Badge>
								</Item.Actions>
							</Item.Content>
						{/each}
					</Item.Root>
				</Tabs.Content>
				<Tabs.Content value="groups" class="mt-3">
					<Item.Root class="gap-1">
						{#each chats.filter((_, i) => i === 2) as chat (chat.name)}
							<Item.Content class="chat-row" tabindex={0}>
								<Item.Media>
									<Avatar><AvatarFallback>{chat.initials}</AvatarFallback></Avatar>
								</Item.Media>
								<Item.Header>
									<Item.Title class="chat-name">{chat.name}</Item.Title>
									<Item.Description class="chat-preview">{chat.preview}</Item.Description>
								</Item.Header>
								<Item.Actions class="chat-actions">
									<Badge variant="secondary">{chat.unread} unread</Badge>
								</Item.Actions>
							</Item.Content>
						{/each}
					</Item.Root>
				</Tabs.Content>
			</Tabs.Root>
		</section>

		<section class="panel neumorphic-raised conversation-panel">
			<div class="conv-header">
				<Avatar class="size-8"><AvatarFallback>MR</AvatarFallback></Avatar>
				<div>
					<div class="conv-name">Maya Rivera</div>
					<div class="conv-status">online</div>
				</div>
			</div>
			<Conversation class="conv-body">
				<ConversationContent>
					<Message from="assistant">
						<MessageContent>Did you send the brief?</MessageContent>
					</Message>
					<Message from="user">
						<MessageContent>Not yet — pulling the latest numbers now.</MessageContent>
					</Message>
					<Message from="assistant">
						<MessageContent>No rush, just wanted to check.</MessageContent>
					</Message>
					<Message from="assistant">
						<MessageContent class="draft-bubble">
							<div class="draft-label"><Pencil class="size-3" /> Draft</div>
							<div class="drafting-text">Drafting a reply…</div>
						</MessageContent>
					</Message>
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>
			<div class="composer neumorphic-bevel">
				<PromptInput
					bind:value={composerValue}
					status={composerStatus}
					placeholder="Type a reply, or approve the draft above…"
					onsubmit={(m) => {
						composerStatus = 'submitted';
						setTimeout(() => (composerStatus = 'ready'), 800);
						composerValue = '';
					}}
				/>
			</div>
		</section>
	</div>

	<footer class="page-footer">
		<span class="swatch swatch-bg"></span>bg
		<span class="swatch swatch-raised"></span>raised
		<span class="swatch swatch-sunken"></span>sunken
		<span class="swatch swatch-terracotta"></span>terracotta
		<span class="swatch swatch-lime"></span>lime
		<span class="swatch swatch-ink"></span>ink
		<Button variant="default" class="ml-auto"><Send class="size-4" />Demo send</Button>
	</footer>
</main>

<style>
	.page {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.25rem;
		max-width: 1200px;
		margin: 0 auto;
		width: 100%;
	}

	.page-header {
		border-radius: var(--radius-lg);
		padding: 1.25rem 1.5rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.brand-dot {
		width: 12px;
		height: 12px;
		border-radius: 999px;
		background: var(--terracotta);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--terracotta) 18%, transparent);
	}
	.brand h1 {
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--ink-solid);
		margin: 0;
		letter-spacing: -0.01em;
	}
	.subtitle {
		color: var(--ink-70);
		font-size: 0.85rem;
		margin: 0.35rem 0 0;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(280px, 360px) 1fr;
		gap: 1rem;
		flex: 1;
		min-height: 0;
	}
	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.conversation-panel {
			display: none;
		}
	}

	.panel {
		border-radius: var(--radius-lg);
		padding: 1rem;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.list-panel {
		gap: 0.5rem;
		overflow-y: auto;
	}
	:global(.chat-row) {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		transition: background 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
	}
	:global(.chat-row:hover) {
		background: var(--surface-raised);
		border-color: var(--hairline-soft);
	}
	:global(.chat-row:focus-visible),
	:global(.chat-row:active) {
		background: var(--surface-sunken);
		border-color: var(--hairline);
		box-shadow: var(--shadow-pressed);
		outline: none;
	}
	:global(.chat-name) {
		font-weight: 600;
		color: var(--ink-90);
		font-size: 0.92rem;
	}
	:global(.chat-preview) {
		color: var(--ink-70);
		font-size: 0.82rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 180px;
	}
	:global(.chat-actions) {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.3rem;
	}
	:global(.chat-time) {
		font-size: 0.7rem;
		color: var(--ink-50);
	}
	:global(.draft-badge) {
		font-size: 0.68rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.conversation-panel {
		gap: 0.5rem;
	}
	.conv-header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.5rem 0.75rem;
		border-bottom: 1px solid var(--hairline-soft);
	}
	.conv-name {
		font-weight: 600;
		color: var(--ink-90);
		font-size: 0.9rem;
	}
	.conv-status {
		font-size: 0.72rem;
		color: var(--ink-50);
	}
	:global(.conv-body) {
		flex: 1;
		min-height: 0;
	}
	:global(.draft-bubble) {
		background: color-mix(in srgb, var(--lime) 12%, var(--surface-raised));
		border: 1px solid color-mix(in srgb, var(--lime) 35%, var(--hairline));
		border-radius: var(--radius-md);
		padding: 0.6rem 0.8rem;
	}
	.draft-label {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--ink-50);
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.25rem;
	}
	.drafting-text {
		color: var(--ink-70);
		font-size: 0.85rem;
	}
	.composer {
		border-radius: var(--radius-md);
		padding: 0.5rem;
		margin-top: 0.5rem;
	}

	.page-footer {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.72rem;
		color: var(--ink-50);
	}
	.swatch {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 4px;
		border: 1px solid var(--hairline);
		margin-right: 0.15rem;
	}
	.swatch-bg { background: var(--bg); }
	.swatch-raised { background: var(--surface-raised); box-shadow: var(--shadow-raised); }
	.swatch-sunken { background: var(--surface-sunken); }
	.swatch-terracotta { background: var(--terracotta); }
	.swatch-lime { background: var(--lime); }
	.swatch-ink { background: var(--ink-solid); }
</style>