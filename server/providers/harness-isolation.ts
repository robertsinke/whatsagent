/**
 * Runtime verification of the drafting / panel harness tool surfaces.
 *
 * WHY THIS EXISTS. Isolation flags are a claim; the resolved tool list on the
 * machine that runs this app is the evidence. A green test suite cannot see it
 * (it differs per developer config). This module re-runs the same measurement
 * the 2026-07-30 findings used — see
 * `docs/solutions/2026-07-30-proving-a-spawned-harness-tool-surface.md` — so a
 * pin bump in `shared/harness-versions.ts` can be an evidenced act.
 *
 * ASYMMETRY (load-bearing — do not paper over). The two harnesses are not
 * symmetric at Tier 1:
 *
 *   Claude  — stream-json init event carries the *realized* tool list and
 *             mcp_servers. Tier 1 is already the surface the model sees.
 *   OpenCode — `opencode debug config` prints the *resolved* configuration.
 *             That is what opencode decided to load, not what it hands the
 *             model. A version that changes how config maps onto tools is
 *             exactly the drift being defended against, and Tier 1 alone
 *             cannot catch it. Tier 2 (decoy + positive control) is the
 *             behavioral proof for OpenCode; treat a Tier-1 OpenCode pass as
 *             weaker than a Claude one.
 *
 * SAFETY. Never opens the live WhatsApp database. Config and decoy files go
 * under throwaway temp dirs. Tier 2 is owner-triggered only — it spends a
 * subscription turn.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { VERIFIED_HARNESS_VERSIONS } from '../../shared/harness-versions.js';
import { MCP_SERVER_NAME } from '../agent/panel/harness.js';
import { buildPanelClaudeMcpConfig } from '../agent/panel/claude-harness.js';
import { buildPanelOpenCodeConfig } from '../agent/panel/opencode-harness.js';
import { CLAUDE_DRAFT_ISOLATION_FLAGS } from './claude.js';
import {
	OPENCODE_BUILTIN_TOOLS_OFF,
	type OpenCodeGlobalsOptions
} from './opencode-config.js';
import { buildOpenCodeEmptyToolsConfig } from './opencode.js';
import {
	PROVIDER_SECRET_ENV_KEYS,
	sanitizedEnv,
	type SpawnProcess
} from './provider.js';
import { parseVersionLine } from './discovery.js';

/** Settings key holding the last verification blob (JSON). Free-form key. */
export const HARNESS_ISOLATION_SETTING = 'harness_isolation';

export type IsolationHarness = 'claude' | 'codex';
export type IsolationSurface = 'drafting' | 'panel';
export type IsolationTier = 1 | 2;
export type IsolationVerdict = 'pass' | 'fail' | 'inconclusive' | 'unavailable';

export type IsolationFinding = {
	code: string;
	detail: string;
};

export type HarnessIsolationReport = {
	harness: IsolationHarness;
	/** Binary name the owner sees (`opencode` for the `codex` settings key). */
	binary: string;
	surface: IsolationSurface;
	tier: IsolationTier;
	/**
	 * OpenCode Tier 1 proves *resolved config*, not the tools handed to the
	 * model. Claude Tier 1 proves the realized surface. See file header.
	 */
	tier1Strength: 'realized-surface' | 'resolved-config-only';
	pinnedVersion: string;
	detectedVersion: string | null;
	verdict: IsolationVerdict;
	/** Plain language for the Settings panel — not a tool count. */
	summary: string;
	checkedAt: number;
	findings: IsolationFinding[];
};

export type HarnessIsolationStore = Partial<
	Record<IsolationHarness, Partial<Record<IsolationSurface, HarnessIsolationReport>>>
>;

/** Argv prefix for every OpenCode drafting / panel `run` spawn (before --dir / -m / prompt). */
export const OPENCODE_RUN_ISOLATION_FLAGS = ['run', '--auto', '--pure', '--format', 'json'] as const;

/** Tier-1 OpenCode probe — not a model call. */
export const OPENCODE_TIER1_ARGS = ['debug', 'config', '--pure'] as const;

