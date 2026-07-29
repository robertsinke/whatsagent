<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import {
		AlertCircle,
		Download,
		FileText,
		Image as ImageIcon,
		Mic,
		RotateCw,
		Sticker,
		Video
	} from '@lucide/svelte';
	import { api } from '$lib/client/api.js';
	import type { Message } from '$lib/client/types.js';
	import { mediaAffordance, mediaKind, mediaPresentation } from '$lib/client/view.js';

	let {
		message,
		onload,
		onopen
	}: {
		message: Message;
		onload?: (messageId: string) => void;
		onopen?: (message: Message) => void;
	} = $props();

	const media = $derived(message.media!);
	const kind = $derived(mediaKind(message.type));
	const presentation = $derived(mediaPresentation(message.type));
	const state = $derived(mediaAffordance(message.type, media));
	const src = $derived(api.mediaUrl(message.id));
</script>

<!--
  D2: the four states are read straight off the server. `unavailable` is terminal
  and deliberately renders no retry button — retrying cannot bring it back.
-->
<div class="media" class:terminal={state.terminal} class:sticker-ready={kind === 'sticker' && state.canOpen}>
	{#if state.canOpen && kind === 'sticker'}
		<!-- Stickers are WebP (often animated); <img> keeps the animation playing. -->
		<button type="button" class="sticker" onclick={() => onopen?.(message)}>
			<img {src} alt="Sticker" />
		</button>
	{:else if state.canOpen && presentation === 'image'}
		<button type="button" class="thumb" onclick={() => onopen?.(message)}>
			<img {src} alt={media.filename ?? 'Photo'} />
		</button>
	{:else if state.canOpen && presentation === 'video'}
		<button type="button" class="thumb" onclick={() => onopen?.(message)}>
			<video {src} preload="metadata" muted></video>
			<span class="play"><Video class="size-4" /></span>
		</button>
	{:else if state.canOpen && presentation === 'audio'}
		<!-- Audio plays inline; images/video/stickers go to the lightbox; docs hand off to the OS. -->
		<audio controls {src} class="audio"></audio>
	{:else if state.canOpen}
		<a class="document" href={src} download={media.filename ?? undefined}>
			<FileText class="size-4" />
			<span class="doc-name">{state.label}</span>
			<Download class="size-3.5" />
		</a>
	{:else}
		<div class="placeholder">
			<span class="icon">
				{#if state.terminal || state.canRetry}
					<AlertCircle class="size-4" />
				{:else if kind === 'image'}
					<ImageIcon class="size-4" />
				{:else if kind === 'video'}
					<Video class="size-4" />
				{:else if kind === 'audio'}
					<Mic class="size-4" />
				{:else if kind === 'sticker'}
					<Sticker class="size-4" />
				{:else}
					<FileText class="size-4" />
				{/if}
			</span>
			<span class="label">{state.label}</span>

			{#if state.busy}
				<Spinner class="size-3.5" />
			{:else if state.canLoad}
				<Button variant="outline" size="sm" onclick={() => onload?.(message.id)}>
					<Download class="size-3.5" /> Load
				</Button>
			{:else if state.canRetry}
				<Button variant="outline" size="sm" onclick={() => onload?.(message.id)}>
					<RotateCw class="size-3.5" /> Retry
				</Button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.media {
		max-width: 320px;
	}
	.media.sticker-ready {
		max-width: 160px;
	}
	.placeholder {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		border: 1px solid var(--hairline-soft);
	}
	.terminal .placeholder {
		border-style: dashed;
		color: var(--ink-50);
	}
	.icon {
		display: inline-flex;
		color: var(--ink-70);
	}
	.label {
		font-size: 0.78rem;
		color: var(--ink-70);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.thumb {
		display: block;
		position: relative;
		padding: 0;
		border: 1px solid var(--hairline);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--surface-sunken);
		cursor: zoom-in;
	}
	.thumb img,
	.thumb video {
		display: block;
		max-width: 320px;
		max-height: 260px;
		object-fit: cover;
	}
	/* Stickers read as stickers: small, square, no photo chrome. */
	.sticker {
		display: block;
		padding: 0;
		border: none;
		border-radius: 0;
		background: transparent;
		cursor: zoom-in;
	}
	.sticker img {
		display: block;
		width: 140px;
		height: 140px;
		object-fit: contain;
	}
	.play {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: #fff;
		background: #00000040;
	}
	.audio {
		width: 260px;
		height: 2.2rem;
	}
	.document {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border-radius: var(--radius-md);
		background: var(--surface-sunken);
		border: 1px solid var(--hairline-soft);
		color: var(--ink-80);
		font-size: 0.8rem;
		text-decoration: none;
	}
	.doc-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
