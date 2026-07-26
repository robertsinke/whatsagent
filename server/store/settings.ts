import type { AppDatabase } from './db.js';

export const PACING_MIN_SECONDS_SETTING = 'pacing_min_seconds';
export const PACING_MAX_SECONDS_SETTING = 'pacing_max_seconds';
export const DEFAULT_MIN_SPACING_MS = 0;
export const DEFAULT_MAX_SPACING_MS = 1_000;

export type OutboxPacingSettings = {
	minSpacingMs: number;
	maxSpacingMs: number;
};

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

function secondsSetting(db: AppDatabase, key: string, fallbackMs: number): number {
	const setting = getSetting(db, key);
	const value = setting?.trim() ? Number(setting) : Number.NaN;
	return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000) : fallbackMs;
}

export function getOutboxPacingSettings(db: AppDatabase): OutboxPacingSettings {
	const minSpacingMs = secondsSetting(db, PACING_MIN_SECONDS_SETTING, DEFAULT_MIN_SPACING_MS);
	const configuredMaxMs = secondsSetting(
		db,
		PACING_MAX_SECONDS_SETTING,
		DEFAULT_MAX_SPACING_MS
	);
	return {
		minSpacingMs,
		maxSpacingMs: Math.max(minSpacingMs, configuredMaxMs)
	};
}

/** Settings API view: persisted values plus normalized runtime defaults. */
export function listEffectiveSettings(db: AppDatabase): Record<string, string> {
	const settings = listSettings(db);
	const pacing = getOutboxPacingSettings(db);
	return {
		...settings,
		[PACING_MIN_SECONDS_SETTING]: String(pacing.minSpacingMs / 1_000),
		[PACING_MAX_SECONDS_SETTING]: String(pacing.maxSpacingMs / 1_000)
	};
}
