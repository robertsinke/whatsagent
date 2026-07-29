<script lang="ts">
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
</script>

<ModeWatcher />

<svelte:head>
	<title>WhatsAgent</title>
</svelte:head>

<div class="app-shell">
	{@render children?.()}
</div>

<style>
	.app-shell {
		position: relative;
		z-index: 1;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		/* Backstop for the settings overflow chain (PL-F9): a flex item whose
		   cross-axis min-width:auto was not suppressed used to push the
		   document to a horizontal scroll. The real fix is per-layer (the
		   Voice .mk-doc wrapping + .page `min-width:0`), but a single
		   long-unbreakable string in a future flex child that forgets that
		   treatment would escape again. `overflow-x: clip` catches it here
		   without creating a scroll container (clip, unlike hidden/auto,
		   does not establish a box with scrollbars and does not affect the
		   block axis), so vertical document scroll and the existing
		   min-height:100vh layout are untouched. Scoped to .app-shell, not
		   html/body, so a regression on another route still surfaces. */
		overflow-x: clip;
	}
</style>