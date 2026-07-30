<script lang="ts">
	/**
	 * Renders an mdast tree as Svelte elements — never as an HTML string.
	 * Model-authored raw HTML nodes are skipped; link hrefs are allowlisted.
	 */
	import {
		isSafeMarkdownHref,
		parseAgentMarkdown,
		type Content,
		type PhrasingContent
	} from './agent-markdown.js';

	let { source }: { source: string } = $props();

	const root = $derived(parseAgentMarkdown(source));
</script>

{#snippet phrasing(nodes: PhrasingContent[])}
	{#each nodes as node, i (i)}
		{#if node.type === 'text'}
			{node.value}
		{:else if node.type === 'strong'}
			<strong>{@render phrasing(node.children)}</strong>
		{:else if node.type === 'emphasis'}
			<em>{@render phrasing(node.children)}</em>
		{:else if node.type === 'delete'}
			<del>{@render phrasing(node.children)}</del>
		{:else if node.type === 'inlineCode'}
			<code class="md-code">{node.value}</code>
		{:else if node.type === 'break'}
			<br />
		{:else if node.type === 'link'}
			{#if isSafeMarkdownHref(node.url)}
				<a href={node.url} rel="noopener noreferrer" target="_blank">{@render phrasing(node.children)}</a>
			{:else}
				{@render phrasing(node.children)}
			{/if}
		{:else if node.type === 'image'}
			{#if isSafeMarkdownHref(node.url)}
				<img class="md-img" src={node.url} alt={node.alt ?? ''} />
			{:else if node.alt}
				{node.alt}
			{/if}
		{:else if 'children' in node && Array.isArray(node.children)}
			{@render phrasing(node.children as PhrasingContent[])}
		{/if}
	{/each}
{/snippet}

{#snippet block(nodes: Content[])}
	{#each nodes as node, i (i)}
		{#if node.type === 'paragraph'}
			<p class="md-p">{@render phrasing(node.children)}</p>
		{:else if node.type === 'heading'}
			{#if node.depth === 1}
				<h1 class="md-h">{@render phrasing(node.children)}</h1>
			{:else if node.depth === 2}
				<h2 class="md-h">{@render phrasing(node.children)}</h2>
			{:else if node.depth === 3}
				<h3 class="md-h">{@render phrasing(node.children)}</h3>
			{:else}
				<h4 class="md-h">{@render phrasing(node.children)}</h4>
			{/if}
		{:else if node.type === 'list'}
			{#if node.ordered}
				<ol class="md-ol">
					{#each node.children as item, j (j)}
						<li>{@render block(item.children)}</li>
					{/each}
				</ol>
			{:else}
				<ul class="md-ul">
					{#each node.children as item, j (j)}
						<li>{@render block(item.children)}</li>
					{/each}
				</ul>
			{/if}
		{:else if node.type === 'code'}
			<pre class="md-pre"><code>{node.value}</code></pre>
		{:else if node.type === 'blockquote'}
			<blockquote class="md-quote">{@render block(node.children)}</blockquote>
		{:else if node.type === 'thematicBreak'}
			<hr class="md-hr" />
		{:else if node.type === 'table'}
			<table class="md-table">
				<tbody>
					{#each node.children as row, r (r)}
						<tr>
							{#each row.children as cell, c (c)}
								{#if r === 0}
									<th>{@render phrasing(cell.children)}</th>
								{:else}
									<td>{@render phrasing(cell.children)}</td>
								{/if}
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if node.type === 'html'}
			<!-- Attacker-controlled raw HTML is never interpolated into the DOM. -->
		{:else if node.type === 'listItem'}
			{@render block(node.children)}
		{:else if 'children' in node && Array.isArray(node.children)}
			{@render block(node.children as Content[])}
		{/if}
	{/each}
{/snippet}

<div class="agent-md" data-testid="agent-markdown">
	{@render block(root.children)}
</div>

<style>
	.agent-md {
		font-size: 0.84rem;
		line-height: 1.45;
		color: inherit;
		min-width: 0;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.agent-md :global(.md-p) {
		margin: 0 0 0.45em;
	}
	.agent-md :global(.md-p:last-child) {
		margin-bottom: 0;
	}
	.agent-md :global(.md-h) {
		margin: 0.55em 0 0.3em;
		font-size: 0.9rem;
		font-weight: 650;
		line-height: 1.3;
		color: var(--ink-90);
	}
	.agent-md :global(.md-ul),
	.agent-md :global(.md-ol) {
		margin: 0.25em 0 0.45em;
		padding-left: 1.25em;
	}
	.agent-md :global(.md-ul) {
		list-style: disc;
	}
	.agent-md :global(.md-ol) {
		list-style: decimal;
	}
	.agent-md :global(li) {
		margin: 0.15em 0;
	}
	.agent-md :global(.md-code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78em;
		padding: 0.05em 0.3em;
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--ink-50) 14%, transparent);
	}
	.agent-md :global(.md-pre) {
		margin: 0.35em 0;
		padding: 0.55em 0.65em;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--surface-raised) 70%, transparent);
		border: 1px solid var(--hairline-soft);
		overflow-x: auto;
		font-size: 0.76rem;
		line-height: 1.4;
	}
	.agent-md :global(.md-pre code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.agent-md :global(.md-quote) {
		margin: 0.35em 0;
		padding: 0.15em 0 0.15em 0.7em;
		border-left: 2px solid var(--hairline);
		color: var(--ink-70);
	}
	.agent-md :global(.md-hr) {
		border: none;
		border-top: 1px solid var(--hairline-soft);
		margin: 0.55em 0;
	}
	.agent-md :global(.md-table) {
		border-collapse: collapse;
		font-size: 0.78rem;
		margin: 0.35em 0;
		width: 100%;
	}
	.agent-md :global(.md-table th),
	.agent-md :global(.md-table td) {
		border: 1px solid var(--hairline-soft);
		padding: 0.25em 0.4em;
		text-align: left;
	}
	.agent-md :global(.md-table th) {
		font-weight: 600;
		background: color-mix(in srgb, var(--surface-raised) 55%, transparent);
	}
	.agent-md :global(a) {
		color: var(--cobalt);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.agent-md :global(.md-img) {
		max-width: 100%;
		height: auto;
		border-radius: var(--radius-md);
	}
</style>
