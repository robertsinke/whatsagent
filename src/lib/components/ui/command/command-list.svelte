<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { scrollActivity } from "$lib/actions/scroll-activity.svelte.js";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.ListProps = $props();

	$effect(() => {
		const el = ref;
		if (!el) return;
		const action = scrollActivity(el);
		return () => action.destroy();
	});
</script>

<CommandPrimitive.List
	bind:ref
	data-slot="command-list"
	class={cn("scrollbar-contextual max-h-72 scroll-py-1 outline-none overflow-x-hidden overflow-y-auto", className)}
	{...restProps}
/>
