import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';
import {
	HARNESS_ISOLATION_SETTING,
	type HarnessIsolationReport
} from '../providers/harness-isolation.js';
import { openDatabase, type AppDatabase } from '../store/db.js';
import { getSetting } from '../store/settings.js';
import { createVerifyHarnessIsolationAction } from './verify-harness-isolation.js';
import { actionRegistry, dispatch, type ActionRegistry } from './index.js';
import type { ActionDefinition } from './types.js';

let dataDir: string | undefined;
let db: AppDatabase | undefined;

function makeDeps(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	dataDir = mkdtempSync(join(tmpdir(), 'wa-iso-'));
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

function passReport(overrides: Partial<HarnessIsolationReport> = {}): HarnessIsolationReport {
	return {
		harness: 'claude',
		binary: 'claude',
		surface: 'drafting',
		tier: 1,
		tier1Strength: 'realized-surface',
		pinnedVersion: '2.1.220',
		detectedVersion: '2.1.220',
		verdict: 'pass',
		summary: 'Claude Code: nothing extra is reachable while drafting.',
		checkedAt: 1,
		findings: [],
		...overrides
	};
}

function registryWith(
	action: ReturnType<typeof createVerifyHarnessIsolationAction>
): ActionRegistry {
	const registry = new Map(actionRegistry);
	registry.set(action.name, action as ActionDefinition<unknown>);
	return registry;
}

describe('verify-harness-isolation action', () => {
	it('refuses a tool caller with 403 before run', async () => {
		const deps = makeDeps();
		const verify = vi.fn(async () => passReport());
		const registry = registryWith(createVerifyHarnessIsolationAction({ verify }));

		const result = await dispatch(
			registry,
			'verify-harness-isolation',
			{ harness: 'claude' },
			{ caller: 'tool', deps }
		);
		expect(result).toMatchObject({ kind: 'error', status: 403 });
		expect(verify).not.toHaveBeenCalled();
	});

	it('defaults to Tier 1 and does not pass deep unless explicitly true', async () => {
		const deps = makeDeps();
		const verify = vi.fn(async (opts) =>
			passReport({ harness: opts.harness, surface: opts.surface, tier: opts.deep ? 2 : 1 })
		);
		const registry = registryWith(createVerifyHarnessIsolationAction({ verify }));

		const omitted = await dispatch(
			registry,
			'verify-harness-isolation',
			{ harness: 'codex' },
			{ caller: 'frontend', deps }
		);
		expect(omitted).toMatchObject({ kind: 'json', status: 200 });
		expect(verify).toHaveBeenCalledWith(expect.objectContaining({ deep: false, harness: 'codex' }));

		const explicitFalse = await dispatch(
			registry,
			'verify-harness-isolation',
			{ harness: 'codex', deep: false },
			{ caller: 'frontend', deps }
		);
		expect(explicitFalse).toMatchObject({ kind: 'json', status: 200 });
		expect(verify).toHaveBeenLastCalledWith(expect.objectContaining({ deep: false }));

		const deep = await dispatch(
			registry,
			'verify-harness-isolation',
			{ harness: 'codex', deep: true, surface: 'panel' },
			{ caller: 'frontend', deps }
		);
		expect(deep).toMatchObject({ kind: 'json', status: 200 });
		expect(verify).toHaveBeenLastCalledWith(
			expect.objectContaining({ deep: true, surface: 'panel' })
		);
	});

	it('persists the report into the harness_isolation setting', async () => {
		const deps = makeDeps();
		const verify = vi.fn(async () => passReport({ checkedAt: 42 }));
		const registry = registryWith(createVerifyHarnessIsolationAction({ verify }));

		await dispatch(
			registry,
			'verify-harness-isolation',
			{ harness: 'claude', surface: 'drafting' },
			{ caller: 'frontend', deps }
		);

		const raw = getSetting(deps.db, HARNESS_ISOLATION_SETTING);
		expect(raw).toBeTruthy();
		const store = JSON.parse(raw!) as { claude: { drafting: HarnessIsolationReport } };
		expect(store.claude.drafting.verdict).toBe('pass');
		expect(store.claude.drafting.checkedAt).toBe(42);
	});

	it('parse rejects a non-boolean deep', async () => {
		const deps = makeDeps();
		const result = await dispatch(
			actionRegistry,
			'verify-harness-isolation',
			{ harness: 'claude', deep: 'yes' },
			{ caller: 'frontend', deps }
		);
		expect(result).toMatchObject({ kind: 'error', status: 400 });
	});

	it('is frontend-only on the standing registry', () => {
		expect(actionRegistry.get('verify-harness-isolation')?.callers).toEqual(['frontend']);
	});
});
