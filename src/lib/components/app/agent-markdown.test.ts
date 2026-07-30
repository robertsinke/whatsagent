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

	it('keeps raw HTML in html nodes, never as an element a walker would descend into', () => {
		const root = parseAgentMarkdown('Hello <script>alert(1)</script> world');
		const nodes = [
			...root.children.filter((n) => n.type === 'html'),
			...root.children.flatMap((n) => (n.type === 'paragraph' ? n.children : [])).filter((c) => c.type === 'html')
		];
		// The previous assertion here was `>= 0`, which is true of every input and
		// therefore tested nothing. What matters is that the script text lives in a
		// node the renderer refuses to emit, and in NO other node type — a walker
		// that met it as, say, a paragraph child would happily render it.
		expect(nodes.length).toBeGreaterThan(0);
		expect(nodes.map((n) => (n as { value: string }).value).join('')).toContain('<script>');
	});
});

/**
 * The renderer's whole safety argument is that it never interpolates
 * model-authored markup, so this asserts the absence of `{@html}` in the
 * component source. It reads like a lint rule because that is what it is: this
 * repo has no Svelte DOM harness (see the gotchas doc), so a render-level test
 * is not available, and the source is the only place the guarantee is visible.
 * Panel text is downstream of attacker-controlled chat content — see
 * docs/solutions/2026-07-29-draft-provider-tool-surface.md.
 */
describe('AgentMarkdown.svelte', () => {
	it('never interpolates raw HTML', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const source = readFileSync(
			fileURLToPath(new URL('./AgentMarkdown.svelte', import.meta.url)),
			'utf8'
		);
		expect(source).not.toContain('@html');
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