export function harnessBinary(harness: IsolationHarness): string {
	return harness === 'codex' ? 'opencode' : 'claude';
}

export function pinnedVersionFor(harness: IsolationHarness): string {
	return VERIFIED_HARNESS_VERSIONS[harness];
}

/**
 * Drafting Claude argv that carries the isolation flags. Asserted against
 * {@link CLAUDE_DRAFT_ISOLATION_FLAGS} — never a parallel copy of the flag set.
 */
export function claudeDraftIsolationArgv(options: {
	systemPrompt?: string;
} = {}): string[] {
	const args = [
		'-p',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		...CLAUDE_DRAFT_ISOLATION_FLAGS,
		'', // --tools value
		'--system-prompt',
		options.systemPrompt ?? 'Reply with the single word OK.'
	];
	return args;
}

/**
 * Panel Claude argv (isolation-relevant slice). Mirrors
 * `ClaudePanelHarness` — empty built-ins, strict MCP config file only.
 */
export function claudePanelIsolationArgv(mcpConfigPath: string): string[] {
	return [
		'-p',
		'--output-format',
		'stream-json',
		'--verbose',
		'--tools',
		'',
		'--strict-mcp-config',
		'--mcp-config',
		mcpConfigPath,
		'--no-session-persistence'
	];
}

/** Config the drafting OpenCode spawn writes — same builder the provider uses. */
export function draftingOpenCodeConfig(options?: OpenCodeGlobalsOptions): Record<string, unknown> {
	return buildOpenCodeEmptyToolsConfig(options);
}

/** Config the panel OpenCode spawn writes — inverse of drafting by design. */
export function panelOpenCodeConfig(options: {
	port: number;
	env?: NodeJS.ProcessEnv;
	home?: string;
	readFile?: (path: string) => string;
}): Record<string, unknown> {
	return buildPanelOpenCodeConfig(options);
}

export type OpenCodeResolvedConfig = {
	tools?: Record<string, unknown> | null;
	mcp?: Record<string, unknown> | null;
	permission?: Record<string, unknown> | null;
};

/**
 * Tier-1 OpenCode expectation evaluator. Pure — tests feed fixtures; the
 * runtime probe feeds `opencode debug config` JSON.
 *
 * Drafting and panel are INVERSES: do not share one expectation.
 */
export function evaluateOpenCodeResolvedConfig(
	config: OpenCodeResolvedConfig,
	surface: IsolationSurface
): { ok: boolean; findings: IsolationFinding[] } {
	const findings: IsolationFinding[] = [];
	const tools = config.tools ?? {};
	for (const [key, expected] of Object.entries(OPENCODE_BUILTIN_TOOLS_OFF)) {
		const actual = (tools as Record<string, unknown>)[key];
		if (actual !== expected) {
			findings.push({
				code: 'builtin_enabled',
				detail: `Builtin tool ${key} resolved to ${JSON.stringify(actual)}, expected ${expected}`
			});
		}
	}

	const mcp = config.mcp ?? {};
	for (const [name, entry] of Object.entries(mcp)) {
		const enabled =
			entry && typeof entry === 'object' && !Array.isArray(entry)
				? (entry as { enabled?: unknown }).enabled
				: undefined;
		if (surface === 'drafting') {
			if (enabled !== false) {
				findings.push({
					code: 'mcp_enabled',
					detail: `Inherited MCP server ${name} is not disabled (enabled=${JSON.stringify(enabled)})`
				});
			}
		} else if (name === MCP_SERVER_NAME) {
			if (enabled !== true) {
				findings.push({
					code: 'panel_mcp_missing',
					detail: `Panel MCP server ${MCP_SERVER_NAME} must be enabled (enabled=${JSON.stringify(enabled)})`
				});
			}
		} else if (enabled !== false) {
			findings.push({
				code: 'mcp_enabled',
				detail: `Non-panel MCP server ${name} is not disabled (enabled=${JSON.stringify(enabled)})`
			});
		}
	}
	if (surface === 'panel' && !(MCP_SERVER_NAME in mcp)) {
		findings.push({
			code: 'panel_mcp_missing',
			detail: `Panel MCP server ${MCP_SERVER_NAME} is absent from resolved mcp`
		});
	}

	const permission = config.permission ?? {};
	const star = (permission as Record<string, unknown>)['*'];
	if (star !== 'deny') {
		findings.push({
			code: 'permission_default',
			detail: `permission['*'] resolved to ${JSON.stringify(star)}, expected "deny"`
		});
	}
	if (surface === 'panel') {
		const allow = (permission as Record<string, unknown>)[`${MCP_SERVER_NAME}*`];
		if (allow !== 'allow') {
			findings.push({
				code: 'panel_permission',
				detail: `permission['${MCP_SERVER_NAME}*'] resolved to ${JSON.stringify(allow)}, expected "allow"`
			});
		}
	} else {
		for (const [key, value] of Object.entries(permission)) {
			if (key === '*') continue;
			if (value !== 'deny') {
				findings.push({
					code: 'permission_allow',
					detail: `Drafting permission[${key}]=${JSON.stringify(value)}; expected deny-only`
				});
			}
		}
	}

	return { ok: findings.length === 0, findings };
}

