<script lang="ts">
	import { tick } from 'svelte';
	import { scrollActivity } from '$lib/actions/scroll-activity.svelte.js';
	import Shimmer from '$lib/components/ai-elements/shimmer.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { animate, spring } from 'motion';
	import { AlertTriangle, Check, Pencil, RotateCw, Sparkles, X } from '@lucide/svelte';
	import type { Draft, RefinementIntent } from '$lib/client/types.js';
	import type { StalePrompt } from '$lib/client/state.svelte.js';
	import { canApprove, canRefine, draftBadge, isVisibleDraftStatus } from '$lib/client/view.js';
	import { draftPanelBranch } from './draft-panel.js';
	import { refineControlsState } from './refine-controls.js';

	let {
		draft,
		stalePrompt = null,
		/** True for 1:1 chats — generate / empty-draft UI only where the agent may act. */
		agentEligible = false,
		/** True while a preview-only refinement request is in flight. */
		refining = false,
		/** Recoverable refinement error; preserved preview stays visible when set. */
		refineError = null,
		/** True while an owner-triggered "Generate draft" request is in flight. */
		generating = false,
		/** Recoverable generation error, shown inside the no-draft card. */
		generateError = null,
		onapprove,
		onskip,
		onconfirmstale,
		ondismissstale,
		onrefine,
		ongenerate
	}: {
		draft: Draft | null;
		stalePrompt?: StalePrompt | null;
		agentEligible?: boolean;
		refining?: boolean;
		refineError?: string | null;
		generating?: boolean;
		generateError?: string | null;
		onapprove?: (text?: string) => boolean | void | Promise<boolean | void>;
		onskip?: () => void;
		onconfirmstale?: (text?: string) => boolean | void | Promise<boolean | void>;
		ondismissstale?: () => void;
		onrefine?: (intent: RefinementIntent, text?: string) => Promise<Draft | null>;
		ongenerate?: () => void | Promise<unknown>;
	} = $props();

	const badge = $derived(draft ? draftBadge(draft.status) : null);
	const visibleDraft = $derived(draft && isVisibleDraftStatus(draft.status) ? draft : null);
	const branch = $derived(draftPanelBranch({ draft, stalePrompt, agentEligible }));
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
		// The editor grows upward out of the draft card, so it enters from below.
		panelEl.style.transform = 'translateY(8px) scale(0.985)';
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
					{ opacity: 0, y: 6, scale: 0.985, filter: 'blur(6px)' },
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

	/**
	 * Preview-only refinement. Applies the transform to the unsaved editor text
	 * when edit mode is open (so the owner sees the change where they are
	 * typing), otherwise to the saved draft preview. The editor stays open on
	 * success, failure, and 409 — refinement never closes it or approves. On
	 * success the textarea is replaced with the transformed text; on failure the
	 * prior text is preserved.
	 */
	async function refine(intent: RefinementIntent) {
		if (refining || !onrefine) return;
		const { previewText } = refineControlsState({
			draft,
			editing,
			editedText,
			refining,
			approving
		});
		if (!previewText) return;
		const updated = await onrefine(intent, previewText);
		if (updated && editing) {
			// Replace the textarea contents with the transformed text and keep
			// the editor open. The owner can keep editing or approve afterward.
			editedText = updated.text;
			await tick();
			editorEl?.focus();
			editorEl?.setSelectionRange(updated.text.length, updated.text.length);
		}
	}
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && editing && void closeEditor()} />

