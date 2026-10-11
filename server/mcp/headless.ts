import { existsSync } from 'node:fs';
import type { ActionResult } from '../actions/index.js';
import { draftChat, type AgentDraftHooks } from '../agent/drafter.js';
import type { Memory } from '../agent/memory/memory.js';
import { NullMemory } from '../agent/memory/null-memory.js';
import { refineDraft } from '../agent/refiner.js';
import { EventBus } from '../api/events.js';
import type { RoutesDeps } from '../api/routes.js';
import { createDraftProvider } from '../providers/index.js';
import {
	createDefaultProviderDiscovery,
	providerFactoryOptionsFromDiscovery
} from '../providers/discovery.js';
import type { DraftProvider } from '../providers/provider.js';
import { getChat } from '../store/chats.js';
import {
	codeSchemaVersion,
	getDatabasePath,
	openDatabase,
	readSchemaVersion,
	type AppDatabase
} from '../store/db.js';
import { getDraft } from '../store/drafts.js';
import { listSettings } from '../store/settings.js';
import type { DraftTextSource } from '../../shared/approval-hash.js';
import {
	DEFAULT_DRAFT_PROVIDER,
	normalizeDraftProviderName,
	type DraftProviderName
} from '../../shared/providers.js';

/**
 * A startup refusal: one line for stderr, then exit 1. Never carries the token
 * and never carries a stack.
 */
export class HeadlessRefusal extends Error {}

export type HeadlessRuntime = {
	db: AppDatabase;
	deps: RoutesDeps;
	close(): void;
};

/**
 * How long a headless statement waits behind the desktop app's writer before
 * giving up. WAL permits multi-process access, but Baileys ingest writes
 * continuously while the app is up, and the first proposal written alongside it
 * would otherwise fail with `SQLITE_BUSY` on a lock that clears in milliseconds.
 */
export const HEADLESS_BUSY_TIMEOUT_MS = 5_000;

/**
 * Open the owner's database read-write WITHOUT migrating it, refusing rather
 * than touching a schema this build does not match.
 *
 * Order is forced by preconditions, not by preference:
 *   1. the database file must already exist — `openDatabase` would otherwise
 *      CREATE one (plus its WAL) in a directory the owner never paired, and the
 *      version query would then fail with `no such table`;
 *   2. open with `migrate: false`;
 *   3. compare the recorded high-water mark against this build's;
 *   4. only then read `mcp_enabled` — a setting read out of a schema that does
 *      not match this code is not a setting worth trusting.
 *
 * A refusal must leave the database as it found it. Steps 1–3 write no rows and
 * create no tables; opening a SQLite file does touch its WAL, which is why the
 * regression test asserts the recorded version and table set are unchanged
 * rather than asserting byte-level immutability.
 */
export function openHeadlessDatabase(dataDir: string): AppDatabase {
	const dbPath = getDatabasePath({ dataDir });
	if (!existsSync(dbPath)) {
		throw new HeadlessRefusal(
			`whatsagent: no WhatsAgent data at ${dataDir}. Open the app and pair once, or pass --data-dir.`
		);
	}

	const db = openDatabase({ dataDir, migrate: false });
	db.pragma(`busy_timeout = ${HEADLESS_BUSY_TIMEOUT_MS}`);

	const recorded = readSchemaVersion(db);
	const expected = codeSchemaVersion();
	if (recorded < expected) {
		db.close();
		throw new HeadlessRefusal(
			'whatsagent: this database needs an upgrade. Launch WhatsAgent once so it can migrate, then retry.'
		);
	}
	if (recorded > expected) {
		db.close();
		throw new HeadlessRefusal(
			'whatsagent: your WhatsAgent app is newer than this entry point. Update the path in your MCP config.'
		);
	}
	return db;
}

/**
 * Resolve the configured draft provider name the way `startServer` does,
 * reimplemented here rather than imported.
 *
 * `resolveBootProvider` lives in `server/index.ts`, and importing that module
 * would pull `WhatsAppConnection` — and therefore Baileys — into this entry
 * point's graph. The whole no-second-socket invariant is an import-graph fact;
 * six lines of duplication is the price of keeping it one.
 */
function resolveProviderName(settings: Readonly<Record<string, string>>): DraftProviderName {
	const raw = settings.provider;
	if (raw === undefined || raw.trim() === '') return DEFAULT_DRAFT_PROVIDER;
	return normalizeDraftProviderName(raw);
}

/**
 * One explicit headless generation, including the rate-limit backoff the
 * scheduler applies in `#run`.
 *
 * `draftChat` does not throw on `rate_limit`. It deletes the row and returns
 * `{ kind: 'rate_limited' }`. Treating that return as done leaves the draft
 * gone. Each such result waits `retryAfterMs` and calls again — one follow-up
 * per result, the same reschedule the scheduler arms with `#schedule`. The
 * loop stops when the row is approved or already drafting, and on every other
 * result (`ready`, `failed`, `no_reply_needed`, …). A rate limit is not one of
 * those endings.
 */
