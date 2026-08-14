import type { AppDatabase } from './db.js';
import { DRAFT_PROVIDER_NAMES } from '../../shared/providers.js';
import {
	calendarConnectionPublicView,
	redactCalendarSecrets
} from '../calendar/credentials.js';

export const PACING_MIN_SECONDS_SETTING = 'pacing_min_seconds';
export const PACING_MAX_SECONDS_SETTING = 'pacing_max_seconds';
export const OUTBOX_DRY_RUN_SETTING = 'outbox_dry_run';
export const PROVIDER_SETTING = 'provider';
export const PROVIDER_MODEL_SETTING = 'provider_model';
export const MEMORY_SETTING = 'memory';
/**
 * PANEL-S1 — the agent panel's owner-facing opt-in. Three rows rather than one:
 * the panel cannot run without a harness, and the model is optional (each
 * harness has its own default), so a single blob would make "enabled but
 * unconfigured" unrepresentable and the warning path impossible to state.
 *
 * PANEL-S2: writing one of these DOES start, stop, or rebuild the panel. The
 * write path (`set-setting`) calls `applyPanelSettings`, which reconciles the
 * live runtime and the `/mcp` surface — see `reconcilePanelRuntime` in
 * `server/index.ts`. That runtime reach is why `set-setting` is frontend-only.
 */
export const PANEL_ENABLED_SETTING = 'panel_enabled';
export const PANEL_HARNESS_SETTING = 'panel_harness';
export const PANEL_MODEL_SETTING = 'panel_model';
/**
 * MCPX-2 — the owner's opt-in for the `/mcp` surface itself, independent of the
 * agent panel.
 *
 * Before this row existed the surface followed `panel_enabled`, so turning the
 * in-app panel off ran `removeMcpTokenFile` and destroyed the credential an
 * external Claude Code / Cursor session was configured with — silently, with no
 * error anywhere. The two are separate capabilities: the panel is a window, this
 * is a network surface other processes hold a token for.
 *
 * The implication only runs one way: panel-on still implies MCP-on (the panel is
 * unusable without its tools), MCP-on implies nothing about the panel.
 *
 * This row is ALSO the headless gate (MCPX-4): with the app closed there is no
 * process to ask, so that path reads this same row straight from the database.
 * Keep it a plain boolean about the MCP surface — not a panel sub-setting.
 */
export const MCP_ENABLED_SETTING = 'mcp_enabled';
export const DEFAULT_MIN_SPACING_MS = 0;
export const DEFAULT_MAX_SPACING_MS = 1_000;

/** Closed domain for the `memory` setting. Mirrors `MemoryMode` in hindsight.ts. */
const MEMORY_VALUES: ReadonlySet<string> = new Set(['off', 'null', 'hindsight']);

/**
 * Closed domain for `panel_harness`. Mirrors `PANEL_HARNESS_IDS` in
 * `agent/panel/index.ts` — kept local for the same reason `MEMORY_VALUES` is,
 * so the store module does not pull the harness graph (and its child-process
 * imports) into every caller that only wants to read a settings row.
 */
const PANEL_HARNESS_VALUES: ReadonlySet<string> = new Set(['opencode', 'claude']);

export type OutboxPacingSettings = {
	minSpacingMs: number;
	maxSpacingMs: number;
};

/**
 * Result of validating a setting value before it is persisted. {@link ok}
 * carries the NORMALIZED string to write — a padded, capitalised provider name
 * must persist trimmed and lowercased, because a trailing space bricks startup
 * exactly as badly as a misspelling. A failure carries a human message and the
 * allowed set so the UI can render the options without a second call.
 */
export type SettingValidation =
	| { ok: true; normalized: string }
	| { ok: false; message: string; allowed: string[] };

/**
 * Validate a setting VALUE, never the key. This endpoint is also the write path
 * for `hindsight_url`, `hindsight_bank`, `hindsight_refresh_cron`, `memory`,
 * the two pacing keys, `outbox_dry_run` and `whatsapp_history_sync_complete`,
 * so a key whitelist would silently break every one of them. Closed domains
 * (`provider`, `memory`, `outbox_dry_run`, `pacing_*`) are validated against
 * their allowed set and normalized; everything else passes through unchanged,
 * including `provider_model` and `panel_model` which stay free text on purpose
 * — a model released today must be settable without shipping a new build.
 */
