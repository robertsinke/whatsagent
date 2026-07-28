import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * The single content-identity function for voice documents. Everything that compares
 * two versions of a document — the owner-edit guard, the route's `baseHash` — must go
 * through this one, and it must **trim**.
 *
 * The mirror writes `(model.content ?? '').trim()`, `read()` trims, and `inspect()`
 * returns the raw file. Hashing raw bytes on one side and trimmed text on the other
 * makes the guard release on the very first tick — a failure that looks exactly like a
 * working implementation until an owner loses an edit. Milkdown also rewrites trailing
 * whitespace on every round-trip, so this is a live path, not a hypothetical.
 */
export function hashVoiceContent(content: string): string {
	return createHash('sha256').update(content.trim(), 'utf8').digest('hex');
}

/**
 * Sidecar written beside a hand-edited voice document. `preEditHash` is what makes the
 * guard content-keyed instead of time-keyed: it identifies the exact document the owner
 * was correcting, so a mirror still carrying it is recognisably stale no matter what
 * `last_refreshed_at` says.
 */
export type OwnerEditRecord = {
	/** Hash of the content the owner saved — the guard self-releases if disk diverges from it. */
	ownerHash: string;
	/** Hash of what was on disk immediately before the save. A mirror offering this is refused. */
	preEditHash: string;
	/** ISO timestamp of the save. Diagnostic only — never an input to the guard decision. */
	editedAt: string;
};

