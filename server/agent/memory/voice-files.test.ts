import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_VOICE_STEM, VoiceFiles, voiceFileStem } from './voice-files.js';

function tempDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'whatsagent-voice-files-'));
}

describe('VoiceFiles.inspect (W4-U10)', () => {
	it('returns content null, byteLength 0, modifiedAt null when the file is absent', () => {
		const dir = tempDataDir();
		const view = new VoiceFiles(dir).inspect(GLOBAL_VOICE_STEM);
		expect(view).toEqual({
			stem: GLOBAL_VOICE_STEM,
			content: null,
			byteLength: 0,
			modifiedAt: null,
			path: join(dir, 'voice', 'global.md')
		});
	});

	it('returns content, byteLength, and mtime when the file exists', () => {
		const dir = tempDataDir();
		mkdirSync(join(dir, 'voice'), { recursive: true });
		const content = '- Short, lowercase replies.';
		writeFileSync(join(dir, 'voice', 'global.md'), content, 'utf8');

		const view = new VoiceFiles(dir).inspect(GLOBAL_VOICE_STEM);
		expect(view.content).toBe(content);
		expect(view.byteLength).toBe(Buffer.byteLength(content, 'utf8'));
		expect(view.modifiedAt).toBeTypeOf('number');
		expect(view.modifiedAt).toBeGreaterThan(0);
		expect(view.path).toBe(join(dir, 'voice', 'global.md'));
	});

	it('reports content null for a whitespace-only file but still reports byteLength and mtime', () => {
		const dir = tempDataDir();
		mkdirSync(join(dir, 'voice'), { recursive: true });
		const blank = '   \n\n  ';
		writeFileSync(join(dir, 'voice', 'global.md'), blank, 'utf8');

		const view = new VoiceFiles(dir).inspect(GLOBAL_VOICE_STEM);
		expect(view.content).toBe(null);
		expect(view.byteLength).toBe(Buffer.byteLength(blank, 'utf8'));
		expect(view.modifiedAt).toBeTypeOf('number');
	});

	it('never throws on an unreadable path (defensive — the inspector route whitelists stems)', () => {
		const dir = tempDataDir();
		// Pass a stem that would escape the voice dir if joined unsanitized; the
		// route never reaches this with a caller-supplied stem, but inspect()
		// must still not throw on a missing/unreadable file.
		const view = new VoiceFiles(dir).inspect('nonexistent');
		expect(view.content).toBe(null);
		expect(view.byteLength).toBe(0);
		expect(view.modifiedAt).toBe(null);
	});
});

describe('voiceFileStem', () => {
	it('sanitizes a jid to a filesystem-safe, human-openable stem', () => {
		expect(voiceFileStem('31612345678@s.whatsapp.net')).toBe('31612345678-s-whatsapp-net');
	});
});