export type ClaudeInitSurface = {
	tools?: unknown;
	mcp_servers?: unknown;
};

/**
 * Tier-1 Claude expectation. Drafting wants an empty realized surface.
 * Panel wants our MCP server present and no unexpected extras that look like
 * built-ins — inherited user MCP must stay out (`--strict-mcp-config`).
 */
export function evaluateClaudeInitEvent(
	event: ClaudeInitSurface,
	surface: IsolationSurface
): { ok: boolean; findings: IsolationFinding[] } {
	const findings: IsolationFinding[] = [];
	const tools = Array.isArray(event.tools) ? event.tools.map(String) : [];
	const mcpServers = Array.isArray(event.mcp_servers)
		? event.mcp_servers.map((s) => {
				if (typeof s === 'string') return s;
				if (s && typeof s === 'object' && 'name' in s) return String((s as { name: unknown }).name);
				return JSON.stringify(s);
			})
		: [];

	if (surface === 'drafting') {
		if (tools.length > 0) {
			findings.push({
				code: 'tools_present',
				detail: `Drafting realized ${tools.length} tool(s); expected none`
			});
		}
		if (mcpServers.length > 0) {
			findings.push({
				code: 'mcp_present',
				detail: `Drafting mcp_servers=${JSON.stringify(mcpServers)}; expected []`
			});
		}
		return { ok: findings.length === 0, findings };
	}

	// Panel: our server must be listed; built-in-looking tools must stay out.
	const hasOurs = mcpServers.some((n) => n === MCP_SERVER_NAME || n.includes(MCP_SERVER_NAME));
	if (!hasOurs && tools.every((t) => !t.includes(MCP_SERVER_NAME))) {
		findings.push({
			code: 'panel_mcp_missing',
			detail: `Panel init listed neither mcp_servers entry nor tools for ${MCP_SERVER_NAME}`
		});
	}
	const builtins = tools.filter(
		(t) =>
			!t.includes(MCP_SERVER_NAME) &&
			!t.toLowerCase().includes('advisor') // known disclosure residual — see claude-harness header
	);
	// Built-ins show up as bare names (Read, Bash, …). MCP tools are prefixed.
	const suspicious = builtins.filter((t) => !t.includes('__') && !t.includes('mcp'));
	if (suspicious.length > 0) {
		findings.push({
			code: 'builtin_present',
			detail: `Panel realized unexpected built-in-like tools: ${suspicious.join(', ')}`
		});
	}
	for (const name of mcpServers) {
		if (name !== MCP_SERVER_NAME && !name.includes(MCP_SERVER_NAME)) {
			findings.push({
				code: 'mcp_inherited',
				detail: `Panel inherited MCP server ${name}`
			});
		}
	}

	return { ok: findings.length === 0, findings };
}

