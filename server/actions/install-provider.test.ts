import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessInstallPlan } from '../../shared/harness-install.js';
import { VERIFIED_HARNESS_VERSIONS } from '../../shared/harness-versions.js';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';
import { fakeSpawn } from '../providers/fake-spawn.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import {
	createInstallProviderAction,
	runPinnedProviderInstall
} from './install-provider.js';
import { actionRegistry, dispatch } from './index.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function makeDeps(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	dataDir = mkdtempSync(join(tmpdir(), 'wa-install-'));
	db = openDatabase({ dataDir });
	return {
		db,
		events: new EventBus(),
		getConnectionStatus: () => ({ state: 'connected', qr: null }),
		port: 0,
		dataDir,
		...overrides
	};
}

afterEach(() => {
	db?.close();
	db = undefined;
	if (dataDir) {
		rmSync(dataDir, { recursive: true, force: true });
		dataDir = undefined;
	}
});

describe('runPinnedProviderInstall', () => {
	it('runs a command that contains the pinned version', async () => {
		const { spawn, calls } = fakeSpawn([{ stdout: 'ok\n', exitCode: 0 }]);
		const plan = harnessInstallPlan('codex');
		expect(plan.kind).toBe('shell');
		const result = await runPinnedProviderInstall('codex', {
			spawn,
			probeVersion: async () => '1.18.9'
		});
		expect(result.command).toContain(`--version ${VERIFIED_HARNESS_VERSIONS.codex}`);
		if (plan.kind === 'shell') expect(result.command).toBe(plan.command);
		expect(calls[0]?.command).toBe('/bin/bash');
		expect(calls[0]?.args[1]).toContain(VERIFIED_HARNESS_VERSIONS.codex);
		expect(result.ok).toBe(true);
		expect(result.installedVersion).toBe('1.18.9');
	});

	it('surfaces a non-zero installer exit as a failure', async () => {
		const { spawn } = fakeSpawn([{ stdout: 'boom\n', stderr: 'nope\n', exitCode: 1 }]);
		const result = await runPinnedProviderInstall('claude', { spawn });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain('boom');
		expect(result.installedVersion).toBeNull();
	});
});

describe('install-provider action', () => {
	it('refuses a tool caller with 403 before run', async () => {
		const deps = makeDeps();
		const { spawn, calls } = fakeSpawn([{ exitCode: 0 }]);
		deps.installProviderSpawn = spawn;
		const result = await dispatch(
			actionRegistry,
			'install-provider',
			{ provider: 'claude' },
			{ caller: 'tool', deps }
		);
		expect(result).toMatchObject({
			kind: 'error',
			status: 403,
			error: 'Caller not permitted'
		});
		expect(calls).toHaveLength(0);
	});

	it('is on the standing frontend-only refusal list for tool callers', () => {
		const toolNames = [...actionRegistry.values()]
			.filter((a) => a.callers.includes('tool'))
			.map((a) => a.name);
		expect(toolNames).not.toContain('install-provider');
		expect(actionRegistry.get('install-provider')?.callers).toEqual(['frontend']);
	});

	it('accepts a frontend caller and returns installer output', async () => {
		const deps = makeDeps({
			providerDiscovery: {
				async snapshot() {
					return {
						providers: [
							{
								name: 'claude',
								label: 'Claude',
								kind: 'cli',
								installed: true,
								path: '/bin/claude',
								pathSource: 'env-path',
								version: '2.1.220',
								auth: 'unknown',
								unavailableReason: null,
								unavailableDetail: null,
								models: [],
								modelsLive: false,
								defaultModel: null,
								allowsCustomModel: true,
								probedAt: 1
							}
						],
						searchPath: [],
						probedAt: 1
					};
				},
				invalidate() {}
			}
		});
		const { spawn } = fakeSpawn([{ stdout: 'Installed!\n', exitCode: 0 }]);
		deps.installProviderSpawn = spawn;
		const result = await dispatch(
			actionRegistry,
			'install-provider',
			{ provider: 'claude' },
			{ caller: 'frontend', deps }
		);
		expect(result.kind).toBe('json');
		if (result.kind !== 'json') return;
		expect(result.body).toMatchObject({
			ok: true,
			provider: 'claude',
			pinnedVersion: VERIFIED_HARNESS_VERSIONS.claude,
			installedVersion: '2.1.220'
		});
	});

	it('rejects ollama (no pinned shell install)', async () => {
		const action = createInstallProviderAction();
		const parsed = action.parse({ provider: 'ollama' });
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.status).toBe(400);
	});
});