{#if branch === 'stale'}
	<!--
	  The server returned 409: newer inbound arrived after the draft's basis
	  message. Approval must be re-confirmed against the refreshed conversation —
	  the client never decides this itself. This is a safety gate, not decoration.
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
{:else if branch === 'visible' && visibleDraft}
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

			{#if canRefine(visibleDraft.status)}
				<!--
				  Refinement is preview-only and structurally separate from approval:
				  this row lives above the approval actions, uses a quieter visual
				  treatment, and never reaches the outbox, composer send, or memory.
				  Regenerate is the primary secondary action; shorter/longer and
				  formality live in a compact group so they do not compete with
				  Approve & queue for the owner's attention.
				-->
				<div class="refine-row" role="group" aria-label="Refine draft preview">
					<Button
						size="sm"
						variant="ghost"
						class="refine-btn"
						onclick={() => refine('regenerate')}
						disabled={refining}
						title="Generate a fresh reply from current context"
					>
						<RotateCw class="size-3.5" />
						{refining ? 'Refining…' : 'Regenerate'}
					</Button>
					<div class="refine-group" role="group" aria-label="Transform draft">
						<Button
							size="sm"
							variant="ghost"
							class="refine-btn"
							onclick={() => refine('shorter')}
							disabled={refining}
							title="Make the draft shorter"
						>Shorter</Button>
						<Button
							size="sm"
							variant="ghost"
							class="refine-btn"
							onclick={() => refine('longer')}
							disabled={refining}
							title="Make the draft longer"
						>Longer</Button>
						<Button
							size="sm"
							variant="ghost"
							class="refine-btn"
							onclick={() => refine('more_formal')}
							disabled={refining}
							title="Make the draft more formal"
						>More formal</Button>
						<Button
							size="sm"
							variant="ghost"
							class="refine-btn"
							onclick={() => refine('less_formal')}
							disabled={refining}
							title="Make the draft less formal"
						>Less formal</Button>
					</div>
				</div>
			{/if}

			{#if refineError}
				<p class="refine-error" role="alert">{refineError}</p>
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
					class="scrollbar-contextual"
					use:scrollActivity
					bind:value={editedText}
					disabled={approving}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							void approveEdited();
						}
					}}
				></textarea>
				{#if draft && canRefine(draft.status)}
					<!--
					  Inside the editor, refinement applies to the unsaved textarea text
					  and keeps the editor open with the transformed result. The control
					  row sits above the approval foot so cancel/approve stay reachable
					  and refinement remains visually subordinate to approval.
					-->
					<div class="refine-row editor-refine" role="group" aria-label="Refine draft preview">
						<Button
							size="sm"
							variant="ghost"
							class="refine-btn"
							onclick={() => refine('regenerate')}
							disabled={refining || approving}
							title="Generate a fresh reply from current context"
						>
							<RotateCw class="size-3.5" />
							{refining ? 'Refining…' : 'Regenerate'}
						</Button>
						<div class="refine-group" role="group" aria-label="Transform draft">
							<Button
								size="sm"
								variant="ghost"
								class="refine-btn"
								onclick={() => refine('shorter')}
								disabled={refining || approving}
								title="Make the draft shorter"
							>Shorter</Button>
							<Button
								size="sm"
								variant="ghost"
								class="refine-btn"
								onclick={() => refine('longer')}
								disabled={refining || approving}
								title="Make the draft longer"
							>Longer</Button>
							<Button
								size="sm"
								variant="ghost"
								class="refine-btn"
								onclick={() => refine('more_formal')}
								disabled={refining || approving}
								title="Make the draft more formal"
							>More formal</Button>
							<Button
								size="sm"
								variant="ghost"
								class="refine-btn"
								onclick={() => refine('less_formal')}
								disabled={refining || approving}
								title="Make the draft less formal"
							>Less formal</Button>
						</div>
					</div>
				{/if}
				{#if refineError}
					<p class="refine-error" role="alert">{refineError}</p>
				{/if}
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
{:else if branch === 'generate'}
	<div class="draft muted">
		<div class="draft-head">
			<Sparkles class="size-3.5" />
			<span class="draft-title">No draft yet</span>
		</div>
		<p class="draft-note">
			The agent will draft here once the latest inbound settles (about a minute after the last
			message). Type your own reply any time — nothing sends without you.
		</p>
		<!--
		  W4-U15: the automatic path above is a promise, not a gate. The owner can
		  ask for a draft right now — including in chats the classifier declined
		  (they spoke last, or the chat was skipped, muted, or went quiet), and
		  including chats whose prior draft row is already terminal (sent /
		  skipped / approved). Asking for a draft writes a draft row and nothing
		  else; it never sends.
		-->
		<div class="draft-actions">
			<Button size="sm" class="generate-hero" onclick={() => ongenerate?.()} disabled={generating}>
				<Sparkles class="size-3.5" />
				{generating ? 'Asking the agent…' : 'Generate draft'}
			</Button>
			<span class="draft-note">Writes a draft for you to review — it still never sends itself.</span>
		</div>
		{#if generateError}
			<p class="refine-error" role="alert">{generateError}</p>
		{/if}
	</div>
{/if}

<style>
	/*
	  Embedded in Composer: no own card chrome. The composer shell owns the
	  single border; this region is the upper extension with a soft divider.
	*/
	.draft {
		position: relative;
		z-index: 2;
		padding: 0.15rem 0.15rem 0.55rem;
		margin: 0 0 0.35rem;
		border-bottom: 1px solid var(--hairline-soft);
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.draft.editing {
		gap: 0;
		border-bottom-color: color-mix(in srgb, var(--lime) 45%, var(--hairline-soft));
	}
	.draft.stale {
		border-bottom-color: color-mix(in srgb, var(--cobalt) 40%, var(--hairline-soft));
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
		padding: 0.35rem 0.45rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--lime) 10%, var(--surface-sunken));
		border: 1px solid color-mix(in srgb, var(--lime) 28%, var(--hairline));
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
	/* Primary action — stays a labelled button, never collapses to an icon. */
	:global(.generate-hero) {
		background-image: linear-gradient(135deg, var(--cobalt-700), var(--cobalt-600));
	}
	:global(.generate-hero:disabled) {
		background-image: none;
	}
	/* Refinement is visually subordinate to approval: smaller, ghosted, and
	   separated by a hairline so it never competes with Approve & queue. It
	   updates the preview only and never reaches the outbox or memory. */
	.refine-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
		padding-top: 0.3rem;
		border-top: 1px solid var(--hairline-soft);
	}
	.refine-group {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		flex-wrap: wrap;
	}
	:global(.refine-btn) {
		font-size: 0.72rem;
		color: var(--ink-60);
		padding: 0.2rem 0.45rem;
		height: auto;
		min-height: 1.6rem;
	}
	:global(.refine-btn:hover:not(:disabled)) {
		color: var(--ink-90);
	}
	.refine-error {
		margin: 0;
		font-size: 0.74rem;
		color: var(--cobalt);
	}
	.editor-refine {
		border-top: none;
		padding-top: 0;
	}
	/* Opens upward, over the conversation: the draft region sits directly above
	   the input at the bottom of the pane, so a downward panel would render off
	   screen. Height is capped against the viewport and the textarea — not the
	   action row — absorbs the overflow, so cancel/approve stay reachable
	   without scrolling the shell. */
	.draft-editor {
		position: absolute;
		z-index: 20;
		bottom: calc(100% + 0.35rem);
		left: 0;
		right: 0;
		min-height: 7.4rem;
		max-height: min(22rem, 55dvh);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--lime) 55%, var(--hairline));
		background: var(--surface-raised);
		box-shadow: var(--shadow-raised);
		padding: 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		transform-origin: bottom center;
	}
	.draft-editor textarea {
		width: 100%;
		flex: 1;
		min-height: 4.2rem;
		overflow-y: auto;
		resize: none;
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
		flex: none;
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
	@media (max-height: 640px) {
		.draft-editor {
			min-height: 6rem;
			max-height: 62dvh;
		}
		.draft-editor textarea {
			min-height: 3rem;
		}
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
