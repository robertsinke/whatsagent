#!/usr/bin/env tsx
/**
 * Terminal entry for SEC-1 harness isolation verification.
 *
 *   npm run verify:harness
 *   npm run verify:harness -- --harness claude --surface drafting
 *   npm run verify:harness -- --harness codex --deep
 *   npm run verify:harness -- --surface panel --harness claude --panel-port 8787
 *
 * Claude panel Tier 1 measures the *realized* MCP surface, so it needs a live
 * app port. Without --panel-port the CLI probes the default port (8787); if
 * nothing answers it returns unavailable rather than a false panel_mcp_missing
 * fail. See server/providers/harness-isolation.ts header.
 *
 * Not wired into `npm run check` — it spawns third-party binaries that may be
 * absent, and a gate that fails on a missing optional dependency is a gate
 * people delete.
 */
import { readMcpTokenFile } from '../server/mcp/token.js';
import { getDefaultDataDir } from '../server/store/db.js';
import {
	verifyHarnessIsolation,
	type IsolationHarness,
	type IsolationSurface
} from '../server/providers/harness-isolation.js';

/** Same default as createApp — where a normal `npm run dev` listens. */
const DEFAULT_PANEL_PORT = 8787;

function usage(): never {
	console.error(`Usage: npm run verify:harness -- [options]

Options:
  --harness claude|codex   (default: both)
  --surface drafting|panel (default: drafting)
  --deep                   Tier 2 decoy + positive control (costs a model call)
  --panel-port <n>         Live app port for Claude panel realized-surface check
  --panel-token <token>    Bearer for /mcp (default: read {dataDir}/mcp.token)
`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	let harness: IsolationHarness | 'both' = 'both';
	let surface: IsolationSurface = 'drafting';
	let deep = false;
	let panelPort: number | undefined;
	let panelToken: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === '--harness') {
			const v = argv[++i];
			if (v !== 'claude' && v !== 'codex') usage();
			harness = v;
		} else if (a === '--surface') {
			const v = argv[++i];
			if (v !== 'drafting' && v !== 'panel') usage();
			surface = v;
		} else if (a === '--deep') {
			deep = true;
		} else if (a === '--panel-port') {
			const v = argv[++i];
			const n = Number(v);
			if (!v || !Number.isInteger(n) || n < 1 || n > 65535) usage();
			panelPort = n;
		} else if (a === '--panel-token') {
			const v = argv[++i];
			if (!v) usage();
			panelToken = v;
		} else if (a === '-h' || a === '--help') {
			usage();
		} else {
			usage();
		}
	}
	return { harness, surface, deep, panelPort, panelToken };
}

/**
 * Cheap probe: anything answering on /mcp (even 401) means a live surface.
 * Connection refused / timeout → nothing to measure.
 */
async function probePanelPort(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: 'GET',
			signal: AbortSignal.timeout(800)
		});
		// 401 = MCP up, auth required; 405/406 = method/accept mismatch still proves a listener.
		return res.status === 401 || res.status === 200 || res.status === 405 || res.status === 406;
	} catch {
		return false;
	}
}

async function resolvePanelEndpoint(options: {
	surface: IsolationSurface;
	harness: IsolationHarness | 'both';
	panelPort?: number;
	panelToken?: string;
}): Promise<{ panelPort?: number; panelToken?: string; source?: string }> {
	const needsClaudePanel =
		options.surface === 'panel' &&
		(options.harness === 'claude' || options.harness === 'both');
	if (!needsClaudePanel) {
		return {
			...(options.panelPort !== undefined ? { panelPort: options.panelPort } : {}),
			...(options.panelToken !== undefined ? { panelToken: options.panelToken } : {})
		};
	}

	let panelPort = options.panelPort;
	let source: string | undefined;
	if (panelPort === undefined) {
		if (await probePanelPort(DEFAULT_PANEL_PORT)) {
			panelPort = DEFAULT_PANEL_PORT;
			source = `auto-detected listener on ${DEFAULT_PANEL_PORT}`;
		}
	} else {
		source = `--panel-port ${panelPort}`;
	}

	let panelToken = options.panelToken;
	if (panelPort !== undefined && panelToken === undefined) {
		const fromFile = readMcpTokenFile(getDefaultDataDir());
		if (fromFile) panelToken = fromFile;
	}

	return {
		...(panelPort !== undefined ? { panelPort } : {}),
		...(panelToken !== undefined ? { panelToken } : {}),
		...(source ? { source } : {})
	};
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	const resolved = await resolvePanelEndpoint(parsed);
	if (resolved.source) {
		process.stderr.write(`Panel endpoint: ${resolved.source}\n`);
	}

	const targets: IsolationHarness[] =
		parsed.harness === 'both' ? ['claude', 'codex'] : [parsed.harness];
	let failed = false;
	for (const h of targets) {
		process.stderr.write(
			`Verifying ${h} / ${parsed.surface} (tier ${parsed.deep ? 2 : 1})…\n`
		);
		const report = await verifyHarnessIsolation({
			harness: h,
			surface: parsed.surface,
			deep: parsed.deep,
			...(resolved.panelPort !== undefined ? { panelPort: resolved.panelPort } : {}),
			...(resolved.panelToken !== undefined ? { panelToken: resolved.panelToken } : {})
		});
		console.log(JSON.stringify(report, null, 2));
		if (report.verdict !== 'pass') failed = true;
	}
	process.exit(failed ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
