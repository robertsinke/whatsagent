/**
 * Stub `ProviderDiscovery` implementations for the UI preview harness.
 *
 * WHY THIS EXISTS
 *
 * The harness uses `createDefaultProviderDiscovery()`, which probes the real
 * machine — and this machine has all three CLIs installed. So the two provider
 * states that decide the first-run experience were both unreachable:
 *
 * - **zero providers detected**, the case OSS-P3.4 exists for (name all three,
 *   link their installers, and still let the user reach pairing)
 * - **Ollama present but its daemon dead**, which must read "installed but not
 *   running" and never as an install prompt
 *
 * `providerDiscovery` is an injectable `CreateAppOptions` field, the same seam
 * as `channel`, so no production code changes to reach either.
 *
 * The honesty constraints these fixtures encode, both from the real discovery
 * layer:
 *
 * - Ollama `installed: true` means the **daemon answered**. A present binary
 *   with a dead daemon is `installed: false`, `unavailableReason:
 *   'not_running'`, and still carries a `path`.
 * - `auth` is **always `unknown`**. A successful `--version` proves the binary
 *   exists, not that a subscription login works.
 */
import type {
	DiscoveredProvider,
	ProviderDiscovery,
	ProviderDiscoverySnapshot
} from '../server/providers/discovery.js';

export type PreviewProvidersMode = 'real' | 'all' | 'none' | 'ollama-down' | 'mismatch';

export const PREVIEW_PROVIDERS_MODES: readonly PreviewProvidersMode[] = [
	'real',
	'all',
	'none',
	'ollama-down',
	'mismatch'
];

export function isPreviewProvidersMode(
	value: string | undefined
): value is PreviewProvidersMode {
	return value !== undefined && (PREVIEW_PROVIDERS_MODES as readonly string[]).includes(value);
}

const SEARCH_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function base(
	name: DiscoveredProvider['name'],
	label: string,
	kind: DiscoveredProvider['kind'],
	probedAt: number
): DiscoveredProvider {
	return {
		name,
		label,
		kind,
		installed: false,
		path: null,
		pathSource: null,
		version: null,
		// Never `logged_in`: a version probe cannot prove a subscription login.
		auth: 'unknown',
		unavailableReason: 'not_found',
		unavailableDetail: null,
		models: [],
		modelsLive: false,
		defaultModel: null,
		allowsCustomModel: true,
		probedAt
	};
}

function installed(
	provider: DiscoveredProvider,
	path: string,
	version: string
): DiscoveredProvider {
	return {
		...provider,
		installed: true,
		path,
		pathSource: 'env-path',
		version,
		unavailableReason: null,
		unavailableDetail: null
	};
}

function previewProviders(mode: Exclude<PreviewProvidersMode, 'real'>, probedAt: number): DiscoveredProvider[] {
	const claude = base('claude', 'Claude', 'cli', probedAt);
	const codex = base('codex', 'OpenCode', 'cli', probedAt);
	const ollama = base('ollama', 'Ollama', 'http', probedAt);

	if (mode === 'none') {
		// The mandatory case: nothing on the machine. Every provider carries a
		// path of null and `not_found`, exactly as a bare container would report.
		return [claude, codex, ollama];
	}

	const claudeOk = installed(claude, '/opt/homebrew/bin/claude', '2.1.220');
	const codexOk = installed(codex, '/Users/owner/.opencode/bin/opencode', '1.18.9');

	if (mode === 'mismatch') {
		// ONB-1 — OpenCode reports a version other than the pin so the
		// "verified against X, you have Y" notice is reachable in preview.
		return [
			claudeOk,
			installed(codex, '/Users/owner/.opencode/bin/opencode', '1.18.10'),
			{
				...installed(ollama, '/opt/homebrew/bin/ollama', '0.32.4'),
				models: [
					{ value: 'llama3.2:3b', label: 'llama3.2:3b', note: '2.0 GB', source: 'live' }
				],
				modelsLive: true,
				defaultModel: 'llama3.2:3b'
			}
		];
	}

	if (mode === 'ollama-down') {
		return [
			claudeOk,
			codexOk,
			{
				// Binary found, daemon silent. Keeps its path and version: telling
				// this user to "install Ollama" would be wrong.
				...ollama,
				installed: false,
				path: '/opt/homebrew/bin/ollama',
				pathSource: 'env-path',
				version: '0.32.4',
				unavailableReason: 'not_running',
				unavailableDetail: 'connect ECONNREFUSED 127.0.0.1:11434'
			}
		];
	}

	return [
		claudeOk,
		codexOk,
		{
			...installed(ollama, '/opt/homebrew/bin/ollama', '0.32.4'),
			models: [
				{ value: 'llama3.2:3b', label: 'llama3.2:3b', note: '2.0 GB', source: 'live' },
				{ value: 'qwen3:8b', label: 'qwen3:8b', note: '5.2 GB', source: 'live' }
			],
			modelsLive: true,
			defaultModel: 'llama3.2:3b'
		}
	];
}

export function createPreviewProviderDiscovery(
	mode: Exclude<PreviewProvidersMode, 'real'>,
	now: () => number = Date.now
): ProviderDiscovery {
	return {
		async snapshot(): Promise<ProviderDiscoverySnapshot> {
			const probedAt = now();
			return {
				providers: previewProviders(mode, probedAt),
				searchPath: SEARCH_PATH,
				probedAt
			};
		},
		invalidate() {
			// Stateless — every snapshot is freshly built.
		}
	};
}