export function validateSettingValue(key: string, raw: string): SettingValidation {
	const value = typeof raw === 'string' ? raw : '';
	if (key === PROVIDER_SETTING) {
		const trimmed = value.trim();
		const lower = trimmed.toLowerCase();
		const allowed: readonly string[] = DRAFT_PROVIDER_NAMES;
		if (trimmed === '' || !allowed.includes(lower)) {
			return {
				ok: false,
				message: `Unknown provider ${JSON.stringify(raw)}`,
				allowed: [...DRAFT_PROVIDER_NAMES]
			};
		}
		return { ok: true, normalized: lower };
	}
	if (key === MEMORY_SETTING) {
		const trimmed = value.trim();
		const lower = trimmed.toLowerCase();
		if (!MEMORY_VALUES.has(lower)) {
			return {
				ok: false,
				message: `Unknown memory mode ${JSON.stringify(raw)}`,
				allowed: [...MEMORY_VALUES]
			};
		}
		return { ok: true, normalized: lower };
	}
	if (key === OUTBOX_DRY_RUN_SETTING) {
		const trimmed = value.trim();
		const lower = trimmed.toLowerCase();
		if (lower !== 'true' && lower !== 'false') {
			return {
				ok: false,
				message: `outbox_dry_run must be 'true' or 'false'`,
				allowed: ['true', 'false']
			};
		}
		return { ok: true, normalized: lower };
	}
	if (key === PANEL_ENABLED_SETTING) {
		const lower = value.trim().toLowerCase();
		if (lower !== 'true' && lower !== 'false') {
			return {
				ok: false,
				message: `${PANEL_ENABLED_SETTING} must be 'true' or 'false'`,
				allowed: ['true', 'false']
			};
		}
		return { ok: true, normalized: lower };
	}
	if (key === MCP_ENABLED_SETTING) {
		const lower = value.trim().toLowerCase();
		if (lower !== 'true' && lower !== 'false') {
			return {
				ok: false,
				message: `${MCP_ENABLED_SETTING} must be 'true' or 'false'`,
				allowed: ['true', 'false']
			};
		}
		return { ok: true, normalized: lower };
	}
	if (key === PANEL_HARNESS_SETTING) {
		const lower = value.trim().toLowerCase();
		if (!PANEL_HARNESS_VALUES.has(lower)) {
			return {
				ok: false,
				message: `Unknown panel harness ${JSON.stringify(raw)}`,
				allowed: [...PANEL_HARNESS_VALUES]
			};
		}
		return { ok: true, normalized: lower };
	}
	if (key === PACING_MIN_SECONDS_SETTING || key === PACING_MAX_SECONDS_SETTING) {
		const trimmed = value.trim();
		const num = Number(trimmed);
		if (!Number.isFinite(num) || num < 0) {
			return {
				ok: false,
				message: `${key} must be a non-negative number of seconds`,
				allowed: []
			};
		}
		return { ok: true, normalized: trimmed };
	}
	return { ok: true, normalized: value };
}

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

/**
 * Resolve the outbox send-mode from the raw `outbox_dry_run` setting row.
 *
 * Fail-safe polarity: anything other than the exact string `'false'` means
 * DRY RUN. Unset, misspelled, or corrupt → dry-run, never live sends. This
 * is the W4-U8 invariant the corrupt-setting test guards. Live toggling
 * persists `'false'` (live) / `'true'` (dry-run) through this same path, so
 * a crash mid-toggle always lands on the value already on disk — and a
 * restart re-reads it here.
 */
export function resolveOutboxDryRun(setting: string | undefined): boolean {
	return setting !== 'false';
}

/**
 * PANEL-S1 — the three panel rows as the boot path wants them. `harness` is
 * returned raw (not narrowed) so the single narrowing lives at the one call
 * site that can act on it, `isPanelHarnessId` in `createApp`; a row written
 * before a harness id was retired must be *reported* as unusable, not silently
 * dropped here.
 */
export function getPanelSettings(db: AppDatabase): {
	enabled: boolean;
	harness: string | null;
	model: string | null;
} {
	const model = getSetting(db, PANEL_MODEL_SETTING)?.trim();
	return {
		enabled: getSetting(db, PANEL_ENABLED_SETTING) === 'true',
		harness: getSetting(db, PANEL_HARNESS_SETTING)?.trim() || null,
		model: model ? model : null
	};
}

/**
 * MCPX-2 — the `/mcp` surface's own row, read fail-safe: only the exact string
 * `'true'` arms it, so a missing or corrupt row leaves a network surface closed
 * rather than open. Same polarity as `getPanelSettings().enabled`.
 *
 * Read directly from the DB (no process required) because MCPX-4's headless
 * entry point gates on this same call with the app not running.
 */
export function getMcpEnabledSetting(db: AppDatabase): boolean {
	return getSetting(db, MCP_ENABLED_SETTING) === 'true';
}

/** Settings API view: persisted values plus normalized runtime defaults. */
export function listEffectiveSettings(db: AppDatabase): Record<string, string> {
	const settings = listSettings(db);
	const pacing = getOutboxPacingSettings(db);
	const calendar = calendarConnectionPublicView(db);
	return {
		...redactCalendarSecrets(settings),
		[PACING_MIN_SECONDS_SETTING]: String(pacing.minSpacingMs / 1_000),
		[PACING_MAX_SECONDS_SETTING]: String(pacing.maxSpacingMs / 1_000),
		// Normalized polarity: only the explicit string 'false' means live sends.
		// Missing, misspelled, or corrupt stays 'true' (dry-run) — see
		// `resolveOutboxDryRun` and the W4-U8 corrupt-setting test.
		[OUTBOX_DRY_RUN_SETTING]: settings[OUTBOX_DRY_RUN_SETTING] === 'false' ? 'false' : 'true',
		// PANEL-S1: same fail-safe polarity — only the exact string 'true' turns
		// the panel on, so the Settings toggle renders off for a missing or
		// corrupt row rather than claiming a capability that is not running.
		[PANEL_ENABLED_SETTING]: settings[PANEL_ENABLED_SETTING] === 'true' ? 'true' : 'false',
		// MCPX-2: its own row, same fail-safe polarity, reported independently —
		// the external-MCP toggle must not render on just because the panel is.
		[MCP_ENABLED_SETTING]: settings[MCP_ENABLED_SETTING] === 'true' ? 'true' : 'false',
		// Calendar: public fields only. The encrypted app password never leaves
		// the process — see redactCalendarSecrets / getCalendarCredentials.
		...calendar
	};
}
