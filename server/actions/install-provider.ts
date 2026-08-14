/**
 * FRONTEND ONLY — installing software is a different threat model than any
 * drafting or panel tool this registry currently permits.
 *
 * Runs the vendor's own pinned installer after the UI has shown the exact
 * command. Never trusts a client-supplied shell line; rebuilds from the pin.
 * Does not use sudo and does not silently rewrite the owner's shell profile
 * beyond what the vendor installer already does.
 */
import {
	harnessInstallPlan,
	isShellInstallable,
	type ShellInstallableProvider
} from '../../shared/harness-install.js';
import { VERIFIED_HARNESS_VERSIONS } from '../../shared/harness-versions.js';
import { isDraftProviderName } from '../../shared/providers.js';
import {
	runCapturedProcess,
	sanitizedEnv,
	spawnProcess,
	type SpawnProcess
} from '../providers/provider.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type InstallProviderInput = {
	provider: ShellInstallableProvider;
};

export type InstallProviderResult = {
	ok: boolean;
	provider: ShellInstallableProvider;
	command: string;
	pinnedVersion: string;
	exitCode: number | null;
	output: string;
	/** Version reported by a fresh discovery probe after the installer exits. */
	installedVersion: string | null;
};

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export type InstallProviderDeps = {
	spawn?: SpawnProcess;
	platform?: NodeJS.Platform;
};

/**
 * Shared runner so unit tests can inject spawn without standing up RoutesDeps.
 * The action's `run` calls this with `ctx.deps` hooks when present.
 */
export async function runPinnedProviderInstall(
	provider: ShellInstallableProvider,
	options: InstallProviderDeps & {
		probeVersion?: () => Promise<string | null>;
	} = {}
): Promise<InstallProviderResult> {
	const platform = options.platform ?? process.platform;
	const plan = harnessInstallPlan(provider, platform);
	if (plan.kind !== 'shell') {
		throw new Error(`Provider ${provider} has no shell install plan`);
	}

	const spawn = options.spawn ?? spawnProcess;
	const captured = await runCapturedProcess({
		command: '/bin/bash',
		args: ['-lc', plan.command],
		env: sanitizedEnv(process.env),
		timeoutMs: INSTALL_TIMEOUT_MS,
		spawn
	});

	const output = [captured.stdout, captured.stderr].filter(Boolean).join('\n').trim();
	const exitCode = captured.code;
	const ok = exitCode === 0;
	const installedVersion = ok && options.probeVersion ? await options.probeVersion() : null;

	return {
		ok,
		provider,
		command: plan.command,
		pinnedVersion: plan.pinnedVersion,
		exitCode,
		output,
		installedVersion: installedVersion ?? null
	};
}

export function createInstallProviderAction(
	defaults: InstallProviderDeps = {}
): ActionDefinition<InstallProviderInput> {
	return {
		name: 'install-provider',
		description:
			'Install the pinned claude or codex CLI via the vendor installer. Frontend only.',
		callers: ['frontend'],
		jsonSchema: {
			type: 'object',
			properties: {
				provider: {
					type: 'string',
					enum: ['claude', 'codex'],
					description:
						'Drafting / panel harness to install from the vendor, pinned to the verified version.'
				}
			},
			required: ['provider'],
			additionalProperties: false
		},
		parse(raw: unknown) {
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				return parseError(400, 'Body must be an object');
			}
			const provider = (raw as { provider?: unknown }).provider;
			if (!isDraftProviderName(provider) || !isShellInstallable(provider)) {
				return parseError(
					400,
					'provider must be claude or codex (Ollama has no pinned shell install on macOS)',
					{ provider }
				);
			}
			return { ok: true, input: { provider } };
		},
		async run(input, ctx) {
			const spawn = ctx.deps.installProviderSpawn ?? defaults.spawn;
			const platform = defaults.platform ?? process.platform;
			const plan = harnessInstallPlan(input.provider, platform);
			if (plan.kind !== 'shell') {
				return actionError(400, 'No pinned shell installer for this provider', {
					provider: input.provider,
					reason: plan.kind === 'link' ? plan.reason : undefined
				});
			}

			const probeVersion = async (): Promise<string | null> => {
				const discovery = ctx.deps.providerDiscovery;
				if (!discovery) return null;
				const snapshot = await discovery.snapshot({ refresh: true });
				return snapshot.providers.find((p) => p.name === input.provider)?.version ?? null;
			};

			const result = await runPinnedProviderInstall(input.provider, {
				...(spawn ? { spawn } : {}),
				platform,
				probeVersion
			});

			if (!result.ok) {
				return actionJson(200, {
					...result,
					error: `Installer exited with code ${result.exitCode ?? 'null'}`
				});
			}

			return actionJson(200, result);
		}
	};
}

/** Default registry entry — production spawn, injectable via RoutesDeps. */
export const installProviderAction = createInstallProviderAction();

/** Re-export so tests can assert the pin without importing shared twice. */
export { VERIFIED_HARNESS_VERSIONS };
