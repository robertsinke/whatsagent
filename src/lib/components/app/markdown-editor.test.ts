import { describe, expect, it } from 'vitest';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';

/**
 * Remark round-trip test over a GFM table fixture.
 *
 * This is a CHEAP, honest net — it proves the remark pipeline (parse →
 * remark-gfm → stringify) that feeds Milkdown preserves GFM tables through a
 * round trip. It does NOT prove the full editor round-trips: Milkdown
 * serializes through its ProseMirror schema, not remark alone, so this test
 * would have passed SlayZone's raw-HTML case while the real editor mangled it.
 * The real proof is the manual save-with-zero-edits diff in the Voice tab UI
 * task (P3.4), not this file.
 *
 * The fixture mirrors the shape of the real `voice/global.md` tables: a
 * three-column header row, a separator, and a few body rows.
 *
 * Note: remark-stringify NORMALIZES whitespace — it pads table cells to align
 * columns (`| WhatsApp  |`) and emits bullet lists with `*` rather than `-`.
 * These are not byte-identical round trips, and the assertions below check
 * semantic content, not exact bytes. The idempotency assertion is the property
 * the editor actually relies on: the serialized form is a fixed point, so a
 * repeated save-with-zero-edits is a no-op after the first normalization.
 */

const TABLE_FIXTURE = [
	'# Owner voice (global)',
	'',
	'## Tone',
	'- Casual-first, warm, unedited.',
	'- Short and punchy by default.',
	'',
	'## Channel defaults',
	'',
	'| Channel | Default tone | Emoji density |',
	'| --- | --- | --- |',
	'| WhatsApp | casual | low |',
	'| Email | professional | none |',
	'| Calendar | terse | none |',
	'',
	'## Sign-offs',
	'- Minimal or emoji-based. No formal closers.'
].join('\n');

async function roundTrip(markdown: string): Promise<string> {
	const file = await remark().use(remarkGfm).process(markdown);
	return String(file);
}

describe('remark GFM table round-trip', () => {
	it('preserves a GFM table through parse + stringify (semantic content)', async () => {
		const out = await roundTrip(TABLE_FIXTURE);

		// The table block survives with all its cells — remark-stringify pads
		// cells to align columns, so assert on the cell text, not the exact
		// pipe spacing. The header row, separator, and every body row are present.
		expect(out).toContain('Channel');
		expect(out).toContain('Default tone');
		expect(out).toContain('Emoji density');
		expect(out).toContain('WhatsApp');
		expect(out).toContain('casual');
		expect(out).toContain('low');
		expect(out).toContain('Email');
		expect(out).toContain('professional');
		expect(out).toContain('Calendar');
		expect(out).toContain('terse');
		// The GFM table separator survives (dashes, possibly padded).
		expect(out).toMatch(/\|[-\s|]+\|/);
	});

	it('preserves the surrounding commonmark structure (headings, lists)', async () => {
		const out = await roundTrip(TABLE_FIXTURE);

		// Headings survive — the table did not eat them.
		expect(out).toContain('# Owner voice (global)');
		expect(out).toContain('## Tone');
		expect(out).toContain('## Channel defaults');
		expect(out).toContain('## Sign-offs');
		// remark-stringify emits bullet lists with `*` instead of `-`; assert on
		// the list item text, not the marker.
		expect(out).toContain('Casual-first, warm, unedited.');
		expect(out).toContain('Minimal or emoji-based. No formal closers.');
	});

	it('re-serializes idempotently — a second pass over the first output is a no-op', async () => {
		// This is the property the editor relies on: the serialized form is a
		// fixed point of the remark pipeline, so a repeated save-with-zero-edits
		// is a no-op after the first normalization. If this breaks, the Voice tab
		// would show a spurious diff on every open-and-save.
		const first = await roundTrip(TABLE_FIXTURE);
		const second = await roundTrip(first);
		expect(second).toBe(first);
	});
});