import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_VOICE_STEM, hashVoiceContent, VoiceFiles, voiceFileStem } from './voice-files.js';

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
			path: join(dir, 'voice', 'global.md'),
			hash: hashVoiceContent(''),
			mirrorGuard: false
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

/**
 * P3.2 — the owner-edit mirror guard.
 *
 * `voice/global.md` is a MIRROR of a Hindsight mental model, and the mirror runs at
 * boot, every 60 s, every 6 h and nightly. Without this guard an owner's hand edit is
 * reverted within a minute. The guard keys on CONTENT HASH, never on
 * `last_refreshed_at` — see `canMirror` for why that distinction is the whole feature.
 */
describe('VoiceFiles owner-edit mirror guard (P3.2)', () => {
	const MACHINE = '- Writes short, lowercase replies.';
	const OWNER = '- Writes short replies, and never uses exclamation marks.';

	function seeded(content = MACHINE): { dir: string; files: VoiceFiles } {
		const dir = tempDataDir();
		const files = new VoiceFiles(dir);
		mkdirSync(join(dir, 'voice'), { recursive: true });
		writeFileSync(join(dir, 'voice', 'global.md'), content, 'utf8');
		return { dir, files };
	}

	it('writes the document, the sidecar, and a backup of the OWNER text', () => {
		const { dir, files } = seeded();
		const record = files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);

		expect(readFileSync(join(dir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
		// The backup holds the owner's words, not the machine's — the machine can always
		// regenerate its side, the owner's edit is the irreplaceable one.
		expect(readFileSync(join(dir, 'voice', 'global.owner-backup.md'), 'utf8')).toBe(OWNER);
		expect(record.ownerHash).toBe(hashVoiceContent(OWNER));
		expect(record.preEditHash).toBe(hashVoiceContent(MACHINE));
		expect(files.ownerEdit(GLOBAL_VOICE_STEM)).toEqual(record);
	});

	it('refuses a mirror still carrying the pre-edit document, and reports the guard', () => {
		const { dir, files } = seeded();
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);

		expect(files.canMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(false);
		expect(files.writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(false);
		expect(readFileSync(join(dir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
		expect(files.inspect(GLOBAL_VOICE_STEM).mirrorGuard).toBe(true);
	});

	it('normalizes whitespace on both sides — a re-indented mirror is still the pre-edit document', () => {
		// The mirror writes `(model.content ?? '').trim()` while the file on disk keeps
		// whatever the editor left. Hashing raw on one side and trimmed on the other
		// releases the guard on the first tick, which looks exactly like it working.
		const { files } = seeded(`\n${MACHINE}\n\n`);
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, `${OWNER}\n`);

		expect(files.canMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(false);
		expect(files.canMirror(GLOBAL_VOICE_STEM, `${MACHINE}\n  `)).toBe(false);
	});

	it('releases and mirrors when the model genuinely moves on', () => {
		const { dir, files } = seeded();
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);
		const fresh = '- Signs off with "grtjs".\n- Never uses exclamation marks.';

		expect(files.writeMirror(GLOBAL_VOICE_STEM, fresh)).toBe(true);
		expect(readFileSync(join(dir, 'voice', 'global.md'), 'utf8')).toBe(fresh);
		expect(files.ownerEdit(GLOBAL_VOICE_STEM)).toBe(null);
		expect(existsSync(join(dir, 'voice', 'global.owner.json'))).toBe(false);
		// The backup deliberately survives the release — it costs nothing and it is the
		// only remaining copy of what the owner wrote.
		expect(readFileSync(join(dir, 'voice', 'global.owner-backup.md'), 'utf8')).toBe(OWNER);
	});

	it('holds across TWO consecutive saves — the second must not reset preEditHash to the first edit', () => {
		// The hole: recomputing preEditHash from disk on save two sets it to edit one, so
		// the machine document the guard was holding off reads as "genuinely moved on"
		// and overwrites edit two.
		const { dir, files } = seeded();
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);
		const second = `${OWNER}\n- Answers in Dutch to Dutch messages.`;
		const record = files.writeOwnerEdit(GLOBAL_VOICE_STEM, second);

		expect(record.preEditHash).toBe(hashVoiceContent(MACHINE));
		expect(files.writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(false);
		expect(readFileSync(join(dir, 'voice', 'global.md'), 'utf8')).toBe(second);
	});

	it('survives re-instantiation on the same dir — the sidecar is on disk, not in memory', () => {
		// index.ts mirrors synchronously at boot, before anything could rebuild in-memory
		// state, which is why the record is a file and not a map (and needs no migration).
		const { dir, files } = seeded();
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);

		const afterRestart = new VoiceFiles(dir);
		expect(afterRestart.ownerEdit(GLOBAL_VOICE_STEM)?.ownerHash).toBe(hashVoiceContent(OWNER));
		expect(afterRestart.writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(false);
		expect(readFileSync(join(dir, 'voice', 'global.md'), 'utf8')).toBe(OWNER);
	});

	it('self-releases when the on-disk document diverges from ownerHash', () => {
		// Someone edited global.md in an editor, or restored a backup over it. The sidecar
		// no longer describes reality, so it has no authority to hold anything off.
		const { dir, files } = seeded();
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);
		writeFileSync(join(dir, 'voice', 'global.md'), '- Something else entirely.', 'utf8');

		expect(files.writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(true);
		expect(readFileSync(join(dir, 'voice', 'global.md'), 'utf8')).toBe(MACHINE);
		expect(files.ownerEdit(GLOBAL_VOICE_STEM)).toBe(null);
	});

	it('has NO TTL — an edit unrefreshed for a year still holds', () => {
		// If Hindsight never refreshes, the owner's edit IS the best-known voice. Expiring
		// the guard would silently restore a document the owner explicitly corrected.
		const { dir, files } = seeded();
		files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);
		const stale = { ...files.ownerEdit(GLOBAL_VOICE_STEM)!, editedAt: '2020-01-01T00:00:00.000Z' };
		writeFileSync(join(dir, 'voice', 'global.owner.json'), JSON.stringify(stale), 'utf8');

		expect(new VoiceFiles(dir).writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(false);
	});

	it('treats a corrupt or absent sidecar as "no guard" rather than throwing', () => {
		// #mirrorAll runs at boot; a throw here would skip every remaining model.
		const { dir, files } = seeded();
		expect(files.ownerEdit(GLOBAL_VOICE_STEM)).toBe(null);
		writeFileSync(join(dir, 'voice', 'global.owner.json'), 'not json{{', 'utf8');
		expect(files.ownerEdit(GLOBAL_VOICE_STEM)).toBe(null);
		expect(files.writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(true);
		// And releasing a guard that was never armed is a no-op, not an error.
		expect(() => files.releaseOwnerEdit(GLOBAL_VOICE_STEM)).not.toThrow();
	});

	it('arms even when the document did not exist yet', () => {
		const dir = tempDataDir();
		const files = new VoiceFiles(dir);
		const record = files.writeOwnerEdit(GLOBAL_VOICE_STEM, OWNER);

		expect(record.preEditHash).toBe(hashVoiceContent(''));
		expect(files.writeMirror(GLOBAL_VOICE_STEM, MACHINE)).toBe(true);
	});
});

describe('voiceFileStem', () => {
	it('sanitizes a jid to a filesystem-safe, human-openable stem', () => {
		expect(voiceFileStem('31612345678@s.whatsapp.net')).toBe('31612345678-s-whatsapp-net');
	});
});