#!/usr/bin/env tsx
/**
 * Terminal entry for SEC-1 harness isolation verification.
 *
 *   npm run verify:harness
 *   npm run verify:harness -- --harness claude --surface drafting
 *   npm run verify:harness -- --harness codex --deep
 *
 * Not wired into `npm run check` — it spawns third-party binaries that may be
 * absent, and a gate that fails on a missing optional dependency is a gate
 * people delete.
 */
import {
	verifyHarnessIsolation,
	type IsolationHarness,
	type IsolationSurface
} from '../server/providers/harness-isolation.js';

function usage(): never {
	console.error(`Usage: npm run verify:harness -- [options]

Options:
  --harness claude|codex   (default: both)
  --surface drafting|panel (default: drafting)
  --deep                   Tier 2 decoy + positive control (costs a model call)
`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	let harness: IsolationHarness | 'both' = 'both';
	let surface: IsolationSurface = 'drafting';
	let deep = false;
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
		} else if (a === '-h' || a === '--help') {
			usage();
		} else {
			usage();
		}
	}
	return { harness, surface, deep };
}

async function main() {
	const { harness, surface, deep } = parseArgs(process.argv.slice(2));
	const targets: IsolationHarness[] = harness === 'both' ? ['claude', 'codex'] : [harness];
	let failed = false;
	for (const h of targets) {
		process.stderr.write(
			`Verifying ${h} / ${surface} (tier ${deep ? 2 : 1})…\n`
		);
		const report = await verifyHarnessIsolation({ harness: h, surface, deep });
		console.log(JSON.stringify(report, null, 2));
		if (report.verdict !== 'pass') failed = true;
	}
	process.exit(failed ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
