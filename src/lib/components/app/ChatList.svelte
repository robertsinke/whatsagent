<script lang="ts">
	import { flip } from 'svelte/animate';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Inbox, Search } from '@lucide/svelte';
	import type { CancellationNotice, Chat, OutboxRow, SessionView } from '$lib/client/types.js';
	import { displayName, filterChats, jidDigits, type ChatTab } from '$lib/client/view.js';
	import CancellationNoticeBanner from './CancellationNoticeBanner.svelte';
	import ChatRow from './ChatRow.svelte';
	import FooterAgentToggle from './FooterAgentToggle.svelte';
	import FooterSettings from './FooterSettings.svelte';
	import FooterThemeToggle from './FooterThemeToggle.svelte';
	import NeedsReplyTabs from './NeedsReplyTabs.svelte';
	import OutboxTray from './OutboxTray.svelte';
	import SendModeIndicator from './SendModeIndicator.svelte';
	import SessionStatus from './SessionStatus.svelte';

	let {
		chats,
		selectedJid = null,
		syncing = false,
		sendsLive = false,
		sendingMode = false,
		session,
		socketConnected = true,
		outbox = [],
		cancellationNotices = [],
		agentCollapsed = false,
		ontoggleagent,
		oncancel,
		ondismissnotice,
		onselect
	}: {
		chats: Chat[];
		selectedJid?: string | null;
		syncing?: boolean;
		sendsLive?: boolean;
		sendingMode?: boolean;
		session: SessionView;
		socketConnected?: boolean;
		outbox?: OutboxRow[];
		cancellationNotices?: CancellationNotice[];
		agentCollapsed?: boolean;
		ontoggleagent?: () => void;
		oncancel?: (id: number) => void;
		ondismissnotice?: (id: number) => void;
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

	<CancellationNoticeBanner
		notices={cancellationNotices}
		{chats}
		ondismiss={ondismissnotice}
		{onselect}
	/>

	<div class="search">
		<Search class="size-3.5 text-ink-50 search-icon" />
		<Input bind:value={query} placeholder="Search chats" class="search-input" />
	</div>

	<div class="rows scrollbar-contextual" use:scrollActivity>
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

	<footer class="list-footer">
		<SendModeIndicator {sendsLive} pending={sendingMode} />
		<span class="footer-sep" aria-hidden="true"></span>
		<SessionStatus {session} {socketConnected} />
		<span class="footer-sep footer-sep-strong" aria-hidden="true"></span>
		<OutboxTray {outbox} {chats} {oncancel} />
		<span class="footer-sep" aria-hidden="true"></span>
		<FooterSettings />
		<span class="footer-sep" aria-hidden="true"></span>
		<FooterThemeToggle />
		<span class="footer-sep" aria-hidden="true"></span>
		<FooterAgentToggle collapsed={agentCollapsed} onToggle={() => ontoggleagent?.()} />
	</footer>
</div>

<style>
	.list {
		position: relative;
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		height: 100%;
		min-height: 0;
	}
	/* The search field IS the recess, not a card floating in it. It fills the
	   full list width so its left/right edges align with the tab row above and
	   the chat rows below — one aligned stack, no overhang. The icon sits inside
	   the border, so the field's visible box (not just its wrapper) lines up with
	   the tab-list box. Cut into the sunken surface: a hairline, the sunken fill
	   and the inset shadow. Focus deepens the well with a cobalt inner glow
	   instead of an outer ring. */
	.search {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		height: 2rem;
		padding: 0 0.5rem;
		border: 1px solid var(--hairline);
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		box-shadow: var(--shadow-pressed);
		transition: box-shadow 140ms ease, border-color 140ms ease;
	}
	.search:focus-within {
		border-color: color-mix(in srgb, var(--ring) 45%, var(--hairline));
		box-shadow: var(--shadow-focus);
	}
	.search :global(svg.search-icon) {
		flex: none;
		pointer-events: none;
	}
	:global(.search-input) {
		flex: 1;
		min-width: 0;
		height: 100%;
		border: 0 !important;
		background: transparent !important;
		box-shadow: none !important;
		padding: 0;
		font-size: 0.82rem;
		outline: none !important;
	}
	:global(.search-input:focus),
	:global(.search-input:focus-visible) {
		outline: none !important;
		box-shadow: none !important;
		border: 0 !important;
		--tw-ring-shadow: 0 0 #0000 !important;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		padding-right: 0.15rem;
		/* Room for the absolutely positioned status footer so the last row stays
		   reachable. */
		padding-bottom: 2.75rem;
	}
	:global(.list-empty) {
		margin-top: 2rem;
	}
	.list-footer {
		position: absolute;
		inset-inline: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 0;
		/* Room for the Outbox count badge — it sits on the trailing control and
		   must not be clipped by the pane's right edge. */
		padding: 0.35rem 0.45rem;
		border-top: 1px solid var(--hairline-soft);
		/* Matches the recess it sits in. It used to be `--surface-raised`, which
		   read as a floating strip once the list stopped being a card. */
		background: var(--surface-sunken);
		z-index: 1;
		min-width: 0;
	}
	.footer-sep {
		width: 1px;
		align-self: stretch;
		margin: 0.2rem 0.4rem;
		background: var(--hairline-soft);
	}
	/* A slightly heavier rule between the status group (sends, connection) and
	   the actions group (outbox, settings) so the four read as two pairs. */
	.footer-sep-strong {
		background: var(--hairline);
	}
	/* Below ~220px pane (the 20% min of a 1440 shell), the separators collapse to
	   thin margins so the five icon-only chips stay on one row. F10 dropped the
	   hover label reveal (chips never resize), so overflow for expanding labels
	   is no longer a concern — tooltip popovers carry the text instead. */
	@container (max-width: 220px) {
		.footer-sep {
			margin: 0.15rem 0.2rem;
		}
		.footer-sep-strong {
			margin-inline: 0.3rem;
		}
	}
</style>
