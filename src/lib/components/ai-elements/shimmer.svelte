<script lang="ts">
	import { onMount } from 'svelte';
	import { animate } from 'motion';

	let {
		children = 'Thinking...',
		as = 'p',
		duration = 2,
		spread = 2,
		class: className = ''
	}: {
		children?: string;
		as?: 'p' | 'h2' | 'h3' | 'span' | 'div';
		duration?: number;
		spread?: number;
		class?: string;
	} = $props();

	let el: HTMLElement;
	const dynamicSpread = $derived((children?.length ?? 0) * spread);

	onMount(() => {
		const controls = animate(
			el,
			{ backgroundPosition: ['100% center', '0% center'] },
			{ duration, ease: 'linear', repeat: Infinity }
		);
		return () => controls.stop();
	});
</script>

<svelte:element
	this={as}
	bind:this={el}
	class={`relative inline-block bg-clip-text text-transparent bg-[length:250%_100%,auto] [background-repeat:no-repeat,padding-box] ${className}`}
	style={`--spread:${dynamicSpread}px;background-image:linear-gradient(90deg,#0000 calc(50% - var(--spread)),color-mix(in srgb, var(--cobalt) 55%, var(--color-background)),#0000 calc(50% + var(--spread))),linear-gradient(var(--color-muted-foreground),var(--color-muted-foreground))`}
>
	{children}
</svelte:element>
