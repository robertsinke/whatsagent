import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './migrations.generated.js';

export type AppDatabase = Database.Database;

export type OpenDatabaseOptions = {
	/** Override app-data directory (tests). Default: platform app-data dir. */
	dataDir?: string;
	/** DB filename within the data dir. Default: `whatsagent.db`. */
	filename?: string;
	/**
	 * MCPX-4 — run pending migrations on open. Default `true`, so every existing
	 * caller is unchanged.
	 *
	 * The one caller that passes `false` is the headless MCP stdio entry point
	 * (`server/mcp/stdio.ts`). Its path into `app.asar` is hardcoded in the
	 * owner's MCP client config, so after an auto-update it runs whatever the
	 * bundle now holds — and it can be launched while the desktop app is also
	 * running. Two processes racing `migrate()` on the owner's live WhatsApp
	 * database is not a risk worth taking for a read-mostly side entrance:
	 * it refuses and tells the owner to launch the app once instead. See
	 * `docs/solutions/2026-07-26-migration-numbering-and-high-water-mark.md`.
	 */
	migrate?: boolean;
};

const DB_FILENAME = 'whatsagent.db';

/** Platform app-data directory for whatsagent (never the repo). */
export function getDefaultDataDir(): string {
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'whatsagent');
	}
	if (process.platform === 'win32') {
		return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'whatsagent');
	}
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'whatsagent');
}

/**
 * Refuse to open the owner's LIVE data directory from a git worktree.
 *
 * The live data dir holds the WhatsApp auth credentials. Opening it from a
 * worktree starts a second Baileys socket on the owner's personal account —
 * an account-level hazard. This guard makes that refusal structural: a rule
 * that has to be remembered is a rule that eventually gets missed, and the
 * cost of missing this one is paid on a real account.
 *
 * Scope is deliberately narrow. Only the *default* data dir is guarded, so
 * everything that passes an explicit `dataDir` — the test suite, the UI preview
 * harness, the evaluation harness — keeps working from anywhere.
 *
 * Detection: in a linked worktree `.git` is a FILE containing a `gitdir:`
 * pointer; in the main checkout it is a directory.
 *
 * Override: set `WHATSAGENT_ALLOW_WORKTREE_LIVE_DB=1` for the rare case where
 * the owner deliberately wants the live DB from a worktree. Escape hatches
 * belong in the owner's hands, not in a worker's judgement.
 */
function assertNotLiveDbFromWorktree(): void {
	if (process.env.WHATSAGENT_ALLOW_WORKTREE_LIVE_DB === '1') return;

	// Search upward for `.git` rather than assuming a fixed depth. This module is
	// loaded from two different depths — `server/store/` in source and
	// `dist/server/server/store/` compiled — and the fixed-depth version silently
	// disarmed itself for the compiled one: it looked for `.git` inside `dist/`,
	// found nothing, and took the "installed copy" exit. A worker running the
	// compiled server from a worktree got no guard at all.
	let stat;
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		try {
			stat = statSync(join(dir, '.git'));
			break;
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return; // No checkout above us (installed copy) — nothing to guard.
			dir = parent;
		}
	}
	if (stat.isDirectory()) return; // Main checkout.

	throw new Error(
		'Refusing to open the live WhatsApp database from a git worktree.\n' +
			'\n' +
			'This would open the owner’s real WhatsApp credentials and put a second\n' +
			'Baileys socket on their personal account.\n' +
			'\n' +
			'  * Verifying UI work?  Use `npm run preview:ui` — a throwaway database\n' +
			'    with no WhatsApp connection.\n' +
			'  * Writing a script?   Pass an explicit `dataDir` (see scripts/ui-preview.ts).\n' +
			'  * Really need the live app?  Run it from the main checkout, not a worktree.\n' +
			'  * Deliberate override?  WHATSAGENT_ALLOW_WORKTREE_LIVE_DB=1\n'
	);
}

export function getDatabasePath(options: OpenDatabaseOptions = {}): string {
	const dataDir = options.dataDir ?? getDefaultDataDir();
	return join(dataDir, options.filename ?? DB_FILENAME);
}

/**
 * Open (or create) the SQLite DB under the app-data dir, enforce 0600, WAL mode,
 * and run pending migrations.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): AppDatabase {
	// Only the default (live) dir is guarded — an explicit dataDir is a test,
	// the preview harness, or a script, and stays free to run anywhere.
	if (options.dataDir === undefined) assertNotLiveDbFromWorktree();
	const dataDir = options.dataDir ?? getDefaultDataDir();
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	const dbPath = getDatabasePath({ ...options, dataDir });
	const db = new Database(dbPath);
	chmodSync(dbPath, 0o600);

	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	if (options.migrate !== false) migrate(db);
	return db;
}

/**
 * The highest migration version this code carries — the high-water mark a
 * database must be at for this build to read it safely.
 */
export function codeSchemaVersion(): number {
	return MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

/**
 * The highest migration version this database has recorded.
 *
 * Returns 0 when `schema_version` does not exist — which is the normal state of
 * a database opened with `migrate: false` that has never been migrated, and
 * must not throw: the caller's whole job is to compare and refuse.
 */
export function readSchemaVersion(db: AppDatabase): number {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
		.get();
	if (!table) return 0;
	const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
		v: number | null;
	};
	return row.v ?? 0;
}

export function migrate(db: AppDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);

	const current =
		(db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null })
			.v ?? 0;

	const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) =>
		a.version < b.version ? -1 : 1
	);

	const apply = db.transaction((version: number, sql: string) => {
		db.exec(sql);
		db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
			version,
			Date.now()
		);
	});

	for (const migration of pending) {
		apply(migration.version, migration.sql);
	}
}
