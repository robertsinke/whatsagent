import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * D2: the voice documents live on disk under `<dataDir>/voice/`, and drafting reads
 * the files rather than the memory service. Hindsight is required to *learn*, never
 * to *draft* — with the container down the last consolidated voice still applies
 * (W4-R6), and drafting stays fast and deterministic.
 */

/**
 * Filesystem-safe, human-openable stem for a chat jid.
 *
 * `31612345678@s.whatsapp.net` becomes `31612345678-s-whatsapp-net`. Collisions are
 * theoretically possible but not reachable from real jids, which are `[0-9a-z.:-]`
 * plus a single `@`. The mental-model id uses this same stem, so a model id maps to
 * its file without a lookup table.
 */
export function voiceFileStem(chatJid: string): string {
	const stem = chatJid.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return stem || 'unknown';
}

export const GLOBAL_VOICE_STEM = 'global';

/** Whitelisted stems the inspector will resolve. Caller-supplied stems are rejected. */
export const VOICE_STEMS = new Set<string>([GLOBAL_VOICE_STEM]);

/** View of a voice document for the inspector — what drafting sees, never the model. */
export type VoiceDocumentView = {
	stem: string;
	content: string | null;
	byteLength: number;
	/** File mtime in ms since epoch, or null when the file is absent. */
	modifiedAt: number | null;
	path: string;
};

/** Reads and mirrors the voice markdown documents. Never throws on a missing file. */
export class VoiceFiles {
	readonly #dir: string;

	constructor(dataDir: string) {
		this.#dir = join(dataDir, 'voice');
	}

	get directory(): string {
		return this.#dir;
	}

	pathFor(stem: string): string {
		return join(this.#dir, `${stem}.md`);
	}

	/** Absent, unreadable, and blank all read as "nothing learned yet". */
	read(stem: string): string | null {
		try {
			const content = readFileSync(this.pathFor(stem), 'utf8').trim();
			return content.length > 0 ? content : null;
		} catch {
			return null;
		}
	}

	/**
	 * W4-U10: returns the document on disk plus the metadata that lets an owner
	 * diagnose staleness/truncation at a glance. Only pre-validated stems reach
	 * this method — the inspector route accepts no caller-supplied stem, so the
	 * path-traversal hole in `read()` (which joins `stem` into a path with no
	 * sanitization) is closed at the caller, not here. Never throws.
	 */
	inspect(stem: string): VoiceDocumentView {
		const path = this.pathFor(stem);
		try {
			const stat = statSync(path);
			const raw = readFileSync(path, 'utf8');
			const content = raw.trim().length > 0 ? raw : null;
			return {
				stem,
				content,
				byteLength: Buffer.byteLength(raw, 'utf8'),
				modifiedAt: stat.mtimeMs,
				path
			};
		} catch {
			return { stem, content: null, byteLength: 0, modifiedAt: null, path };
		}
	}

	/** The directory is created here, not in the constructor, so building the object touches no disk. */
	write(stem: string, content: string): void {
		mkdirSync(this.#dir, { recursive: true });
		writeFileSync(this.pathFor(stem), content, { encoding: 'utf8', mode: 0o600 });
	}
}

/** Truncates at a line boundary so a clipped markdown document never ends mid-sentence. */
function clip(markdown: string, maxChars: number): string {
	if (markdown.length <= maxChars) return markdown;
	const head = markdown.slice(0, maxChars);
	const boundary = head.lastIndexOf('\n');
	return `${(boundary > maxChars / 2 ? head.slice(0, boundary) : head).trimEnd()}\n…(voice document truncated)`;
}

/**
 * D4: global voice first, contact voice last, so the more specific guidance sits
 * closest to the task and wins on conflict. Both share one budget — two full
 * markdown documents can easily outweigh the conversation itself.
 */
export function composeVoice(
	global: string | null,
	contact: string | null,
	maxChars: number
): string | null {
	const half = Math.floor(maxChars / 2);
	const sections: string[] = [];
	if (global) sections.push(`## Owner voice (always)\n${clip(global, half)}`);
	if (contact) sections.push(`## Owner voice with this contact (takes precedence)\n${clip(contact, maxChars - (sections[0]?.length ?? 0))}`);
	return sections.length > 0 ? sections.join('\n\n') : null;
}
