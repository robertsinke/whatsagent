import type { AppDatabase } from './db.js';

export function getSetting(db: AppDatabase, key: string): string | undefined {
	const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
		| { value: string }
		| undefined;
	return row?.value;
}

export function setSetting(db: AppDatabase, key: string, value: string): void {
	db.prepare(
		`INSERT INTO settings (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
	).run(key, value);
}

export function deleteSetting(db: AppDatabase, key: string): void {
	db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function listSettings(db: AppDatabase): Record<string, string> {
	const rows = db.prepare('SELECT key, value FROM settings').all() as {
		key: string;
		value: string;
	}[];
	const out: Record<string, string> = {};
	for (const row of rows) out[row.key] = row.value;
	return out;
}
