<script lang="ts">
	import { onMount } from 'svelte';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import { Avatar, AvatarFallback } from '$lib/components/ui/avatar/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { MessagesSquare } from '@lucide/svelte';
	import AgentPanel from '$lib/components/app/AgentPanel.svelte';
	import ChatList from '$lib/components/app/ChatList.svelte';
	import Composer from '$lib/components/app/Composer.svelte';
	import ConversationPane from '$lib/components/app/ConversationPane.svelte';
	import DeepenHistoryButton from '$lib/components/app/DeepenHistoryButton.svelte';
	import FirstRunScreen from '$lib/components/app/FirstRunScreen.svelte';
	import PairingScreen from '$lib/components/app/PairingScreen.svelte';
	import { AppState } from '$lib/client/state.svelte.js';
	import { displayName, initialsFor, isFirstRun, sessionBanner } from '$lib/client/view.js';

	const app = new AppState();
	let composerValue = $state('');

	// PL-A2 — agent panel collapse state. Persisted in localStorage (not the
	// settings DB) so the first paint is correct with no async fetch flash —
	// same rationale as the theme toggle. We do NOT use paneforge's autoSaveId
	// for the group: the existing two-pane group has none, and adding one would
	// silently override the established split for current users on first load.
	// The collapsed boolean is the only state that needs first-paint
	// persistence; pane sizes stay at their deliberate 25/50/25 defaults.
	const AGENT_COLLAPSE_KEY = 'whatsagent.agent-panel.collapsed';
	let agentCollapsed = $state(
		typeof localStorage !== 'undefined' &&
			localStorage.getItem(AGENT_COLLAPSE_KEY) === '1'
	);
	// The Pane component exports imperative collapse/expand via bind:this.
	// paneforge's `ref` prop is the HTMLElement, not the API, so we bind the
	// component instance instead.
	let agentPane: Resizable.Pane | null = $state(null);

	function persistCollapsed(v: boolean) {
		agentCollapsed = v;
		try {
			localStorage.setItem(AGENT_COLLAPSE_KEY, v ? '1' : '0');
		} catch {
			// localStorage may be unavailable (private mode); collapse still
			// works for the session, just not persisted.
		}
	}

	function toggleAgent() {
		if (agentCollapsed) {
			agentPane?.expand();
		} else {
			agentPane?.collapse();
		}
	}

	// Apply the persisted collapsed state once the pane instance is bound.
	// paneforge does not declaratively collapse from a prop — the initial size
	// comes from defaultSize and collapse is imperative. This $effect runs once
	// after mount when agentPane is first available.
	let collapseApplied = $state(false);
	$effect(() => {
		if (agentPane && !collapseApplied) {
			collapseApplied = true;
			if (agentCollapsed) agentPane.collapse();
		}
	});

	// Never in `load()` — this route prerenders, and a load-time fetch would run
	// at build time with no backend listening.
	onMount(() => {
		app.start();
		return () => app.stop();
	});

	const banner = $derived(sessionBanner(app.session));
	// OSS-P3.4 — an empty, unlinked app gets the welcome flow instead of a bare
	// QR. A previously-paired app that was unlinked keeps the plain pairing
	// screen: it has already been through setup.
	const firstRun = $derived(
		isFirstRun({ session: app.session, chatCount: app.chats.length, hydrated: app.hydrated })
	);
	const chatTitle = $derived(app.selectedChat ? displayName(app.selectedChat) : '');
	// Deepen requires an active WhatsApp socket — the server refuses while
	// disconnected. Syncing is allowed: the phone can still serve history.
	const deepenDisabled = $derived(
		app.session.status === 'disconnected' || app.session.status === 'logged_out'
	);

	async function openChat(jid: string) {
		composerValue = '';
		await app.openChat(jid);
	}
</script>

