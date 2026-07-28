/**
 * P3.1: "is this a real voice document?" — the one rule the server's mirror gate and
 * the client's save warning must agree on.
 *
 * This lives in `shared/` because both sides need it and a drifted copy is invisible:
 * the server refuses to mirror a document the client just told the owner looks fine,
 * or the Voice tab stays silent while a Milkdown round-trip mangles the two GFM tables
 * out of the document. Dependency-free by construction (no `node:*`, nothing from
 * `$lib`) so it bundles for the browser.
 *
 * On the client this is a **warning**, never a rejection. Refusing to save a legitimate
 * owner edit because a heuristic disagreed is worse than the mangling it guards against.
 */

/**
 * Hindsight parks this literal in `content` while a refresh is in flight. Mirroring it
 * would put "Generating content..." into the draft prompt as if it were the owner's
 * voice, and — worse — overwrite the last good document with it.
 */
export const REFRESH_IN_PROGRESS_CONTENT = 'Generating content...';

/**
 * Positive test for "is this a real voice document?", replacing the two-string blocklist
 * that could not anticipate what an LLM writes when it has nothing to say.
 *
 * The signal is *meaning*, not markup: quoted evidence attached to named habits. The
 * reflect model does not format consistently between runs — list items, bold labels with
 * blockquotes, and "Evidence:" sections with italic quotes have all appeared in the wild.
 * Coupling the filter to `^\s*[-*]\s+` silently froze voice when a good document arrived
 * as blockquotes instead (see docs/solutions/2026-07-26-voice-filter-rejects-valid-documents.md).
 *
 * Still rejects: empty, the in-flight placeholder, "no information" verdicts, mid-token
 * truncations (unclosed `**…`, heading cut at `/`), and bare prose with neither a habit
 * list nor labeled evidence.
 */
export function looksLikeVoiceDocument(content: string): boolean {
	const trimmed = content.trim();
	if (!trimmed) return false;
	if (trimmed === REFRESH_IN_PROGRESS_CONTENT) return false;
	// A "no information" / "I don't have information" verdict — the failure mode the old
	// blocklist missed. Match the common phrasings regardless of surrounding sentence.
	const lower = trimmed.toLowerCase();
	if (
		lower.includes("don't have information") ||
		lower.includes('do not have information') ||
		lower.includes('no information about the owner') ||
		lower.includes('not enough information') ||
		lower.includes('no discernible') ||
		lower.includes('unable to determine')
	) {
		return false;
	}
	if (isTruncatedVoiceDocument(trimmed)) return false;

	// Shape A — markdown list of habits (classic). Require at least one substantive item.
	const items = trimmed.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line));
	const substantive = items.filter((line) => {
		const text = line.replace(/^\s*[-*]\s+/, '').toLowerCase();
		return (
			text.length > 0 &&
			!text.startsWith('no information') &&
			!text.startsWith("don't have") &&
			!text.startsWith('do not have') &&
			!text.startsWith('unable to')
		);
	});
	if (substantive.length > 0) return true;

	// Shape B — labeled habits with quoted evidence (bold labels + blockquotes, or
	// headings + quote marks). No list items required.
	const hasNamedHabit = /\*\*[^*]+\*\*/.test(trimmed) || /^#{1,3}\s+\S/m.test(trimmed);
	const hasQuotedEvidence =
		/^\s*>\s*\S/m.test(trimmed) || /["“”*][^"“”\n]+["“”*]/.test(trimmed);
	return hasNamedHabit && hasQuotedEvidence;
}

/**
 * A document cut mid-generation (max_tokens ceiling) is not yet valid voice. The live
 * failure ended literally `**Supportive/` — unclosed bold, mid-heading slash. Length is
 * not a quality signal; truncation structure is.
 */
export function isTruncatedVoiceDocument(content: string): boolean {
	const trimmed = content.trim();
	if (!trimmed) return false;
	const boldMarkers = trimmed.match(/\*\*/g);
	if (boldMarkers && boldMarkers.length % 2 !== 0) return true;
	if (/[A-Za-z0-9]\/\s*$/.test(trimmed)) return true;
	const lastLine = trimmed.split(/\r?\n/).pop()!.trim();
	if (/^\*\*[^*]*$/.test(lastLine)) return true;
	// Bare list marker with no item text — cut mid-bullet.
	if (/^[-*]\s*$/.test(lastLine)) return true;
	return false;
}
