/**
 * PANEL-S3 — safe, cheap markdown parse for agent panel text parts.
 *
 * WHY REMARK, NOT MILKDOWN / A RAW HTML PIPELINE. Text parts are snapshots that
 * re-arrive as they grow (see `opencode-harness.ts`), so this runs many times per
 * turn. Milkdown is an editor and is the wrong tool. We parse to an mdast tree
 * with the remark stack already in the repo (voice tab) and render nodes in
 * Svelte — never `{@html}`, never model-authored HTML. Raw `html` mdast nodes
 * are dropped; link URLs are allowlisted to http(s)/mailto.
 *
 * Partial / half-open syntax must not throw: remark is tolerant, and callers
 * wrap parse in try/catch as a belt.
 */

import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import type {
	Root,
	Content,
	PhrasingContent,
	List,
	ListItem,
	Paragraph,
	Heading,
	Link,
	Code,
	InlineCode,
	Emphasis,
	Strong,
	Text,
	Blockquote,
	Table,
	TableRow,
	TableCell
} from 'mdast';

const processor = remark().use(remarkGfm);

/** Parse markdown into an mdast root. Never throws — broken input becomes a text paragraph. */
export function parseAgentMarkdown(source: string): Root {
	try {
		return processor.parse(source) as Root;
	} catch {
		return {
			type: 'root',
			children: [{ type: 'paragraph', children: [{ type: 'text', value: source }] }]
		};
	}
}

/** True when a URL is safe to put in an <a href>. Rejects javascript:, data:, etc. */
export function isSafeMarkdownHref(href: string | null | undefined): boolean {
	if (!href) return false;
	const trimmed = href.trim();
	if (!trimmed) return false;
	// Protocol-relative and schemeless paths are fine; anything with a scheme must
	// be http(s) or mailto. A leading `#` fragment is also fine.
	if (/^[#/]/.test(trimmed)) return true;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		return /^(https?:|mailto:)/i.test(trimmed);
	}
	return true;
}

export type {
	Root,
	Content,
	PhrasingContent,
	List,
	ListItem,
	Paragraph,
	Heading,
	Link,
	Code,
	InlineCode,
	Emphasis,
	Strong,
	Text,
	Blockquote,
	Table,
	TableRow,
	TableCell
};
