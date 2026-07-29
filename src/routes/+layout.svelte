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
	}
</style>