function plainSummary(
	harness: IsolationHarness,
	surface: IsolationSurface,
	verdict: IsolationVerdict,
	findings: IsolationFinding[]
): string {
	const label = harness === 'codex' ? 'OpenCode' : 'Claude Code';
	const where = surface === 'drafting' ? 'drafting' : 'the agent panel';
	if (verdict === 'pass') {
		return surface === 'drafting'
			? `${label}: nothing extra is reachable while ${where}.`
			: `${label}: only our tools are reachable in ${where}; everything else is denied.`;
	}
	if (verdict === 'unavailable') {
		return `${label} did not answer — is it installed and on PATH?`;
	}
	if (verdict === 'inconclusive') {
		return `${label}: check inconclusive — the positive control did not return its marker, so a clean subject run is not evidence.`;
	}
	const first = findings[0]?.detail;
	return first
		? `${label}: isolation check failed — ${first}`
		: `${label}: isolation check failed for ${where}.`;
}

function reportBase(options: {
	harness: IsolationHarness;
	surface: IsolationSurface;
	tier: IsolationTier;
	detectedVersion: string | null;
	verdict: IsolationVerdict;
	findings: IsolationFinding[];
	checkedAt?: number;
}): HarnessIsolationReport {
	return {
		harness: options.harness,
		binary: harnessBinary(options.harness),
		surface: options.surface,
		tier: options.tier,
		tier1Strength: options.harness === 'codex' ? 'resolved-config-only' : 'realized-surface',
		pinnedVersion: pinnedVersionFor(options.harness),
		detectedVersion: options.detectedVersion,
		verdict: options.verdict,
		summary: plainSummary(options.harness, options.surface, options.verdict, options.findings),
		checkedAt: options.checkedAt ?? Date.now(),
		findings: options.findings
	};
}

export type CapturedSpawn = {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
	stdin?: string;
	timeoutMs: number;
	spawn?: SpawnProcess;
};

export type CapturedResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

type SpawnWithCwd = (
	command: string,
	args: readonly string[],
	options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; cwd?: string }
) => {
	stdout: { on: (e: string, cb: (c: Buffer | string) => void) => void };
	stderr: { on: (e: string, cb: (c: Buffer | string) => void) => void };
	stdin: { write: (s: string) => void; end: () => void; on?: (e: string, cb: () => void) => void };
	kill: (signal?: NodeJS.Signals) => boolean;
	on: (e: string, cb: (...args: unknown[]) => void) => void;
};

/**
 * One-shot capture with optional cwd. Separate from `runCapturedProcess` so the
 * OpenCode Tier-1 probe can run inside the generated config directory (debug
 * config has no `--dir` flag — cwd is how the app's config is selected).
 */
export function captureProcess(options: CapturedSpawn): Promise<CapturedResult> {
	return new Promise((resolve) => {
		let child: ReturnType<SpawnWithCwd>;
		try {
			const spawn = (options.spawn ?? (nodeSpawn as unknown as SpawnWithCwd)) as SpawnWithCwd;
			child = spawn(options.command, options.args, {
				env: options.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				...(options.cwd === undefined ? {} : { cwd: options.cwd })
			});
		} catch {
			resolve({ code: null, stdout: '', stderr: '' });
			return;
		}

		let settled = false;
		let timedOut = false;
		let stdout = '';
		let stderr = '';
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			resolve({ code: timedOut ? null : code, stdout, stderr });
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				child.kill('SIGKILL');
				finish(null);
			}, 1_000);
		}, options.timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.stdin.on?.('error', () => finish(null));
		child.on('error', () => finish(null));
		child.on('close', (code) => finish(typeof code === 'number' ? code : null));

		try {
			if (options.stdin !== undefined) child.stdin.write(options.stdin);
			child.stdin.end();
		} catch {
			finish(null);
		}
	});
}

async function probeDetectedVersion(
	command: string,
	env: NodeJS.ProcessEnv,
	spawn?: SpawnProcess
): Promise<string | null> {
	const result = await captureProcess({
		command,
		args: ['--version'],
		env,
		timeoutMs: 8_000,
		...(spawn ? { spawn } : {})
	});
	if (result.code !== 0) return null;
	return parseVersionLine(result.stdout);
}

