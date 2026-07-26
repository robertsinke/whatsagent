import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AppDatabase = Database.Database;

export type OpenDatabaseOptions = {
	/** Override app-data directory (tests). Default: platform app-data dir. */
	dataDir?: string;
	/** DB filename within the data dir. Default: `whatsagent.db`. */
	filename?: string;
};

const DB_FILENAME = 'whatsagent.db';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

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
 * an account-level hazard, which is why `.slayzone/worker.md` tells workers
 * never to start the real backend. This makes that structural instead of
 * remembered: a rule a worker has to recall is a rule that eventually gets
 * missed, and the cost of missing this one is paid on a real account.
 *
 * Scope is deliberately narrow. Only the *default* data dir is guarded, so
 * everything that passes an explicit `dataDir` — the test suite, the UI preview
 * harness, the evaluation harness — keeps working from anywhere.
 *
 * Detection: in a linked worktree `.git` is a FILE containing a `gitdir:`
 * pointer; in the main checkout it is a directory.
 *
 * `WHATSAGENT_ALLOW_WORKTREE_LIVE_DB=1` overrides, for the rare case where the
 * owner deliberately wants it. Escape hatches belong in the owner's hands, not
 * in a worker's judgement.
 */
function assertNotLiveDbFromWorktree(): void {
	if (process.env.WHATSAGENT_ALLOW_WORKTREE_LIVE_DB === '1') return;

	// server/store/db.ts -> repo root is three levels up.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
	let stat;
	try {
		stat = statSync(join(repoRoot, '.git'));
	} catch {
		return; // Not a git checkout at all (installed copy) — nothing to guard.
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
			'  * Really need the live app?  Run it from the main checkout, not a worktree.\n'
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

	migrate(db);
	return db;
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

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((name) => /^\d+.*\.sql$/.test(name))
		.sort();

	const apply = db.transaction((version: number, sql: string) => {
		db.exec(sql);
		db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
			version,
			Date.now()
		);
	});

	for (const file of files) {
		const version = Number.parseInt(file, 10);
		if (!Number.isFinite(version) || version <= current) continue;
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
		apply(version, sql);
	}
}
