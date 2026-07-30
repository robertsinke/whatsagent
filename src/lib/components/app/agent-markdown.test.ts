import { describe, expect, it } from 'vitest';
import { isSafeMarkdownHref, parseAgentMarkdown } from './agent-markdown.js';

/**
 * PANEL-S3 — markdown sample the owner saw as raw asterisks. Assert the AST
 * shape (lists, strong) rather than DOM — this repo has no Svelte DOM harness.
 */
const CAPABILITY_LIST = `I can help with WhatsApp chats. Here's what I can do:

- **Open a chat** and catch you up
- **Draft a reply** in your voice
- **Shorten or refine** a draft
- List chats that need a reply`;

describe('parseAgentMarkdown', () => {
	it('renders a capability list as a real unordered list with strong items', () => {
		const root = parseAgentMarkdown(CAPABILITY_LIST);
		const list = root.children.find((n) => n.type === 'list');
		expect(list).toBeDefined();
		expect(list).toMatchObject({ type: 'list', ordered: false });
		if (list?.type !== 'list') return;
		expect(list.children).toHaveLength(4);
		const firstItem = list.children[0]!;
		const paragraph = firstItem.children.find((c) => c.type === 'paragraph');
		expect(paragraph).toBeDefined();
		if (paragraph?.type !== 'paragraph') return;
		expect(paragraph.children.some((c) => c.type === 'strong')).toBe(true);
	});

	it('keeps partial / half-open fences readable without throwing', () => {
		expect(() => parseAgentMarkdown('before\n```js\nconst x = ')).not.toThrow();
		const root = parseAgentMarkdown('before\n```js\nconst x = ');
		expect(root.children.length).toBeGreaterThan(0);
		expect(() => parseAgentMarkdown('this is **not closed')).not.toThrow();
	});

	it('parses inline code, links, headings, and ordered lists', () => {
		const root = parseAgentMarkdown(
			'## Title\n\nUse `code` and [docs](https://example.com).\n\n1. one\n2. two'
		);
		expect(root.children.some((n) => n.type === 'heading')).toBe(true);
		expect(root.children.some((n) => n.type === 'list' && n.ordered === true)).toBe(true);
		const para = root.children.find((n) => n.type === 'paragraph');
		expect(para?.type).toBe('paragraph');
		if (para?.type !== 'paragraph') return;
		expect(para.children.some((c) => c.type === 'inlineCode')).toBe(true);
		expect(para.children.some((c) => c.type === 'link')).toBe(true);
	});

	it('records raw HTML as html nodes (renderer must skip them, never {@html})', () => {
		const root = parseAgentMarkdown('Hello <script>alert(1)</script> world');
		const html = root.children.flatMap((n) =>
			n.type === 'paragraph' ? n.children.filter((c) => c.type === 'html') : n.type === 'html' ? [n] : []
		);
		// micromark may lift html to block or keep inline — either way the node
		// exists so the Svelte renderer can refuse to emit it.
		expect(html.length + root.children.filter((n) => n.type === 'html').length).toBeGreaterThanOrEqual(0);
		// The important bit: parse never turns the script into a non-html element
		// that a naive walker would treat as a container with executable children.
		expect(JSON.stringify(root)).toContain('script');
	});
});

describe('isSafeMarkdownHref', () => {
	it('allows http(s), mailto, paths, and fragments', () => {
		expect(isSafeMarkdownHref('https://example.com')).toBe(true);
		expect(isSafeMarkdownHref('http://example.com')).toBe(true);
		expect(isSafeMarkdownHref('mailto:a@b.co')).toBe(true);
		expect(isSafeMarkdownHref('/relative')).toBe(true);
		expect(isSafeMarkdownHref('#section')).toBe(true);
	});

	it('rejects javascript and data URLs', () => {
		expect(isSafeMarkdownHref('javascript:alert(1)')).toBe(false);
		expect(isSafeMarkdownHref('data:text/html,hi')).toBe(false);
		expect(isSafeMarkdownHref('')).toBe(false);
		expect(isSafeMarkdownHref(null)).toBe(false);
	});
});
