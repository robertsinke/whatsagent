<script lang="ts">
	import { Monitor, Moon, Sun } from '@lucide/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { resetMode, setMode, userPrefersMode } from 'mode-watcher';

	/**
	 * Theme cycle control in the chat-list footer. Fifth footer chip — same
	 * shape as FooterSettings: icon-only at rest, label on hover/focus. One
	 * click advances light → dark → system → light. The icon always shows the
	 * CURRENT preference (not the next), and the tooltip names both the current
	 * state and what the click will do.
	 *
	 * Preference stays in localStorage via mode-watcher (FOUC: inline script
	 * before first paint). Do not route this through the settings DB.
	 */
	type Mode = 'light' | 'dark' | 'system';

	const LABELS: Record<Mode, string> = {
		light: 'Light',
		dark: 'Dark',
		system: 'System'
	};

	const NEXT: Record<Mode, Mode> = {
		light: 'dark',
		dark: 'system',
		system: 'light'
	};

	const mode = $derived((userPrefersMode.current ?? 'system') as Mode);
	const next = $derived(NEXT[mode]);

	function cycle() {
		const target = NEXT[(userPrefersMode.current ?? 'system') as Mode];
		if (target === 'system') resetMode();
		else setMode(target);
	}
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					type="button"
					class="chip"
					{...props}
					data-theme-mode={mode}
					aria-label="Theme: {LABELS[mode]}. Click for {LABELS[next]}."
					title="Theme: {LABELS[mode]}. Click for {LABELS[next]}."
					onclick={cycle}
				>
					{#if mode === 'light'}
						<Sun class="size-3" />
					{:else if mode === 'dark'}
						<Moon class="size-3" />
					{:else}
						<Monitor class="size-3" />
					{/if}
					<span class="chip-label">{LABELS[mode]}</span>
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			<p class="tip">
				Theme: {LABELS[mode]}. Click for {LABELS[next]}.
			</p>
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
		/* Transparent at rest so the control sits IN the recessed footer rather
		   than floating on it as a pill. Hover lifts it to the raised surface,
		   which doubles as the hover affordance now that the label reveal is the
		   only other feedback. */
		border: 1px solid transparent;
		background: transparent;
		box-shadow: none;
		color: var(--ink-70);
		cursor: default;
		white-space: nowrap;
		line-height: 1;
	}
	.chip:hover,
	.chip:focus-visible {
		background: var(--surface-raised);
		border-color: var(--hairline);
		box-shadow: var(--shadow-bevel);
		color: var(--ink-90);
	}
	.chip-label {
		white-space: nowrap;
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.chip:hover .chip-label,
	.chip:focus-visible .chip-label,
	.chip:focus-within .chip-label {
		position: static;
		width: auto;
		height: auto;
		margin: 0;
		overflow: visible;
		clip: auto;
	}
	.tip {
		margin: 0;
		max-width: 220px;
		font-size: 0.72rem;
	}
</style>