async function draftHeadlessChat(run: {
	db: AppDatabase;
	provider: DraftProvider;
	providerName: string;
	memory: Memory;
	chatJid: string;
	requestedBy: DraftTextSource;
	hooks: AgentDraftHooks;
}): Promise<void> {
	for (;;) {
		const row = getDraft(run.db, run.chatJid);
		if (row && (row.status === 'approved' || row.status === 'drafting')) return;
		const result = await draftChat({
			db: run.db,
			provider: run.provider,
			providerName: run.providerName,
			memory: run.memory,
			chatJid: run.chatJid,
			ownerRequested: true,
			requestedBy: run.requestedBy,
			hooks: run.hooks
		});
		if (result.kind !== 'rate_limited') return;
		await new Promise<void>((resolve) => {
			setTimeout(resolve, result.retryAfterMs);
		});
	}
}

/**
 * `RoutesDeps` for a process with no WhatsApp channel and no window.
 *
 * Present: `db`, a subscriber-less `EventBus` (emits go nowhere, which is
 * correct — there is nothing to notify), a permanently-disconnected connection
 * status, `NullMemory` so headless never needs Docker, and drafting.
 *
 * Absent, deliberately: `downloadMedia`, `deepenHistory`, `wakeOutbox`,
 * `setOutboxDryRun`, `applyPanelSettings`, `panelSession`, `mcp`. Every action
 * that needs one already null-checks it and returns a clean error, so the tool
 * list stays identical between modes and the refusal is a runtime answer rather
 * than a missing tool.
 */
export async function createHeadlessDeps(
	db: AppDatabase,
	dataDir: string,
	overrides: { provider?: DraftProvider } = {}
): Promise<RoutesDeps> {
	const events = new EventBus();
	const settings = listSettings(db);
	const providerName = resolveProviderName(settings);
	const memory = new NullMemory();

	let provider = overrides.provider;
	if (!provider) {
		let factoryOptions = {};
		try {
			factoryOptions = providerFactoryOptionsFromDiscovery(
				await createDefaultProviderDiscovery().snapshot()
			);
		} catch {
			// Same degradation as `startServer`: a failed probe means bare CLI names
			// off PATH, not "drafting is off".
		}

		try {
			provider = createDraftProvider({ ...settings, provider: providerName }, factoryOptions);
		} catch {
			// No provider → `generate-draft` / `refine-draft` return their existing
			// 503, exactly as they do in the app when the provider fails to build.
		}
	}

	return {
		db,
		events,
		getConnectionStatus: () => ({ state: 'disconnected', qr: null }),
		dataDir,
		port: 0,
		memory,
		refineDraft: provider
			? (request) =>
					refineDraft(
						{
							db,
							provider,
							providerName,
							onDraftUpdated: (draft) => events.emit({ type: 'draft-updated', draft })
						},
						request
					)
			: undefined,
		/**
		 * Owner-requested generation without a `DraftScheduler`.
		 *
		 * The scheduler is debounce-and-ingest machinery: it exists to react to
		 * inbound messages and to coalesce bursts. There is no ingest in this
		 * process and never will be, so building one would add a timer wheel and
		 * a concurrency limiter around a single explicit request. The gates that
		 * DO matter — R8's 1:1 restriction and "never regenerate under an
		 * approved or in-flight draft" — are restated here, and `draftChat`
		 * re-enforces R8 itself on the owner-requested branch.
		 *
		 * The seam stays synchronous: `true` means accepted, and the caller
		 * re-reads the draft row. The run itself awaits `draftChat` and, on
		 * `rate_limited`, waits and tries again. That result is not success.
		 */
		generateDraft: provider
			? (chatJid, requestedBy) => {
					const chat = getChat(db, chatJid);
					if (!chat || chat.kind !== '1:1') return false;
					const draft = getDraft(db, chatJid);
					if (draft && (draft.status === 'approved' || draft.status === 'drafting')) {
						return false;
					}
					void draftHeadlessChat({
						db,
						provider,
						providerName,
						memory,
						chatJid,
						requestedBy: requestedBy ?? 'system',
						hooks: {
							onDraftUpdated: (updated) =>
								events.emit({ type: 'draft-updated', draft: updated })
						}
					}).catch((error: unknown) => {
						console.error(
							'[mcp] headless draft failed',
							error instanceof Error ? error.message : 'error'
						);
					});
					return true;
				}
			: undefined
	};
}

/** Tools whose dep-absent 503 is caused by the app being closed, not by config. */
const NEEDS_LIVE_APP = new Set(['load-media', 'deepen-history']);

/**
 * Name the cause on results that would otherwise read as a configuration
 * problem, and tell the truth about focus.
 *
 * Done here rather than in the action definitions because the actions are
 * shared with the in-app surfaces, where none of this is true. `surface.ts`
 * never routes a 403 through an annotator, so nothing below can touch the
 * dispatcher's caller-policy refusal — R9's enforcement point.
 */
export function annotateHeadlessResult(name: string, result: ActionResult): ActionResult {
	if (result.kind === 'error' && result.status === 503 && NEEDS_LIVE_APP.has(name)) {
		return {
			...result,
			error: `${result.error} — requires the WhatsAgent app to be open.`
		};
	}
	if (result.kind === 'json' && name === 'open-chat' && result.status === 200) {
		return {
			...result,
			body: {
				...(result.body as Record<string, unknown>),
				focused: false,
				note: 'WhatsAgent is not running, so no window was focused. Do not tell the owner you opened the chat.'
			}
		};
	}
	return result;
}
