import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Resolve an explicit app-data directory from the environment or argv.
 *
 * Until this existed, `main()` in `server/index.ts` called `openDatabase()` with
 * no arguments, so the full app could **only ever** open the owner's real
 * WhatsApp database — there was no way to run it against a throwaway directory.
 * That matters most for a packaged build: `assertNotLiveDbFromWorktree()` guards
 * the default dir only when it can find a linked `.git` above the module, and an
 * app bundle is not a git checkout, so it takes the "installed copy" exit and
 * opens the live database without complaint.
 *
 * Precedence: `--data-dir` (argv) beats `WHATSAGENT_DATA_DIR` (env), because a
 * launcher-supplied flag is the more specific instruction. Blank values are
 * treated as absent so an empty env var does not resolve to the process cwd.
 * `~` is expanded and relative paths are resolved, so callers get an absolute
 * path or `undefined` — never something ambiguous to pass to `openDatabase`.
 *
 * This lives in its own module, separate from `server/index.ts`, so the Electron
 * main process can import it *before* `app.whenReady()` without loading the
 * whole server graph (Baileys, better-sqlite3) or tripping `index.ts`'s
 * argv-based self-start guard.
 */
export function resolveDataDirOverride(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
	home: () => string = homedir
): string | undefined {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--data-dir') {
			raw = argv[i + 1];
		} else if (arg?.startsWith('--data-dir=')) {
			raw = arg.slice('--data-dir='.length);
		}
	}
	if (raw === undefined || raw.trim() === '') raw = env.WHATSAGENT_DATA_DIR;
	if (raw === undefined || raw.trim() === '') return undefined;

	const trimmed = raw.trim();
	const expanded =
		trimmed === '~'
			? home()
			: trimmed.startsWith('~/')
				? join(home(), trimmed.slice(2))
				: trimmed;
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}
