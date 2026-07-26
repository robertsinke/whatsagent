<script lang="ts">
	import { tick } from 'svelte';
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { animate, spring } from 'motion';
	import { AlertTriangle, Check, Pencil, RotateCw, X } from '@lucide/svelte';
	import type { Draft } from '$lib/client/types.js';
	import type { StalePrompt } from '$lib/client/state.svelte.js';
	import { canApprove, draftBadge, isVisibleDraftStatus } from '$lib/client/view.js';

	let {
		draft,
		stalePrompt = null,
		/** True for 1:1 chats with no draft — the empty-draft hint is only meaningful where the agent is allowed to act. */
		agentEligible = false,
		onapprove,
		onskip,
		onconfirmstale,
		ondismissstale
	}: {
		draft: Draft | null;
		stalePrompt?: StalePrompt | null;
		agentEligible?: boolean;
		onapprove?: (text?: string) => boolean | void | Promise<boolean | void>;
		onskip?: () => void;
		onconfirmstale?: (text?: string) => boolean | void | Promise<boolean | void>;
		ondismissstale?: () => void;
	} = $props();

	const badge = $derived(draft ? draftBadge(draft.status) : null);
	const visibleDraft = $derived(draft && isVisibleDraftStatus(draft.status) ? draft : null);
	let editing = $state(false);
	let editedText = $state('');
	let editingBasis = $state<string | null>(null);
	let editorEl: HTMLTextAreaElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();
	let approving = $state(false);

	$effect(() => {
		if (!panelEl || typeof window === 'undefined') return;
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduce) return;
		panelEl.style.opacity = '0';
		panelEl.style.transform = 'translateY(-8px) scale(0.985)';
		panelEl.style.filter = 'blur(7px)';
		animate(
			panelEl,
			{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
			{ type: spring, stiffness: 500, damping: 34, duration: 0.22 }
		);
	});

	$effect(() => {
		const basis = draft?.basis_msg_id ?? null;
		if (editing && editingBasis !== basis) {
			editing = false;
			editedText = '';
			editingBasis = null;
		}
	});

	async function startEditing() {
		if (!draft || !canApprove(draft.status)) return;
		editedText = draft.text;
		editingBasis = draft.basis_msg_id;
		editing = true;
		await tick();
		editorEl?.focus();
		editorEl?.setSelectionRange(editedText.length, editedText.length);
	}

	async function closeEditor() {
		if (approving) return;
		if (panelEl && typeof window !== 'undefined') {
			const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			if (!reduce) {
				await animate(
					panelEl,
					{ opacity: 0, y: -6, scale: 0.985, filter: 'blur(6px)' },
					{ duration: 0.13 }
				).finished;
			}
		}
		editing = false;
		editedText = '';
		editingBasis = null;
	}

	async function approveEdited() {
		const text = editedText.trim();
		if (!text || approving) return;
		approving = true;
		let shouldClose = false;
		try {
			const approved = await onapprove?.(text);
			shouldClose = approved !== false && !stalePrompt;
		} finally {
			approving = false;
		}
		if (shouldClose) await closeEditor();
	}

	async function confirmStale() {
		const text = editing ? editedText.trim() : undefined;
		approving = true;
		let shouldClose = false;
		try {
			const approved = await onconfirmstale?.(text || undefined);
			shouldClose = approved !== false;
		} finally {
			approving = false;
		}
		if (shouldClose) await closeEditor();
	}

	async function dismissStale() {
		ondismissstale?.();
		if (editing) await closeEditor();
	}
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && editing && void closeEditor()} />

