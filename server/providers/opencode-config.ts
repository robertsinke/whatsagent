import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The opencode config pieces shared by the two configs this app writes:
 * the **drafting** config (no tools at all — `server/providers/opencode.ts`)
 * and the **panel** config (our MCP tools and still no builtins —
 * `server/agent/panel/opencode-harness.ts`).
 *
 * WHAT IS SHARED AND WHAT IS NOT. Shared: the thirteen-key `tools` block and
 * the inherited-globals disable list. NOT shared: `mcp` and `permission` —
 * drafting has no `mcp` block and denies everything, while the panel mounts
 * `whatsagent` and allows `whatsagent*`. Those two configs are INVERSES of each
 * other by design and must not be merged into one "unified" config; only the
 * two mechanical pieces below are common, and they live here so neither is
 * written twice.
 */

/**
 * Verbatim empty-toolset block from
 * `docs/evidence/2026-07-29-pl-s3-opencode-recheck.md` (PL-S3).
 *
 * Do not hand-roll a subset: on opencode 1.18.9 a five-key tools block
 * (bash/read/todoread/patch/task) can hang every run, while this thirteen-key
 * shape returns in seconds. If you must change it, re-prove with a decoy file
 * AND a positive control — a negative decoy result on its own proves nothing.
 */
export const OPENCODE_BUILTIN_TOOLS_OFF = {
	bash: false,
	edit: false,
	write: false,
	read: false,
	grep: false,
	glob: false,
	list: false,
	webfetch: false,
	websearch: false,
	todowrite: false,
	skill: false,
	question: false,
	lsp: false
} as const;

/**
 * Every path `opencode run` merges a user-level config from, in the order it
 * logs them (observed on 1.18.9 with `--print-logs --log-level DEBUG`):
 *
 *   ~/.config/opencode/config.json
 *   ~/.config/opencode/opencode.json
 *   ~/.config/opencode/opencode.jsonc
 *   ~/.opencode/opencode.json
 *   ~/.opencode/opencode.jsonc
 *
 * `--pure` does NOT suppress any of them — it means "without external
 * plugins", and the config files are still loaded and their MCP servers still
 * injected. Verified by enumerating the tool list under `--pure` with no
 * disable block: every MCP tool from the developer's own user config was
 * present, prefixed with its server name. So this list is load-bearing, not
 * defensive.
 */
function userConfigPaths(env: NodeJS.ProcessEnv, home: string): string[] {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const configHome = xdg ? xdg : join(home, '.config');
	return [
		join(configHome, 'opencode', 'config.json'),
		join(configHome, 'opencode', 'opencode.json'),
		join(configHome, 'opencode', 'opencode.jsonc'),
		join(home, '.opencode', 'opencode.json'),
		join(home, '.opencode', 'opencode.jsonc')
	];
}

/** Strip `//` and `/* *​/` comments so a `.jsonc` file parses. */
function stripJsonComments(text: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			i += 1;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

export type OpenCodeGlobalsOptions = {
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Injected in tests so the suite never depends on the developer's own `~/.config`. */
	readFile?: (path: string) => string;
};

/**
 * Read the user's own opencode configs and return the MCP server names they
 * define, so both of this app's configs can disable them by name.
 *
 * WHY DERIVED RATHER THAN HARDCODED. This list used to be four literal server
 * names from one developer's machine, inside `OPENCODE_EMPTY_TOOLS_CONFIG`.
 * That is wrong twice over: it ships publicly and discloses what other work
 * that person does, and it is silently incomplete on anybody else's machine —
 * a contributor with their own MCP servers got them injected into a config
 * whose entire purpose is having no tools. The names are deliberately not
 * repeated here; naming them would re-ship what deriving them removes.
 *
 * Failure is non-fatal by design: an unreadable or malformed user config yields
 * an empty list rather than throwing, because the alternative is drafting
 * breaking outright over a stray comma in a file this app does not own. The
 * `permission` deny in both configs is the second line of defence for exactly
 * that case — an injected server's tools are denied even when un-disabled.
 */
export function readUserOpenCodeMcpNames(options: OpenCodeGlobalsOptions = {}): string[] {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
	const names = new Set<string>();

	for (const path of userConfigPaths(env, home)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(read(path)));
		} catch {
			// Missing (the common case) or malformed — neither is our problem to fix.
			continue;
		}
		const mcp = (parsed as { mcp?: unknown } | null)?.mcp;
		if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) continue;
		for (const name of Object.keys(mcp)) {
			if (name) names.add(name);
		}
	}

	return [...names].sort();
}

/**
 * `{ name: { enabled: false } }` for every inherited server, ready to spread
 * into an `mcp` block. `reserved` names are skipped so the panel config cannot
 * accidentally disable its own `whatsagent` server if the owner happens to
 * define one with that name too.
 */
export function disabledInheritedMcp(
	names: readonly string[],
	reserved: readonly string[] = []
): Record<string, { enabled: false }> {
	const skip = new Set(reserved);
	const out: Record<string, { enabled: false }> = {};
	for (const name of names) {
		if (skip.has(name)) continue;
		out[name] = { enabled: false };
	}
	return out;
}
