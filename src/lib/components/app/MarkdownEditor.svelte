<script lang="ts">
	/**
	 * MarkdownEditor — Milkdown WYSIWYG markdown editor, Svelte 5 runes wrapper.
	 *
	 * This is the editable half of the Voice tab. It owns a Milkdown editor that
	 * renders GFM markdown (commonmark + gfm presets) and emits `markdown` on
	 * every internal edit. The read-only view lives in the Voice tab UI (P3.4)
	 * and shares the `.mk-doc` typography system from `markdown-editor.css`.
	 *
	 * Why Milkdown and not a textarea: the owner's voice document (`voice/global.md`)
	 * contains GFM tables, and a plain textarea round-trips them only by luck.
	 * Milkdown parses into a ProseMirror schema and serializes back, so tables,
	 * strikethrough, and autolinks survive an edit.
	 *
	 * CODE-SPLIT: ProseMirror is the largest thing in the bundle and is used on
	 * one tab of one route. The Milkdown packages are imported dynamically inside
	 * the create-once `$effect`, so they never enter the main bundle. The editor
	 * mounts only in the browser (guarded on `browser`), never during prerender.
	 * Type-only imports below are erased at build time and cost nothing.
	 *
	 * CONTROLLED-COMPONENT SYNC — the Svelte 5 port of SlayZone's
	 * `use-editor-setup.ts:314-327`. Two deliberately separate `$effect`s:
	 *
	 *   1. create-once — depends only on the host element, reads the initial
	 *      `value` through `untrack()` so a `value` change never rebuilds the
	 *      editor. Rebuilding would lose undo history and the cursor on every
	 *      external refresh.
	 *
	 *   2. external-sync — tracks `value` + `editorReady`; everything else inside
	 *      `untrack()`. On genuine divergence: set `suppress = true`, call
	 *      `editorRef.action(replaceAllFn(next, true))`, reset in `finally`.
	 *      `suppress` gates the `markdownUpdated` listener — that is the
	 *      echo-loop break. `internal` and `editorRef` stay non-reactive on
	 *      purpose. Getting this wrong gives either an infinite loop (no
	 *      `suppress`) or a dead editor (rebuild-on-value).
	 *
	 * `replaceAll` resets undo history and cursor — exactly why P3.2's mirror
	 * guard matters: with it, this path should never fire mid-edit.
	 */
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import type { Editor } from '@milkdown/core';
	import type { Ctx } from '@milkdown/ctx';
	import './markdown-editor.css';

	let {
		value,
		placeholder = '',
		/** Fired on every internal edit (typing, formatting, table edit). Never fires for an external `replaceAll` sync (suppressed). */
		onchange = undefined,
		/** Fired once when the editor has mounted and is interactive. */
		onready = undefined,
		class: className = undefined,
		readability = undefined,
		width = undefined,
		variant = 'page',
		fontFamily = undefined,
		spellcheck = true
	}: {
		value: string;
		placeholder?: string;
		onchange?: (markdown: string) => void;
		onready?: () => void;
		class?: string;
		readability?: 'compact' | undefined;
		width?: 'narrow' | 'wide' | undefined;
		variant?: 'page' | 'inline';
		fontFamily?: 'mono' | undefined;
		spellcheck?: boolean;
	} = $props();

	let hostEl = $state<HTMLDivElement | null>(null);
	let editorReady = $state(false);

	// Non-reactive editor state — deliberately plain vars, NOT $state.
	// `internal` is the last markdown the editor itself produced (the echo-loop
	// guard). `editorRef` is the live Milkdown editor handle. `replaceAllFn` is
	// the dynamically-imported `replaceAll` action, stashed here so the
	// external-sync effect (which does NOT re-import) can call it. All three
	// stay outside the reactivity graph so tracking them never re-runs an
	// effect.
	let editorRef: Editor | null = null;
	let internal = '';
	let replaceAllFn: ((markdown: string, flush?: boolean) => (ctx: Ctx) => void) | null = null;
	let getMarkdownFn: ((range?: { from: number; to: number }) => (ctx: Ctx) => string) | null = null;

	// Latest callbacks, kept in plain refs so the create-once effect closes
	// over stable references and never rebuilds on a callback identity change.
	// Plain objects (not `$state`) — they are never tracked and must never
	// re-run an effect. The `$effect`s below update `.current` on every run; the
	// create-once effect reads `.current` at call-time, never capturing `onchange`
	// / `onready` directly (which would trip svelte's state_referenced_locally).
	let onChangeRef: { current: (markdown: string) => void } = { current: () => {} };
	let onReadyRef: { current: () => void } = { current: () => {} };
	$effect(() => {
		onChangeRef.current = onchange ?? (() => {});
	});
	$effect(() => {
		onReadyRef.current = onready ?? (() => {});
	});

	// `suppress` is the echo-loop break: when an external `replaceAll` sync is
	// in flight, the `markdownUpdated` listener must ignore its own echo.
	// Declared here (before the create-once effect that registers the
	// listener) so the closure captures the live binding, not a stale copy.
	// It is intentionally a plain `let`, NOT `$state` — it is never tracked and
	// must never re-run an effect.
	let suppress = false;

	// Create-once: mounts the Milkdown editor into `hostEl`. Depends only on
	// the host element; reads the initial `value` through `untrack()` so a
	// `value` change never rebuilds the editor.
	$effect(() => {
		const host = hostEl;
		if (!host || !browser) return;

		let destroyed = false;
		let editor: Editor | null = null;

		// Read the initial value without tracking it — a later `value` change
		// must NOT re-run this effect (it would rebuild the editor and lose
		// undo/cursor). The external-sync effect handles later changes.
		const initial = untrack(() => value);

		void (async () => {
			// Dynamic import — ProseMirror is the largest thing in the bundle and
			// is used on one tab of one route. Keeping these out of the main chunk.
			const [{ Editor: EditorCtor, rootCtx, defaultValueCtx }, { commonmark }, { gfm }, { history }, { listener, listenerCtx }, { replaceAll, getMarkdown }] =
				await Promise.all([
					import('@milkdown/core'),
					import('@milkdown/preset-commonmark'),
					import('@milkdown/preset-gfm'),
					import('@milkdown/plugin-history'),
					import('@milkdown/plugin-listener'),
					import('@milkdown/utils')
				]);

			if (destroyed) return;

			// Stash the action for the external-sync effect (which does not
			// re-import — it reads this non-reactive var instead).
			replaceAllFn = replaceAll;
			getMarkdownFn = getMarkdown;

			editor = EditorCtor.make()
				.config((ctx: Ctx) => {
					ctx.set(rootCtx, host);
					ctx.set(defaultValueCtx, initial);
					internal = initial;
				})
				.config((ctx: Ctx) => {
					ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
						// `suppress` is the echo-loop break: when an external `replaceAll`
						// sync is in flight, ignore the listener's own echo. Without this
						// the editor would re-emit its own externally-pushed content and
						// loop forever.
						if (suppress) return;
						if (markdown === prevMarkdown) return;
						internal = markdown;
						onChangeRef.current(markdown);
					});
				})
				.use(commonmark)
				.use(gfm)
				.use(history)
				.use(listener);

			try {
				await editor.create();
			} catch (err) {
				console.error('[MarkdownEditor] failed to create editor:', err);
				return;
			}

			if (destroyed) {
				void editor.destroy().catch(() => {});
				return;
			}

			// Emit the post-parse serialization once on mount. Without this, a
			// Save-with-zero-edits would write the raw file bytes and never prove
			// the Milkdown round trip (markdownUpdated only fires on edits).
			try {
				const serialized = editor.action(getMarkdown());
				internal = serialized;
				if (serialized !== initial) {
					onChangeRef.current(serialized);
				}
			} catch {
				// Serializer not ready — leave internal as initial; first keystroke
				// still goes through markdownUpdated.
			}

			editorRef = editor;
			editorReady = true;
			onReadyRef.current();
		})();

		return () => {
			destroyed = true;
			editorRef = null;
			editorReady = false;
			replaceAllFn = null;
			getMarkdownFn = null;
			if (editor) void editor.destroy().catch(() => {});
		};
	});

	/**
	 * Live serialization of what the editor is showing right now. Save must call
	 * this rather than trusting the last `onchange` alone — ProseMirror can accept
	 * DOM input that has not yet (or will not) emit `markdownUpdated`, and a Save
	 * that writes a stale draft would silently drop the owner's visible edit.
	 */
	export function currentMarkdown(): string {
		const editor = editorRef;
		const get = getMarkdownFn;
		if (editor && get) {
			try {
				const next = editor.action(get());
				internal = next;
				return next;
			} catch {
				return internal;
			}
		}
		return internal;
	}

	// External-sync: when `value` changes from the outside and diverges from
	// what the editor currently holds, push it in via `replaceAll`. Tracks
	// `value` + `editorReady`; everything else inside `untrack()`.
	$effect(() => {
		// Track these two so the effect re-runs when either changes.
		const next = value;
		const ready = editorReady;
		if (!ready) return;

		// Everything else is non-reactive — read through untrack so a change to
		// `editorRef`, `internal`, or `replaceAllFn` never re-runs this effect.
		untrack(() => {
			const editor = editorRef;
			const replace = replaceAllFn;
			if (!editor || !replace) return;
			// Genuine divergence only: if the editor already holds `next` (the
			// owner is typing and `value` is echoing back, or it's the initial
			// value), do nothing. Skipping this check would `replaceAll` on every
			// keystroke and destroy the cursor.
			if (internal === next) return;

			suppress = true;
			try {
				internal = next;
				editor.action(replace(next, true));
			} catch {
				// Editor may not be ready yet — safe to ignore, the create-once
				// effect will have set `internal` to the real initial value.
			} finally {
				suppress = false;
			}
		});
	});
</script>

<div
	class={['mk-doc', className]}
	data-variant={variant}
	data-readability={readability}
	data-width={width}
	data-font={fontFamily === 'mono' ? 'mono' : undefined}
	spellcheck={spellcheck}
>
	<div bind:this={hostEl} class="mk-doc-scroll"></div>
</div>