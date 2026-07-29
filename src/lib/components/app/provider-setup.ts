/**
 * First-run provider setup: turns a `GET /api/providers` snapshot into one row
 * per harness, with an install link for whatever is missing.
 *
 * Two honesty constraints are load-bearing here, and both are easy to get wrong
 * in copy:
 *
 * 1. **Ollama `installed: true` means the daemon answered.** A present binary
 *    with a dead daemon arrives as `installed: false`, `unavailableReason:
 *    'not_running'`, and still carries a `path`. That row says *installed but
 *    not running* with a start hint — never "install Ollama", which the user
 *    already did.
 * 2. **`auth` is always `unknown`.** A successful `--version` proves the binary
 *    exists, not that a subscription login works. So `info.auth` is deliberately
 *    never read in this module: there is no state of it that could justify a
 *    checkmark, and the disclaimer below is shown instead.
 */
import type { ProviderInfo, ProvidersResponse } from '$lib/client/types.js';
import type { DraftProviderName } from '../../../../shared/provider-types.js';
import { DRAFT_PROVIDER_NAMES } from '../../../../shared/providers.js';

export const AUTH_DISCLAIMER =
	'Detection only means the command was found and answered. It cannot tell whether your subscription login still works — you find that out on the first draft.';

export type ProviderSetupStatus = 'detected' | 'not_running' | 'missing';

export type ProviderSetupRow = {
	name: DraftProviderName;
	/** Product name, not the binary — this screen is read by non-developers. */
	title: string;
	status: ProviderSetupStatus;
	statusLabel: string;
	/** Where the binary is, when we know. Never a claim about login state. */
	path: string | null;
	/** What to do next: a start hint, or nothing when it is already working. */
	hint: string | null;
	installUrl: string;
	installLabel: string;
	/**
	 * Only for a genuinely absent binary. A dead daemon must not be offered an
	 * installer — that is the "install what you already have" mistake, in link
	 * form.
	 */
	showInstallLink: boolean;
};

type Descriptor = {
	title: string;
	installUrl: string;
	installLabel: string;
	/** Shown when the binary is present but not answering. */
	startHint: string;
};

const DESCRIPTORS: Record<DraftProviderName, Descriptor> = {
	claude: {
		title: 'Claude Code',
		installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
		installLabel: 'Install Claude Code',
		startHint: 'Run `claude` once in a terminal to finish signing in.'
	},
	codex: {
		title: 'OpenCode',
		installUrl: 'https://opencode.ai',
		installLabel: 'Install OpenCode',
		startHint: 'Run `opencode` once in a terminal and sign in with your ChatGPT / OpenAI account.'
	},
	ollama: {
		title: 'Ollama',
		installUrl: 'https://ollama.com',
		installLabel: 'Install Ollama',
		startHint: 'Start it with `ollama serve`, then re-scan.'
	}
};

function rowFor(name: DraftProviderName, info: ProviderInfo | undefined): ProviderSetupRow {
	const descriptor = DESCRIPTORS[name];
	const shell = {
		name,
		title: descriptor.title,
		installUrl: descriptor.installUrl,
		installLabel: descriptor.installLabel
	};

	if (!info) {
		// Discovery failed outright. Not the same as "not installed", and saying so
		// keeps the user from installing something they already have.
		return {
			...shell,
			status: 'missing',
			statusLabel: 'Not detected — the scan did not report on this one',
			path: null,
			hint: 'Re-scan, or pick it anyway and set the path in Settings.',
			showInstallLink: true
		};
	}

	if (info.installed) {
		return {
			...shell,
			status: 'detected',
			statusLabel: info.version ? `Detected — v${info.version}` : 'Detected',
			path: info.path,
			hint: null,
			showInstallLink: false
		};
	}

	if (info.unavailableReason === 'not_running') {
		return {
			...shell,
			status: 'not_running',
			statusLabel: info.version
				? `Installed but not running — v${info.version}`
				: 'Installed but not running',
			path: info.path,
			hint: descriptor.startHint,
			showInstallLink: false
		};
	}

	if (info.unavailableReason === 'probe_failed') {
		return {
			...shell,
			status: 'not_running',
			statusLabel: 'Found, but it did not answer',
			path: info.path,
			hint: info.unavailableDetail ?? descriptor.startHint,
			showInstallLink: false
		};
	}

	return {
		...shell,
		status: 'missing',
		statusLabel: 'Not installed',
		path: null,
		hint: null,
		showInstallLink: true
	};
}

export function providerSetupRows(snapshot: ProvidersResponse | null): ProviderSetupRow[] {
	const byName = new Map((snapshot?.providers ?? []).map((p) => [p.name, p] as const));
	return DRAFT_PROVIDER_NAMES.map((name) => rowFor(name, byName.get(name)));
}

/** True when at least one harness could actually produce a draft right now. */
export function anyProviderUsable(snapshot: ProvidersResponse | null): boolean {
	return (snapshot?.providers ?? []).some((p) => p.installed && p.unavailableReason === null);
}

/**
 * The headline for the setup step. The zero-detected case is the one this
 * screen exists for, so it gets an explicit, non-apologetic sentence: the app
 * works, drafting is simply off until a harness shows up.
 */
export function setupSummary(snapshot: ProvidersResponse | null): string {
	if (!snapshot) return 'Looking for drafting tools on this machine…';
	const rows = providerSetupRows(snapshot);
	const detected = rows.filter((r) => r.status === 'detected');
	if (detected.length === 0) {
		return 'No drafting tool found. You can still link WhatsApp and use the app — drafting stays off until you install one of these.';
	}
	if (detected.length === rows.length) return 'All three drafting tools found.';
	return `${detected.length} of ${rows.length} drafting tools found.`;
}
