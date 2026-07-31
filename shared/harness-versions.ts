/**
 * Versions this app has verified its tool-surface configs against.
 *
 * Kept as data (not comments) so onboarding can pin an install command and
 * surface a mismatch notice when discovery reports a different version.
 * Drift is information, not a hard refuse — an unverified version may still
 * draft; the risk is the tool-surface guarantees, not breakage.
 *
 * Keys match draft-provider names (`codex` = OpenCode binary).
 *
 * BUMPING A VALUE HERE IS A CLAIM ABOUT MEASURED BEHAVIOUR, NOT A VERSION
 * NUMBER. Editing it without re-measuring turns this file back into the stale
 * comment it replaced. The evidence for a bump is a Tier-2 run per surface —
 * Tier 1 for OpenCode proves resolved config only:
 *
 *   npm run verify:harness -- --harness codex --deep
 *   npm run verify:harness -- --harness codex --surface panel --deep
 *
 * A Tier-2 `pass` means the positive control retrieved the decoy marker and the
 * subject did not; `inconclusive` means the control failed and the subject's
 * silence proves nothing. Only `pass` justifies a bump.
 *
 * Measured 2026-07-31 on opencode 1.18.10: drafting `pass`, panel `pass`.
 */
import type { DraftProviderName } from './provider-types.js';

export const VERIFIED_HARNESS_VERSIONS: Readonly<Record<DraftProviderName, string>> = {
	claude: '2.1.220',
	/** OpenCode — settings key remains `codex`. Tier-2 verified 2026-07-31. */
	codex: '1.18.10',
	ollama: '0.32.4'
};

export function verifiedVersion(name: DraftProviderName): string {
	return VERIFIED_HARNESS_VERSIONS[name];
}

/**
 * True when discovery reported a version and it differs from the pin.
 * Missing / unknown detected versions are not a mismatch (nothing to compare).
 */
export function versionsMismatch(
	detected: string | null | undefined,
	pinned: string
): boolean {
	if (detected == null) return false;
	const have = detected.trim();
	if (have === '') return false;
	return have !== pinned;
}

export function versionMismatchNotice(pinned: string, detected: string): string {
	return `Verified against ${pinned}, you have ${detected}.`;
}