{#if stalePrompt}
	<!--
	  The server returned 409: newer inbound arrived after the draft's basis
	  message. Approval must be re-confirmed against the refreshed conversation —
	  the client never decides this itself.
	-->
	<div class="draft stale">
		<div class="draft-head">
			<AlertTriangle class="size-3.5" />
			<span class="draft-title">New message arrived while you were reading</span>
		</div>
		<p class="draft-note">
			This draft answered an earlier message. Re-read the thread, then approve again if it still
			fits.
		</p>
		<div class="draft-actions">
			<Button size="sm" onclick={confirmStale} disabled={approving}>
				<Check class="size-3.5" />
				{editing ? 'Queue edited draft anyway' : 'Queue this draft anyway'}
			</Button>
			<Button size="sm" variant="outline" onclick={dismissStale} disabled={approving}>
				<X class="size-3.5" /> Cancel
			</Button>
		</div>
	</div>
{:else if visibleDraft}
	<div class="draft" class:editing>
		<div class="draft-head">
			{#if editing}
				<span class="draft-title">Editing draft</span>
			{:else}
				<Pencil class="size-3.5" />
				<span class="draft-title">{badge?.label ?? 'Draft'}</span>
			{/if}
			{#if visibleDraft.provider}
				<span class="draft-provider">{visibleDraft.provider}</span>
			{/if}
		</div>

		{#if !editing}
			{#if visibleDraft.status === 'drafting'}
				<Shimmer children="Drafting a reply…" class="draft-shimmer" />
			{:else}
				<p class="draft-text">{visibleDraft.text}</p>
			{/if}

			<div class="draft-actions">
				<Button
					size="sm"
					onclick={() => onapprove?.(visibleDraft.text)}
					disabled={!canApprove(visibleDraft.status)}
				>
					<Check class="size-3.5" /> Approve &amp; queue
				</Button>
				<Button
					size="sm"
					variant="outline"
					onclick={startEditing}
					disabled={!canApprove(visibleDraft.status)}
				>
					<Pencil class="size-3.5" /> Edit draft
				</Button>
				<Button size="sm" variant="ghost" onclick={() => onskip?.()}>
					<X class="size-3.5" /> Skip
				</Button>
				{#if visibleDraft.status === 'failed'}
					<span class="draft-note">
						<RotateCw class="size-3" /> Drafting failed — the agent waits for the next inbound
						to retry, or you can reply yourself any time.
					</span>
				{/if}
			</div>
		{/if}

		{#if editing}
			<div bind:this={panelEl} class="draft-editor" aria-label="Edit AI draft">
				<textarea
					bind:this={editorEl}
					id="draft-editor-text"
					aria-label="Edit draft text"
					bind:value={editedText}
					disabled={approving}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							void approveEdited();
						}
					}}
				></textarea>
				<div class="editor-foot">
					<span class="draft-note">Approval queues exactly the text above.</span>
					<div class="editor-actions">
						<Button size="sm" variant="outline" onclick={closeEditor} disabled={approving}>
							Cancel
						</Button>
						<Button size="sm" onclick={approveEdited} disabled={!editedText.trim() || approving}>
							<Check class="size-3.5" />
							{approving ? 'Approving…' : 'Approve edited text'}
						</Button>
					</div>
				</div>
			</div>
		{/if}
	</div>
{:else if agentEligible && !draft}
	<div class="draft muted">
		<div class="draft-head">
			<Pencil class="size-3.5" />
			<span class="draft-title">No draft</span>
		</div>
		<p class="draft-note">
			The agent will draft here once the latest inbound settles (about a minute after the last
			message). Type your own reply any time — nothing sends without you.
		</p>
	</div>
{/if}

<style>
	.draft {
		position: relative;
		z-index: 2;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--lime) 35%, var(--hairline));
		background: color-mix(in srgb, var(--lime) 10%, var(--surface-raised));
		padding: 0.55rem 0.7rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.draft.editing {
		border-color: color-mix(in srgb, var(--lime) 65%, var(--hairline));
		box-shadow: var(--shadow-bevel);
		gap: 0;
	}
	.draft.muted {
		border-color: var(--hairline-soft);
		background: var(--surface-raised);
	}
	.draft.stale {
		border-color: color-mix(in srgb, var(--terracotta) 45%, var(--hairline));
		background: color-mix(in srgb, var(--terracotta) 8%, var(--surface-raised));
	}
	.draft-head {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--ink-70);
	}
	.draft-title {
		font-size: 0.68rem;
		letter-spacing: 0.05em;
		font-weight: 600;
	}
	.draft-provider {
		margin-left: auto;
		font-size: 0.66rem;
		color: var(--ink-50);
	}
	.draft-text {
		margin: 0;
		font-size: 0.86rem;
		color: var(--ink-90);
		white-space: pre-wrap;
		line-height: 1.45;
	}
	.draft-note {
		margin: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.76rem;
		color: var(--ink-50);
	}
	.draft-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	.draft-editor {
		position: absolute;
		z-index: 20;
		top: calc(100% + 0.35rem);
		left: 0;
		right: 0;
		min-height: 7.4rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--lime) 55%, var(--hairline));
		background: var(--surface-raised);
		box-shadow: var(--shadow-raised);
		padding: 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		transform-origin: top center;
	}
	.draft-editor textarea {
		width: 100%;
		min-height: 4.2rem;
		resize: vertical;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline);
		background: var(--surface-sunken);
		box-shadow: var(--shadow-pressed);
		padding: 0.55rem 0.65rem;
		color: var(--ink-90);
		font: inherit;
		font-size: 0.88rem;
		line-height: 1.45;
		outline: none;
	}
	.draft-editor textarea:focus-visible {
		border-color: color-mix(in srgb, var(--lime) 70%, var(--hairline));
		box-shadow:
			var(--shadow-pressed),
			0 0 0 3px color-mix(in srgb, var(--lime) 25%, transparent);
	}
	.editor-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}
	.editor-foot > .draft-note {
		max-width: 31rem;
	}
	.editor-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex: none;
	}
	@media (max-width: 760px) {
		.editor-foot {
			align-items: stretch;
			flex-direction: column;
		}
		.editor-actions {
			justify-content: flex-end;
		}
	}
	:global(.draft-shimmer) {
		font-size: 0.86rem;
	}
</style>
