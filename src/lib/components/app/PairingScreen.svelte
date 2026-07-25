<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { AlertTriangle, RefreshCw, Smartphone } from '@lucide/svelte';
	import QRCode from 'qrcode';
	import type { SessionView } from '$lib/client/types.js';
	import { sessionBanner } from '$lib/client/view.js';

	let {
		session,
		onregenerate
	}: { session: SessionView; onregenerate?: () => void } = $props();

	const banner = $derived(sessionBanner(session));

	let qrDataUrl = $state<string | null>(null);

	// Each QR rotation is pushed by the server (~20s); re-render on every payload.
	$effect(() => {
		const payload = session.qr;
		if (!payload) {
			qrDataUrl = null;
			return;
		}
		let cancelled = false;
		void QRCode.toDataURL(payload, {
			width: 260,
			margin: 1,
			color: { dark: '#202020', light: '#fbfbf8' }
		}).then((url) => {
			if (!cancelled) qrDataUrl = url;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<div class="pairing">
	<div class="card neumorphic-raised">
		<div class="head">
			{#if banner.tone === 'bad'}
				<AlertTriangle class="size-4 text-destructive" />
			{:else}
				<Smartphone class="size-4" />
			{/if}
			<h2>{banner.label}</h2>
		</div>
		<p class="detail">{banner.detail}</p>

		{#if session.status === 'qr_pending'}
			<div class="qr neumorphic-pressed">
				{#if qrDataUrl}
					<img src={qrDataUrl} alt="WhatsApp pairing QR code" />
				{:else}
					<Spinner />
				{/if}
			</div>
			<p class="rotate">This code refreshes automatically every few seconds.</p>
		{:else if session.status === 'pairing'}
			<div class="waiting"><Spinner /> Finishing the handshake…</div>
		{/if}

		{#if banner.canRepair}
			<Button onclick={() => onregenerate?.()}>
				<RefreshCw class="size-4" />
				{session.status === 'logged_out' ? 'Start re-pairing' : 'Generate a new code'}
			</Button>
		{/if}
	</div>
</div>

<style>
	.pairing {
		flex: 1;
		display: grid;
		place-items: center;
		padding: 2rem 1rem;
	}
	.card {
		border-radius: var(--radius-lg);
		padding: 1.5rem;
		max-width: 380px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		text-align: center;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--ink-90);
	}
	.head h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.detail {
		margin: 0;
		font-size: 0.85rem;
		color: var(--ink-70);
		line-height: 1.45;
	}
	.qr {
		border-radius: var(--radius-md);
		padding: 0.75rem;
		display: grid;
		place-items: center;
		min-width: 280px;
		min-height: 280px;
	}
	.qr img {
		display: block;
		border-radius: var(--radius-sm);
	}
	.rotate {
		margin: 0;
		font-size: 0.72rem;
		color: var(--ink-50);
	}
	.waiting {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ink-70);
		font-size: 0.85rem;
	}
</style>
