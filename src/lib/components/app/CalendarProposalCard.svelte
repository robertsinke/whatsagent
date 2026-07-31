<script lang="ts">
	import { Calendar, Check, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { CalendarProposal } from '$lib/client/types.js';

	/**
	 * CAL-2 — the owner's half of the calendar permission channel.
	 *
	 * The agent asked to put an event on Google Calendar; nothing is written
	 * unless the button below is clicked. Hash re-confirm binds the payload on
	 * screen (summary + start + end + location).
	 */
	let {
		proposal,
		deciding = false,
		onconfirm,
		onreject
	}: {
		proposal: CalendarProposal;
		deciding?: boolean;
		onconfirm?: () => void | Promise<unknown>;
		onreject?: () => void | Promise<unknown>;
	} = $props();

	function formatWhen(iso: string): string {
		const d = new Date(iso);
		if (!Number.isFinite(d.getTime())) return iso;
		return d.toLocaleString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<div class="proposal calendar" data-testid="calendar-proposal-card">
	<div class="proposal-head">
		<Calendar class="size-3.5" />
		<span class="proposal-title">The agent wants to add this to your calendar</span>
	</div>

	<div class="event-body">
		<p class="event-summary">{proposal.summary}</p>
		<p class="event-when">
			{formatWhen(proposal.start)}
			<span class="event-sep">→</span>
			{formatWhen(proposal.end)}
		</p>
		{#if proposal.location}
			<p class="event-location">{proposal.location}</p>
		{/if}
	</div>

	<p class="proposal-note">Nothing is written to Google until you confirm.</p>
	<div class="proposal-actions">
		<Button size="sm" onclick={() => onconfirm?.()} disabled={deciding}>
			<Check class="size-3.5" />
			Add to calendar
		</Button>
		<Button size="sm" variant="outline" onclick={() => onreject?.()} disabled={deciding}>
			<X class="size-3.5" /> Discard
		</Button>
	</div>
</div>

<style>
	.proposal {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	.proposal-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--ink-70);
	}

	.proposal-title {
		letter-spacing: 0.01em;
	}

	.event-body {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.35rem 0.45rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--hairline);
	}

	.event-summary {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 600;
		line-height: 1.35;
		color: var(--ink-90);
	}

	.event-when,
	.event-location {
		margin: 0;
		font-size: 0.8rem;
		line-height: 1.4;
		color: var(--ink-70);
	}

	.event-sep {
		margin: 0 0.25rem;
		color: var(--ink-40);
	}

	.proposal-note {
		margin: 0;
		font-size: 0.75rem;
		color: var(--ink-60);
	}

	.proposal-actions {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
</style>
