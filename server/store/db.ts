import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

export function getDatabasePath(options: OpenDatabaseOptions = {}): string {
	const dataDir = options.dataDir ?? getDefaultDataDir();
	return join(dataDir, options.filename ?? DB_FILENAME);
}

/**
 * Open (or create) the SQLite DB under the app-data dir, enforce 0600, WAL mode,
 * and run pending migrations.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): AppDatabase {
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