<div class="shell">
	{#if firstRun}
		<!-- Nothing has ever synced and WhatsApp is not linked: risk disclosure,
		     drafting setup, then the QR. -->
		<FirstRunScreen session={app.session} onregenerate={() => app.regeneratePairing()} />
	{:else if banner.blocking}
		<!-- Pairing and logged-out are the only states that gate the shell. -->
		<PairingScreen session={app.session} onregenerate={() => app.regeneratePairing()} />
	{:else}
		<!-- Syncing never gates: chats render as they land (D5). -->
		<!-- Three-pane budget 25/50/25 (deliberate, not 30/70 + bolt-on): two
		     recessed rails flank one raised conversation so the conversation
		     stays the figure and both side panels are ground. The conversation
		     pane gets a minSize (it had none) — paneforge would otherwise squeeze
		     it toward zero to make room for the agent pane. The agent pane is
		     collapsible; its collapsed state persists in localStorage. -->
		<Resizable.PaneGroup direction="horizontal" class="panes" keyboardResizeBy={5}>
			<Resizable.Pane defaultSize={25} minSize={20} maxSize={45}>
				<section class="pane list-pane">
					<ChatList
						chats={app.chats}
						selectedJid={app.selectedJid}
						syncing={app.session.status === 'syncing'}
						sendsLive={app.sendsLive}
						sendingMode={app.sendingMode}
						session={app.session}
						socketConnected={app.connected}
						outbox={app.outbox}
						cancellationNotices={app.cancellationNotices}
						agentCollapsed={agentCollapsed}
						ontoggleagent={toggleAgent}
						oncancel={(id) => app.cancelOutbox(id)}
						ondismissnotice={(id) => app.dismissCancellationNotice(id)}
						onselect={openChat}
					/>
				</section>
			</Resizable.Pane>

			<Resizable.Handle />

			<Resizable.Pane defaultSize={50} minSize={30}>
				<section class="pane conv-pane">
					{#if app.selectedChat}
						<header class="conv-head">
							<Avatar class="conv-avatar">
								<AvatarFallback>{initialsFor(chatTitle)}</AvatarFallback>
							</Avatar>
							<div class="conv-id">
								<span class="conv-name">{chatTitle}</span>
								<span class="conv-sub">
									{app.selectedChat.kind === 'group' ? 'Group · agent excluded' : '1:1'}
								</span>
							</div>
							<div class="conv-actions">
								<DeepenHistoryButton
									status={app.deepenStatus}
									disabled={deepenDisabled}
									ondeepen={() => app.deepenHistory()}
								/>
							</div>
						</header>

						<ConversationPane
							chatJid={app.selectedChat.jid}
							chatKind={app.selectedChat.kind}
							messages={app.messages}
							loading={app.loadingMessages}
							hasMore={app.hasMoreMessages}
							unreadBoundary={app.unreadBoundary}
							jumpTarget={app.jumpTarget}
							onloadolder={() => app.loadOlder()}
							onloadmedia={(id) => app.loadMedia(id)}
							onreply={(message) => app.selectReply(message)}
							onreact={(messageId, emoji) => app.react(messageId, emoji)}
							onjumpquote={(targetId) => app.jumpToQuotedMessage(targetId)}
						/>

						<div class="conv-foot">
							<Composer
								bind:value={composerValue}
								replyTo={app.replyTarget}
								ondismissreply={() => app.dismissReply()}
								onsend={(text) => app.send(text)}
								placeholder={`Message ${chatTitle}`}
								draft={app.draft}
								stalePrompt={app.stalePrompt}
								textConflict={app.textConflict}
								proposals={app.selectedProposals}
								proposalChatName={chatTitle}
								proposalTargetText={(id) => {
									const m = app.messages.find((msg) => msg.id === id);
									if (!m) return null;
									const t = m.text?.trim();
									return t || m.type;
								}}
								proposalStalePrompt={app.proposalStalePrompt}
								decidingProposalId={app.decidingProposalId}
								agentEligible={app.selectedChat.kind === '1:1'}
								refining={app.refining}
								refineError={app.refineError}
								onapprove={(text) => app.approveDraft(text)}
								onconfirmstale={(text) => app.confirmStaleDraft(text)}
								onskip={() => app.skipDraft()}
								ondismissstale={() => (app.stalePrompt = null)}
								onreviewchange={() => app.acknowledgeDraftChange()}
								ondismisschange={() => app.dismissTextConflict()}
								onconfirmproposal={(id) =>
									app.proposalStalePrompt?.proposalId === id
										? app.confirmStaleProposal(id)
										: app.confirmProposal(id)}
								onrejectproposal={(id) => app.rejectProposal(id)}
								onrefine={(intent, text) => app.refineDraft(intent, text)}
								generating={app.generating}
								generateError={app.generateError}
								ongenerate={() => app.generateDraft()}
							/>
						</div>
					{:else}
						<Empty.Root class="conv-empty">
							<Empty.Header>
								<Empty.Media variant="icon"><MessagesSquare class="size-5" /></Empty.Media>
								<Empty.Title>Pick a conversation</Empty.Title>
								<Empty.Description>
									{app.session.status === 'syncing'
										? 'Still catching up — chats appear as history arrives.'
										: 'Your chats are on the left.'}
								</Empty.Description>
							</Empty.Header>
						</Empty.Root>
				{/if}
			</section>
		</Resizable.Pane>

		<Resizable.Handle />

		<Resizable.Pane
			bind:this={agentPane}
			defaultSize={25}
			minSize={15}
			maxSize={45}
			collapsible
			collapsedSize={0}
			order={3}
			onCollapse={() => persistCollapsed(true)}
			onExpand={() => persistCollapsed(false)}
		>
			<AgentPanel {app} />
		</Resizable.Pane>
	</Resizable.PaneGroup>
	{/if}

	{#if app.error}
		<div class="error-bar" role="alert">
			<span>{app.error}</span>
			<Button variant="ghost" size="sm" onclick={() => (app.error = null)}>Dismiss</Button>
		</div>
	{/if}
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
		/* dvh keeps the composer reachable when mobile browser chrome collapses. */
		height: 100dvh;
		min-height: 0;
		/* No padding or gap: the panes tile the window edge to edge. There used to
		   be a 0.6rem surround, which left a strip of the `--bg` canvas showing
		   around two rounded cards — a background nothing sits on. The panes carry
		   their own surface, so the canvas has no job here. */
		padding: 0;
		gap: 0;
	}

	:global(.panes) {
		flex: 1;
		min-height: 0;
	}
	.pane {
		height: 100%;
		min-height: 0;
		padding: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	/* Neither pane is a card any more. The nesting used to run window > canvas >
	   rounded card > list, and every layer added an edge. Now the list simply IS
	   the background and the conversation is the one raised surface, so the two
	   are separated by tone rather than by a border, a radius and a divider line
	   stacked on top of each other. */
	/* The canvas is the base. The list and agent panes are RECESSED into it
	   (sunken surface plus the inset shadow) — two recessed rails flanking one
	   raised conversation, so the conversation stays the figure and both side
	   panels are ground. The conversation sits on the raised surface and fills
	   to the window edge — the depth cue is the tonal step from the sunken
	   rails, not a floating card. The agent pane carries its own matching
	   recessed treatment in AgentPanel.svelte. */
	.list-pane {
		background: var(--surface-sunken);
		box-shadow: var(--shadow-pressed);
	}
	.conv-pane {
		background: var(--surface-raised);
	}
	/* The resizable handle ships a 1px `bg-border` rule. Kept as a drag target,
	   made invisible: the tonal step between the two panes already reads as the
	   boundary, and a line on top of it was one edge too many. */
	:global(.panes .cn-resizable-handle) {
		background: transparent;
	}
	.conv-head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.1rem 0.25rem 0.55rem;
		border-bottom: 1px solid var(--hairline-soft);
	}
	:global(.conv-avatar) {
		flex: none;
	}
	.conv-id {
		display: flex;
		flex-direction: column;
	}
	.conv-name {
		font-weight: 600;
		font-size: 0.92rem;
		color: var(--ink-90);
	}
	.conv-sub {
		font-size: 0.7rem;
		color: var(--ink-50);
	}
	.conv-actions {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
	}
	/* Fixed flex child below the scroll viewport: the conversation absorbs all
	   spare height, so the composer stays on screen at any viewport height. */
	.conv-foot {
		flex: none;
		display: flex;
		flex-direction: column;
	}
	:global(.conv-empty) {
		flex: 1;
		justify-content: center;
	}

	.error-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--destructive);
		background: color-mix(in srgb, var(--destructive) 8%, var(--surface-raised));
		color: var(--destructive);
		font-size: 0.78rem;
		padding: 0.35rem 0.5rem;
	}
</style>
