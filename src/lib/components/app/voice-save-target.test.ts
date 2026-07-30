import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveVoiceSaveTarget } from './voice-save-target.js';

/**
 * Two-table fixture shaped like the owner's real `voice/global.md` (and the
 * preview seed after PANEL-S13). Milkdown `getMarkdown()` rewrites this —
 * hyphen→asterisk, table padding, blank lines — so a Save that blindly wrote
 * live serialization would change SHA-256 with zero keystrokes.
 */
export const TWO_TABLE_VOICE_FIXTURE = [
	'# Owner voice (global)',
	'',
	'## Tone',
	'- Casual-first, warm, unedited.',
	'- Short and punchy by default; expands only for emotional or explanatory contexts.',
	'',
	'## Channel defaults',
	'',
	'| Channel | Default tone | Emoji density |',
	'| --- | --- | --- |',
	'| WhatsApp | casual | low |',
	'| Email | professional | none |',
	'| Calendar | terse | none |',
	'',
	'## Habits',
	'',
	'| Habit | Evidence |',
	'| --- | --- |',
	'| Short replies | ok / later |',
	'| Warm closers | xx |',
	'',
	'## Sign-offs',
	'- Minimal or emoji-based. No formal closers.'
].join('\n');

/** A plausible post-Milkdown rewrite of the fixture (lossy, not byte-identical). */
const LOSSY_SERIALIZATION = [
	'# Owner voice (global)',
	'',
	'## Tone',
	'',
	'* Casual-first, warm, unedited.',
	'',
	'* Short and punchy by default; expands only for emotional or explanatory contexts.',
	'',
	'## Channel defaults',
	'',
	'| Channel   | Default tone  | Emoji density |',
	'| --------- | ------------- | ------------- |',
	'| WhatsApp  | casual        | low           |',
	'| Email     | professional  | none          |',
	'| Calendar  | terse         | none          |',
	'',
	'## Habits',
	'',
	'| Habit         | Evidence   |',
	'| ------------- | ---------- |',
	'| Short replies | ok / later |',
	'| Warm closers  | xx         |',
	'',
	'## Sign-offs',
	'',
	'* Minimal or emoji-based. No formal closers.',
	''
].join('\n');

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('resolveVoiceSaveTarget (PANEL-S13 zero-edit guard)', () => {
	it('keeps the loaded bytes on a zero-edit Save even when live serialization differs', () => {
		expect(LOSSY_SERIALIZATION).not.toBe(TWO_TABLE_VOICE_FIXTURE);
		expect(sha256(LOSSY_SERIALIZATION)).not.toBe(sha256(TWO_TABLE_VOICE_FIXTURE));

		const result = resolveVoiceSaveTarget({
			baseline: TWO_TABLE_VOICE_FIXTURE,
			draft: TWO_TABLE_VOICE_FIXTURE,
			liveMarkdown: LOSSY_SERIALIZATION
		});

		expect(result.write).toBe(false);
		expect(result.content).toBe(TWO_TABLE_VOICE_FIXTURE);
		expect(sha256(result.content)).toBe(sha256(TWO_TABLE_VOICE_FIXTURE));
	});

	it('preserves both GFM tables byte-for-byte when the owner has not edited', () => {
		const result = resolveVoiceSaveTarget({
			baseline: TWO_TABLE_VOICE_FIXTURE,
			draft: TWO_TABLE_VOICE_FIXTURE,
			liveMarkdown: LOSSY_SERIALIZATION
		});
		expect(result.content).toContain('| Channel | Default tone | Emoji density |');
		expect(result.content).toContain('| Habit | Evidence |');
		expect(result.content.match(/^\|/gm)?.length).toBe(
			TWO_TABLE_VOICE_FIXTURE.match(/^\|/gm)?.length
		);
	});

	it('uses live editor markdown once the draft is dirty from an owner edit', () => {
		const edited = TWO_TABLE_VOICE_FIXTURE.replace(
			'- Casual-first, warm, unedited.',
			'- Casual-first, warm, unedited. (tweaked)'
		);
		const live = edited.replaceAll('- ', '* ');
		const result = resolveVoiceSaveTarget({
			baseline: TWO_TABLE_VOICE_FIXTURE,
			draft: edited,
			liveMarkdown: live
		});
		expect(result.write).toBe(true);
		expect(result.content).toBe(live);
	});

	it('skips the write when a dirty draft round-trips back to the baseline', () => {
		const result = resolveVoiceSaveTarget({
			baseline: TWO_TABLE_VOICE_FIXTURE,
			draft: TWO_TABLE_VOICE_FIXTURE + ' ',
			liveMarkdown: TWO_TABLE_VOICE_FIXTURE
		});
		expect(result.write).toBe(false);
		expect(result.content).toBe(TWO_TABLE_VOICE_FIXTURE);
	});
});
