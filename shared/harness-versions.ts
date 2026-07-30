/**
 * Versions this app has verified its tool-surface configs against.
 *
 * Kept as data (not comments) so onboarding can pin an install command and
 * surface a mismatch notice when discovery reports a different version.
 * Drift is information, not a hard refuse — an unverified version may still
 * draft; the risk is the tool-surface guarantees, not breakage.
 *
 * Keys match draft-provider names (`codex` = OpenCode binary).
 */
import type { DraftProviderName } from './provider-types.js';

export const VERIFIED_HARNESS_VERSIONS: Readonly<Record<DraftProviderName, string>> = {
	claude: '2.1.220',
	/** OpenCode — settings key remains `codex`. */
	codex: '1.18.9',
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
