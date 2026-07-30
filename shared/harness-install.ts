/**
 * Vendor install commands for drafting / panel harnesses.
 *
 * Pure and dependency-free so the first-run UI can show the exact command
 * before anything runs, and the server action can rebuild the same string
 * (never trusting a client-supplied shell line).
 *
 * Safety posture: the app must never silently pipe a remote script into a
 * shell. The UI shows this command first; install is an explicit click.
 */
import type { DraftProviderName } from './provider-types.js';
import { VERIFIED_HARNESS_VERSIONS } from './harness-versions.js';

/** Providers whose official installer supports a pinned version via shell. */
export type ShellInstallableProvider = 'claude' | 'codex';

export type HarnessInstallPlan =
	| {
			kind: 'shell';
			provider: ShellInstallableProvider;
			/** Exact shell line the owner sees and that the action runs. */
			command: string;
			pinnedVersion: string;
	  }
	| {
			kind: 'link';
			provider: DraftProviderName;
			url: string;
			/** Why guided shell install is not offered. */
			reason: string;
	  };

const DOCS: Record<DraftProviderName, string> = {
	claude: 'https://docs.anthropic.com/en/docs/claude-code',
	codex: 'https://opencode.ai',
	ollama: 'https://ollama.com'
};

/**
 * Claude Code native installer — version as the script's first arg.
 * @see https://code.claude.com/docs/en/install
 */
export function claudeInstallCommand(version: string = VERIFIED_HARNESS_VERSIONS.claude): string {
	return `curl -fsSL https://claude.ai/install.sh | bash -s -- ${version}`;
}

/**
 * OpenCode official installer — `--version` (also honours `VERSION` env).
 * @see https://opencode.ai
 */
export function opencodeInstallCommand(version: string = VERIFIED_HARNESS_VERSIONS.codex): string {
	return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${version}`;
}

export function isShellInstallable(name: DraftProviderName): name is ShellInstallableProvider {
	return name === 'claude' || name === 'codex';
}

/**
 * Build the install plan for a provider on this platform.
 * Ollama's `install.sh` is Linux-only and uses sudo; on macOS (this app's only
 * supported platform) the official path is the .app from ollama.com.
 */
export function harnessInstallPlan(
	name: DraftProviderName,
	platform: NodeJS.Platform = 'darwin'
): HarnessInstallPlan {
	if (name === 'claude') {
		const pinnedVersion = VERIFIED_HARNESS_VERSIONS.claude;
		return {
			kind: 'shell',
			provider: 'claude',
			command: claudeInstallCommand(pinnedVersion),
			pinnedVersion
		};
	}
	if (name === 'codex') {
		const pinnedVersion = VERIFIED_HARNESS_VERSIONS.codex;
		return {
			kind: 'shell',
			provider: 'codex',
			command: opencodeInstallCommand(pinnedVersion),
			pinnedVersion
		};
	}
	// ollama
	if (platform === 'linux') {
		// Documented, but this app does not run on Linux today — keep the link
		// path so a future port does not silently invent a sudo install.
		return {
			kind: 'link',
			provider: 'ollama',
			url: DOCS.ollama,
			reason:
				'Ollama’s shell installer needs sudo and is Linux-oriented; open ollama.com and install from the vendor.'
		};
	}
	return {
		kind: 'link',
		provider: 'ollama',
		url: DOCS.ollama,
		reason:
			'On macOS Ollama installs from the official app at ollama.com — there is no pinned shell installer (the curl script is Linux-only and uses sudo).'
	};
}

export function docsInstallUrl(name: DraftProviderName): string {
	return DOCS[name];
}
