import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type ImportGraph = {
	/** Absolute paths of every source file reachable through value imports. */
	files: Set<string>;
	/** Bare package specifiers reached through value imports. */
	packages: Set<string>;
};

/**
 * Statements whose module is loaded at runtime, i.e. everything except
 * `import type ...` / `export type ...`.
 *
 * The `type` MODIFIER is what matters, not the presence of the word: a value
 * import with inline type specifiers (`import { foo, type Bar } from './x.js'`)
 * still evaluates `./x.js` at runtime and must be followed. TypeScript erases
 * only the whole-statement form, so only that form is skipped here.
 */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)from\s*['"]([^'"]+)['"]/g;
/** Bare side-effect import: `import './x.js';` — no clause, always a value import. */
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function resolveSpecifier(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null;
	const base = resolve(dirname(fromFile), specifier);
	// NodeNext source uses `.js` specifiers that map to `.ts` on disk.
	const candidates = [
		base.replace(/\.js$/, '.ts'),
		base.replace(/\.js$/, '.tsx'),
		base,
		`${base}.ts`,
		`${base}/index.ts`
	];
	return candidates.find((c) => existsSync(c) && !c.endsWith('/')) ?? null;
}

/**
 * Walk the transitive **runtime** import graph of a TypeScript entry point.
 *
 * Deliberately a regex walker rather than the TS compiler API: the assertion it
 * backs is "this module cannot construct a WhatsApp channel", and a walker that
 * silently resolves nothing would report that vacuously. A small, readable
 * walker whose non-vacuity is itself asserted is worth more here than a
 * heavyweight one that is trusted on faith.
 */
export function resolveImportGraph(entry: string): ImportGraph {
	const files = new Set<string>();
	const packages = new Set<string>();
	const queue = [resolve(entry)];

	while (queue.length > 0) {
		const file = queue.pop()!;
		if (files.has(file)) continue;
		files.add(file);
		const source = readFileSync(file, 'utf8');

		const specifiers: string[] = [];
		for (const match of source.matchAll(IMPORT_RE)) {
			if (match[1] !== undefined) continue; // `import type` / `export type` — erased.
			specifiers.push(match[3]!);
		}
		for (const match of source.matchAll(SIDE_EFFECT_RE)) specifiers.push(match[1]!);

		for (const specifier of specifiers) {
			if (specifier.startsWith('node:')) continue;
			const resolved = resolveSpecifier(file, specifier);
			if (resolved === null) {
				if (!specifier.startsWith('.')) packages.add(packageNameOf(specifier));
				continue;
			}
			if (!files.has(resolved)) queue.push(resolved);
		}
	}

	files.delete(resolve(entry));
	return { files, packages };
}

function packageNameOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}