/** View of a voice document for the inspector — what drafting sees, never the model. */
export type VoiceDocumentView = {
	stem: string;
	content: string | null;
	byteLength: number;
	/** File mtime in ms since epoch, or null when the file is absent. */
	modifiedAt: number | null;
	path: string;
	/** Content hash of the file, or of `''` when absent. The `baseHash` for the next save. */
	hash: string;
	/** True while an owner edit is holding the Hindsight mirror off this document. */
	mirrorGuard: boolean;
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

	/** Sidecar recording an owner edit. Absent = no guard armed. */
	ownerEditPathFor(stem: string): string {
		return join(this.#dir, `${stem}.owner.json`);
	}

	/**
	 * Copy of the owner's saved text. The guard is what keeps the edit; this is what
	 * survives if the guard is ever wrong — the owner's words are the irreplaceable side
	 * of this exchange, the machine can always regenerate its own.
	 */
	ownerBackupPathFor(stem: string): string {
		return join(this.#dir, `${stem}.owner-backup.md`);
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
		const mirrorGuard = this.ownerEdit(stem) !== null;
		try {
			const stat = statSync(path);
			const raw = readFileSync(path, 'utf8');
			const content = raw.trim().length > 0 ? raw : null;
			return {
				stem,
				content,
				byteLength: Buffer.byteLength(raw, 'utf8'),
				modifiedAt: stat.mtimeMs,
				path,
				hash: hashVoiceContent(raw),
				mirrorGuard
			};
		} catch {
			return {
				stem,
				content: null,
				byteLength: 0,
				modifiedAt: null,
				path,
				hash: hashVoiceContent(''),
				mirrorGuard
			};
		}
	}

	/**
	 * P3.2: the owner's hand edit, plus the sidecar that arms the mirror guard.
	 *
	 * Arming happens here and unconditionally — never at the call site, and never
	 * conditional on the Hindsight directive having succeeded. "Hindsight is down" does
	 * not mean mirroring stopped: `HindsightMemory` sets `#offlineUntil` and resumes
	 * minutes later. An edit saved during an outage that skipped arming would be
	 * overwritten the moment the container came back.
	 *
	 * On a **second** save the existing `preEditHash` is preserved as long as disk still
	 * matches the previous `ownerHash`. Recomputing it from disk would set it to the
	 * first edit — and the machine document the guard was holding off would then read as
	 * "genuinely moved on" and overwrite edit two.
	 */
	writeOwnerEdit(stem: string, content: string): OwnerEditRecord {
		const previous = this.ownerEdit(stem);
		const onDisk = this.#readRaw(stem);
		const preEditHash =
			previous && hashVoiceContent(onDisk) === previous.ownerHash
				? previous.preEditHash
				: hashVoiceContent(onDisk);
		const record: OwnerEditRecord = {
			ownerHash: hashVoiceContent(content),
			preEditHash,
			editedAt: new Date().toISOString()
		};
		this.#writeFile(this.pathFor(stem), content);
		this.#writeFile(this.ownerBackupPathFor(stem), content);
		this.#writeFile(this.ownerEditPathFor(stem), `${JSON.stringify(record, null, 2)}\n`);
		return record;
	}

	/**
	 * The guarded mirror write — the only way Hindsight content reaches disk. Returns
	 * false when an owner edit is holding this document, so the caller can decline to
	 * advance its "already mirrored" bookkeeping.
	 */
	writeMirror(stem: string, content: string): boolean {
		if (!this.canMirror(stem, content)) return false;
		this.#writeFile(this.pathFor(stem), content);
		return true;
	}

	/**
	 * Keyed on content hash, **never** on `last_refreshed_at`.
	 *
	 * `refreshMentalModel` is a trigger, not a synchronous generate: Hindsight parks a
	 * placeholder in `content` and regenerates in the background, while
	 * `refreshVoiceModels()` mirrors on the very next line. A timestamp-keyed guard would
	 * therefore be released by the button labelled "make my correction take effect", and
	 * the pre-edit document would be written straight back over the owner's edit.
	 *
	 * No TTL: if Hindsight never refreshes, the owner's edit *is* the best-known voice.
	 * The release valve is genuinely new content arriving.
	 */
	canMirror(stem: string, candidate: string): boolean {
		const record = this.ownerEdit(stem);
		if (!record) return true;
		// Changed by something other than us (hand edit in an editor, restore from backup):
		// the sidecar no longer describes reality, so it has no authority to hold anything.
		if (hashVoiceContent(this.#readRaw(stem)) !== record.ownerHash) {
			this.releaseOwnerEdit(stem);
			return true;
		}
		// Still the document the owner was correcting. Hold, however fresh it claims to be.
		if (hashVoiceContent(candidate) === record.preEditHash) return false;
		// Genuinely moved on — the correction has been absorbed. Step aside.
		this.releaseOwnerEdit(stem);
		return true;
	}

	/** Never throws: an absent or corrupt sidecar reads as "no guard", like `read()`. */
	ownerEdit(stem: string): OwnerEditRecord | null {
		try {
			const parsed = JSON.parse(readFileSync(this.ownerEditPathFor(stem), 'utf8')) as unknown;
			if (!parsed || typeof parsed !== 'object') return null;
			const record = parsed as Partial<OwnerEditRecord>;
			if (typeof record.ownerHash !== 'string' || typeof record.preEditHash !== 'string') {
				return null;
			}
			return {
				ownerHash: record.ownerHash,
				preEditHash: record.preEditHash,
				editedAt: typeof record.editedAt === 'string' ? record.editedAt : ''
			};
		} catch {
			return null;
		}
	}

	/**
	 * Idempotent. The backup is deliberately left behind — it costs nothing and it is the
	 * only copy of the owner's words once the mirror moves on.
	 */
	releaseOwnerEdit(stem: string): void {
		rmSync(this.ownerEditPathFor(stem), { force: true });
	}

	/** Raw file text, or `''` when absent — the input to every hash comparison. */
	#readRaw(stem: string): string {
		try {
			return readFileSync(this.pathFor(stem), 'utf8');
		} catch {
			return '';
		}
	}

	/** The directory is created here, not in the constructor, so building the object touches no disk. */
	#writeFile(path: string, content: string): void {
		mkdirSync(this.#dir, { recursive: true });
		writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
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
