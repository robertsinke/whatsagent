/**
 * FRONTEND ONLY — spawns coding-agent CLIs to measure their tool surface.
 *
 * An agent that could trigger this would spend the owner's subscription and
 * could use the decoy path as a confused-deputy probe against the host. The
 * measurement exists so the owner can re-check isolation after a harness
 * version bump; it is not a tool the panel should wield.
 *
 * Tier 2 (`deep: true`) is a separate explicit input and never the default —
 * it costs a real model call. See `server/providers/harness-isolation.ts`.
 */
import {
	HARNESS_ISOLATION_SETTING,
	mergeIsolationReport,
	parseIsolationStore,
	verifyHarnessIsolation,
	type IsolationHarness,
	type IsolationSurface,
	type VerifyHarnessOptions
} from '../providers/harness-isolation.js';
import type { SpawnProcess } from '../providers/provider.js';
import { getSetting, setSetting } from '../store/settings.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type VerifyHarnessIsolationInput = {
	harness: IsolationHarness;
	surface: IsolationSurface;
	/** Tier 2 decoy. Must be explicitly true — omitted/false stays Tier 1. */
	deep: boolean;
};

const HARNESSES: ReadonlySet<string> = new Set(['claude', 'codex']);
const SURFACES: ReadonlySet<string> = new Set(['drafting', 'panel']);

export type VerifyHarnessIsolationDeps = {
	spawn?: SpawnProcess;
	verify?: (options: VerifyHarnessOptions) => Promise<
		Awaited<ReturnType<typeof verifyHarnessIsolation>>
	>;
};

export function createVerifyHarnessIsolationAction(
	defaults: VerifyHarnessIsolationDeps = {}
): ActionDefinition<VerifyHarnessIsolationInput> {
	return {
		name: 'verify-harness-isolation',
		callers: ['frontend'],
		jsonSchema: {
			type: 'object',
			properties: {
				harness: {
					type: 'string',
					enum: ['claude', 'codex'],
					description: 'Which drafting/panel harness to measure (codex = OpenCode binary).'
				},
				surface: {
					type: 'string',
					enum: ['drafting', 'panel'],
					description:
						'Drafting expects an empty tool surface; panel expects only our MCP tools.'
				},
				deep: {
					type: 'boolean',
					description:
						'When true, run Tier 2 (decoy + positive control). Costs a model call. Default false.'
				}
			},
			required: ['harness'],
			additionalProperties: false
		},
		parse(raw: unknown) {
			if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
				return parseError(400, 'Body must be an object');
			}
			const body = raw as {
				harness?: unknown;
				surface?: unknown;
				deep?: unknown;
			};
			if (typeof body.harness !== 'string' || !HARNESSES.has(body.harness)) {
				return parseError(400, 'harness must be claude or codex', { harness: body.harness });
			}
			let surface: IsolationSurface = 'drafting';
			if (body.surface !== undefined) {
				if (typeof body.surface !== 'string' || !SURFACES.has(body.surface)) {
					return parseError(400, 'surface must be drafting or panel', {
						surface: body.surface
					});
				}
				surface = body.surface as IsolationSurface;
			}
			// Tier 2 only when the client sends the exact boolean true.
			if (body.deep !== undefined && typeof body.deep !== 'boolean') {
				return parseError(400, 'deep must be a boolean when provided');
			}
			const deep = body.deep === true;
			return {
				ok: true,
				input: { harness: body.harness as IsolationHarness, surface, deep }
			};
		},
		async run(input, ctx) {
			const spawn = ctx.deps.verifyHarnessSpawn ?? defaults.spawn;
			const verify = defaults.verify ?? verifyHarnessIsolation;
			const panelPort = ctx.deps.port;
			const panelToken = ctx.deps.mcp?.token ?? 'isolation-probe';

			let report;
			try {
				report = await verify({
					harness: input.harness,
					surface: input.surface,
					deep: input.deep,
					panelPort,
					panelToken,
					...(spawn ? { spawn } : {})
				});
			} catch (err) {
				return actionError(500, err instanceof Error ? err.message : String(err));
			}

			const previous = parseIsolationStore(getSetting(ctx.deps.db, HARNESS_ISOLATION_SETTING));
			const next = mergeIsolationReport(previous, report);
			setSetting(ctx.deps.db, HARNESS_ISOLATION_SETTING, JSON.stringify(next));

			return actionJson(200, { report, store: next });
		}
	};
}

export const verifyHarnessIsolationAction = createVerifyHarnessIsolationAction();