function firstJsonObject(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	// Prefer a whole-stdout parse (debug config), then first JSONL line (claude).
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	for (const line of trimmed.split('\n')) {
		const candidate = line.trim();
		if (!candidate.startsWith('{')) continue;
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// keep scanning
		}
	}
	return null;
}

export type VerifyHarnessOptions = {
	harness: IsolationHarness;
	surface: IsolationSurface;
	/** Tier 2 spends a model call. Must be explicitly true — never the default. */
	deep?: boolean;
	command?: string;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnProcess;
	/** Panel OpenCode / Claude need a port for the MCP URL shape. */
	panelPort?: number;
	panelToken?: string;
	/** Injected globals for OpenCode config derivation (tests). */
	openCodeGlobals?: OpenCodeGlobalsOptions;
	now?: () => number;
	/** Override temp root — never the live data dir. */
	tempRoot?: string;
};

async function verifyOpenCodeTier1(
	options: VerifyHarnessOptions,
	detectedVersion: string | null
): Promise<HarnessIsolationReport> {
	const command = options.command ?? 'opencode';
	const env = sanitizedEnv(options.env ?? process.env, PROVIDER_SECRET_ENV_KEYS);
	const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'whatsagent-iso-oc-'));
	try {
		const config =
			options.surface === 'drafting'
				? draftingOpenCodeConfig({
						env,
						...(options.openCodeGlobals ?? {})
					})
				: panelOpenCodeConfig({
						port: options.panelPort ?? 9,
						env,
						...(options.openCodeGlobals ?? {})
					});
		await writeFile(join(root, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600
		});

		const captured = await captureProcess({
			command,
			args: [...OPENCODE_TIER1_ARGS],
			env,
			cwd: root,
			timeoutMs: 30_000,
			...(options.spawn ? { spawn: options.spawn } : {})
		});
		const parsed = firstJsonObject(captured.stdout);
		if (!parsed) {
			return reportBase({
				harness: 'codex',
				surface: options.surface,
				tier: 1,
				detectedVersion,
				verdict: 'unavailable',
				findings: [
					{
						code: 'no_config',
						detail: `opencode debug config produced no JSON (exit ${captured.code})`
					}
				],
				checkedAt: options.now?.()
			});
		}
		const evaluated = evaluateOpenCodeResolvedConfig(parsed as OpenCodeResolvedConfig, options.surface);
		return reportBase({
			harness: 'codex',
			surface: options.surface,
			tier: 1,
			detectedVersion,
			verdict: evaluated.ok ? 'pass' : 'fail',
			findings: evaluated.findings,
			checkedAt: options.now?.()
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function verifyClaudeTier1(
	options: VerifyHarnessOptions,
	detectedVersion: string | null
): Promise<HarnessIsolationReport> {
	const command = options.command ?? 'claude';
	const env = sanitizedEnv(options.env ?? process.env, [
		'ANTHROPIC_API_KEY',
		'ANTHROPIC_AUTH_TOKEN',
		'OPENAI_API_KEY',
		'CODEX_API_KEY'
	]);
	const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'whatsagent-iso-claude-'));
	try {
		let args: string[];
		let stdin: string;
		let cwd: string | undefined = root;

		if (options.surface === 'drafting') {
			args = claudeDraftIsolationArgv();
			stdin = `${JSON.stringify({
				type: 'user',
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Reply with the single word OK.' }]
				}
			})}\n`;
		} else {
			const mcpPath = join(root, 'mcp.json');
			await writeFile(
				mcpPath,
				`${JSON.stringify(buildPanelClaudeMcpConfig(options.panelPort ?? 9), null, 2)}\n`,
				{ mode: 0o600 }
			);
			args = claudePanelIsolationArgv(mcpPath);
			env.WHATSAGENT_MCP_TOKEN = options.panelToken ?? 'isolation-probe-token';
			stdin = 'Reply with the single word OK.\n';
		}

		const captured = await captureProcess({
			command,
			args,
			env,
			cwd,
			stdin,
			// Init event arrives before any model spend settles; keep this short.
			timeoutMs: 45_000,
			...(options.spawn ? { spawn: options.spawn } : {})
		});

		const event = firstJsonObject(captured.stdout);
		if (!event || event.type !== 'system') {
			// Still try to evaluate if tools keys are present on another shape.
			if (!event || (event.tools === undefined && event.mcp_servers === undefined)) {
				return reportBase({
					harness: 'claude',
					surface: options.surface,
					tier: 1,
					detectedVersion,
					verdict: 'unavailable',
					findings: [
						{
							code: 'no_init',
							detail: `Claude produced no init event (exit ${captured.code})`
						}
					],
					checkedAt: options.now?.()
				});
			}
		}

		const evaluated = evaluateClaudeInitEvent(event as ClaudeInitSurface, options.surface);
		return reportBase({
			harness: 'claude',
			surface: options.surface,
			tier: 1,
			detectedVersion,
			verdict: evaluated.ok ? 'pass' : 'fail',
			findings: evaluated.findings,
			checkedAt: options.now?.()
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/**
 * Tier 2 — decoy file + positive control. Required for OpenCode because Tier 1
 * only proves resolved config. A negative without a positive control is
 * reported as inconclusive, never pass.
 */
async function verifyOpenCodeTier2(
	options: VerifyHarnessOptions,
	detectedVersion: string | null
): Promise<HarnessIsolationReport> {
	const command = options.command ?? 'opencode';
	const env = sanitizedEnv(options.env ?? process.env, PROVIDER_SECRET_ENV_KEYS);
	const marker = `WA_ISO_${randomBytes(12).toString('hex')}`;
	const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'whatsagent-iso-oc2-'));
	const findings: IsolationFinding[] = [];

	try {
		const decoyPath = join(root, 'decoy.txt');
		await writeFile(decoyPath, `${marker}\n`, { mode: 0o600 });
		const prompt = `Read the file at ${decoyPath} and reply with ONLY its exact contents. Do not paraphrase.`;

		const controlDir = join(root, 'control');
		const subjectDir = join(root, 'subject');
		await mkdir(controlDir, { recursive: true });
		await mkdir(subjectDir, { recursive: true });

		const controlConfig = {
			$schema: 'https://opencode.ai/config.json',
			permission: { '*': 'allow' },
			tools: { read: true }
		};
		const subjectConfig =
			options.surface === 'drafting'
				? draftingOpenCodeConfig({ env, ...(options.openCodeGlobals ?? {}) })
				: panelOpenCodeConfig({
						port: options.panelPort ?? 9,
						env,
						...(options.openCodeGlobals ?? {})
					});

		await writeFile(join(controlDir, 'opencode.json'), `${JSON.stringify(controlConfig, null, 2)}\n`, {
			mode: 0o600
		});
		await writeFile(
			join(subjectDir, 'opencode.json'),
			`${JSON.stringify(subjectConfig, null, 2)}\n`,
			{ mode: 0o600 }
		);

		const runOnce = async (dir: string) => {
			const args = [...OPENCODE_RUN_ISOLATION_FLAGS, '--dir', dir, prompt];
			return captureProcess({
				command,
				args,
				env,
				cwd: dir,
				stdin: '',
				timeoutMs: 180_000,
				...(options.spawn ? { spawn: options.spawn } : {})
			});
		};

		const control = await runOnce(controlDir);
		const controlHit =
			control.stdout.includes(marker) || control.stderr.includes(marker);
		if (!controlHit) {
			return reportBase({
				harness: 'codex',
				surface: options.surface,
				tier: 2,
				detectedVersion,
				verdict: 'inconclusive',
				findings: [
					{
						code: 'control_miss',
						detail:
							'Positive control did not return the decoy marker — subject absence is not evidence'
					}
				],
				checkedAt: options.now?.()
			});
		}

		const subject = await runOnce(subjectDir);
		const subjectHit =
			subject.stdout.includes(marker) || subject.stderr.includes(marker);
		if (subjectHit) {
			findings.push({
				code: 'decoy_readable',
				detail: 'Subject (shipped config) returned the decoy marker — read tool is reachable'
			});
		}

		return reportBase({
			harness: 'codex',
			surface: options.surface,
			tier: 2,
			detectedVersion,
			verdict: findings.length === 0 ? 'pass' : 'fail',
			findings,
			checkedAt: options.now?.()
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Claude Tier 2 — same decoy pair; less critical because Tier 1 is realized. */
async function verifyClaudeTier2(
	options: VerifyHarnessOptions,
	detectedVersion: string | null
): Promise<HarnessIsolationReport> {
	const command = options.command ?? 'claude';
	const env = sanitizedEnv(options.env ?? process.env, [
		'ANTHROPIC_API_KEY',
		'ANTHROPIC_AUTH_TOKEN'
	]);
	const marker = `WA_ISO_${randomBytes(12).toString('hex')}`;
	const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'whatsagent-iso-cl2-'));
	const findings: IsolationFinding[] = [];

	try {
		const decoyPath = join(root, 'decoy.txt');
		await writeFile(decoyPath, `${marker}\n`, { mode: 0o600 });
		const prompt = `Read the file at ${decoyPath} and reply with ONLY its exact contents.`;

		const run = async (toolsFlag: string) => {
			const args = [
				'-p',
				'--output-format',
				'stream-json',
				'--verbose',
				'--tools',
				toolsFlag,
				'--no-session-persistence',
				...(toolsFlag === '' ? ['--safe-mode', '--disable-slash-commands'] : [])
			];
			return captureProcess({
				command,
				args,
				env,
				cwd: root,
				stdin: `${prompt}\n`,
				timeoutMs: 180_000,
				...(options.spawn ? { spawn: options.spawn } : {})
			});
		};

		const control = await run('Read');
		const controlHit =
			control.stdout.includes(marker) || control.stderr.includes(marker);
		if (!controlHit) {
			return reportBase({
				harness: 'claude',
				surface: options.surface,
				tier: 2,
				detectedVersion,
				verdict: 'inconclusive',
				findings: [
					{
						code: 'control_miss',
						detail:
							'Positive control did not return the decoy marker — subject absence is not evidence'
					}
				],
				checkedAt: options.now?.()
			});
		}

		const subject = await run('');
		if (subject.stdout.includes(marker) || subject.stderr.includes(marker)) {
			findings.push({
				code: 'decoy_readable',
				detail: 'Subject (isolation flags) returned the decoy marker'
			});
		}

		return reportBase({
			harness: 'claude',
			surface: options.surface,
			tier: 2,
			detectedVersion,
			verdict: findings.length === 0 ? 'pass' : 'fail',
			findings,
			checkedAt: options.now?.()
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/**
 * Run isolation verification for one harness + surface.
 * Default is Tier 1. Pass `deep: true` for Tier 2 (explicit only).
 */
export async function verifyHarnessIsolation(
	options: VerifyHarnessOptions
): Promise<HarnessIsolationReport> {
	const deep = options.deep === true;
	const command = options.command ?? harnessBinary(options.harness);
	const env = sanitizedEnv(options.env ?? process.env, PROVIDER_SECRET_ENV_KEYS);
	const detectedVersion = await probeDetectedVersion(command, env, options.spawn);

	if (options.harness === 'codex') {
		if (deep) return verifyOpenCodeTier2(options, detectedVersion);
		return verifyOpenCodeTier1(options, detectedVersion);
	}
	if (deep) return verifyClaudeTier2(options, detectedVersion);
	return verifyClaudeTier1(options, detectedVersion);
}

export function parseIsolationStore(raw: string | undefined): HarnessIsolationStore {
	if (!raw?.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return parsed as HarnessIsolationStore;
	} catch {
		return {};
	}
}

export function mergeIsolationReport(
	store: HarnessIsolationStore,
	report: HarnessIsolationReport
): HarnessIsolationStore {
	return {
		...store,
		[report.harness]: {
			...(store[report.harness] ?? {}),
			[report.surface]: report
		}
	};
}
