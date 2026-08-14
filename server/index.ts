import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DraftTextSource } from '../shared/approval-hash.js';
import { resolveDataDirOverride } from './data-dir.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Channel } from './channels/channel.js';
import { WhatsAppConnection } from './channels/whatsapp/connection.js';
import { downloadAndCacheMedia } from './channels/whatsapp/media.js';
import {
	createWhatsAppSendTransport,
	type WhatsAppSendTransport
} from './channels/whatsapp/send.js';
import {
	getDefaultDataDir,
	openDatabase,
	type AppDatabase,
	type OpenDatabaseOptions
} from './store/db.js';
import {
	createConnectionStatus,
	createIngestEventHooks,
	EventBus,
	type IngestEventHooks,
	type ServerEvent
} from './api/events.js';
import { chatViewFor } from './api/chat-view.js';
import { createRequestHandler, type RoutesDeps } from './api/routes.js';
import { createSessionState } from './api/session.js';
import { buildAllowedOrigins, validateOriginAndHost } from './api/security.js';
import { removeMcpRuntimeFile, writeMcpRuntimeFile } from './mcp/runtime.js';
import { createMcpSurface, isMcpEnabled, mcpOptionOverride, MCP_PATH } from './mcp/surface.js';
import { ensureMcpToken, removeMcpTokenFile } from './mcp/token.js';
import {
	createPanelHarness,
	isPanelHarnessId,
	PANEL_HARNESS_PROVIDERS,
	PanelSessionManager,
	type PanelHarness,
	type PanelHarnessId
} from './agent/panel/index.js';
import { actionRegistry } from './actions/index.js';
import { DraftScheduler } from './agent/scheduler.js';
import type { CalendarDigestSource } from './agent/drafter.js';
import type { Memory } from './agent/memory/memory.js';
import { NullMemory } from './agent/memory/null-memory.js';
import { createRuntimeMemory } from './agent/memory/hindsight.js';
import { bootstrapOwnerVoice } from './agent/voice.js';
import { refineDraft } from './agent/refiner.js';
import { OutboxPacer, type OutboxPacerOptions } from './outbox/pacer.js';
import { createCalendarClient } from './calendar/client.js';
import { fetchCalendarDigest } from './calendar/digest.js';
import { getCalendarCredentials, loadCalendarEncryptionKey } from './calendar/credentials.js';
import {
	createDefaultProviderDiscovery,
	providerFactoryOptionsFromDiscovery,
	type ProviderDiscovery
} from './providers/discovery.js';
import { createDraftProvider } from './providers/index.js';
import type { DraftProvider } from './providers/provider.js';
import {
	DEFAULT_DRAFT_PROVIDER,
	isDraftProviderName,
	normalizeDraftProviderName,
	type DraftProviderName
} from '../shared/providers.js';
import { getDraft } from './store/drafts.js';
import { getChat } from './store/chats.js';
import {
	getMcpEnabledSetting,
	getPanelSettings,
	getSetting,
	listSettings,
	OUTBOX_DRY_RUN_SETTING,
	PANEL_ENABLED_SETTING,
	PANEL_HARNESS_SETTING,
	resolveOutboxDryRun,
	setSetting
} from './store/settings.js';
import { cancelStaleDraftOutbox } from './store/outbox.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
export const HISTORY_SYNC_COMPLETE_SETTING = 'whatsapp_history_sync_complete';

export type CreateAppOptions = {
	db?: AppDatabase;
	dbOptions?: OpenDatabaseOptions;
	events?: EventBus;
	port?: number;
	host?: string;
	staticDir?: string | null;
	/** Optional WhatsApp (or other) channel — started when provided. */
	channel?: Channel;
	/** Override the D2 on-demand media fetch (tests). */
	downloadMedia?: (messageId: string) => Promise<unknown>;
	/** App-data dir (media cache root). Defaults to the DB's data dir. */
	dataDir?: string;
	/** Supplying a provider mounts the U8 scheduler into the live runtime. */
	draftProvider?: DraftProvider;
	providerName?: string;
	/**
	 * Active provider block describing what the running process actually built
	 * at boot — the normalized name, the raw persisted value when coercion
	 * happened, whether drafting is live, and the persisted model. Surfaced
	 * through `GET /api/providers` so the client never has to re-derive it
	 * (and a client-side "just saved" flag can't lie after reload).
	 */
	activeProvider?: {
		provider: DraftProviderName;
		coercedFrom: string | null;
		drafting: boolean;
		model: string | null;
	};
	/** Provider discovery used by `GET /api/providers`. Injected in tests. */
	providerDiscovery?: ProviderDiscovery;
	memory?: Memory;
	memoryReflectMs?: number;
	/** Short-interval retry of the memory's retain queue, independent of `memoryReflectMs`. Default 60 s. */
	memoryQueueDrainMs?: number;
	draftDebounceMs?: number;
	/**
	 * CAL-3 — optional schedule digest injected into the drafting prompt. When
	 * absent (the default), production wires a closure that reads credentials
	 * fresh on each call (so a freshly-saved App Password is picked up without
	 * a restart) and degrades to `null` when the calendar is not connected or
	 * Google is unreachable. Injected in tests to avoid hitting Google or the
	 * login keychain.
	 */
	calendarDigest?: CalendarDigestSource;
	/**
	 * CAL-3 — CalDAV fetch override for the production-wired digest source.
	 * Mirrors `RoutesDeps.calendarFetch` for the action path; tests inject
	 * fakes so the suite never hits Google.
	 */
	calendarFetch?: typeof fetch;
	/**
	 * CAL-3 — encryption key override for the production-wired digest source.
	 * Mirrors `RoutesDeps.calendarEncryptionKey`; tests inject a fixed key so
	 * the suite never touches the login keychain.
	 */
	calendarEncryptionKey?: Buffer;
	/** Exact from-me message ID permitted for one non-production drafting test. */
	/** Supplying a transport mounts and starts the sole WhatsApp send path. */
	outboxTransport?: WhatsAppSendTransport;
	outboxPacer?: Omit<OutboxPacerOptions, 'db' | 'transport' | 'onUpdated'>;
	/**
	 * PL-U2 — enable the `/mcp` surface. Off by default. Also enabled when
	 * `WHATSAGENT_MCP=1`. Token is minted only while enabled (CSPRNG →
	 * `{dataDir}/mcp.token` at 0600). Pass `{ enabled: true, token }` in tests.
	 */
	mcp?: boolean | { enabled?: boolean; token?: string };
	/**
	 * PL-U7 — run the agent panel with this harness. Off by default. This is the
	 * DEVELOPER path; owners turn the panel on from Settings (PANEL-S1), which
	 * writes `panel_enabled` / `panel_harness` / `panel_model` instead. An
	 * explicit option here wins over those rows.
	 *
	 * THE MCP RELATIONSHIP, decided rather than left implicit: the panel needs
	 * `/mcp`, and this option does NOT switch it on — a caller passing an object
	 * literal is a developer who can pass `mcp: true` in the same breath, and the
	 * PL-U7 rule that no code path opens a network surface behind the caller's
	 * back is worth keeping for them. The settings rows are the deliberate
	 * exception: an owner ticking "enable the agent panel" HAS explicitly opted
	 * in, so `createApp` mints the surface for them (see `resolvePanelConfig`).
	 * With MCP off the panel reports itself unavailable (`GET /api/agent/status`
	 * `available: false`, and `agent-turn` 503s) and the composer stays visibly
	 * disabled. It never silently no-ops.
	 *
	 * `harness` is `opencode` or `claude`. Direct-Ollama is not a panel option —
	 * it has no tool surface; Ollama models run inside opencode instead.
	 */
	panel?: {
		harness: PanelHarnessId;
		model?: string;
		timeoutMs?: number;
		/** Pre-built harness, for tests — skips spawning a real binary. */
		harnessImpl?: PanelHarness;
	};
};

export type App = {
	server: Server;
	db: AppDatabase;
	events: EventBus;
	ingestHooks: IngestEventHooks;
	port: number;
	host: string;
	url: string;
	/**
	 * Present only when MCP is enabled. Token is for the spawning harness /
	 * tests — never log it. Absent means `/mcp` 404s like an unknown route.
	 */
	mcp: { token: string; tokenPath: string } | null;
	start: () => Promise<void>;
	close: () => Promise<void>;
};

/**
 * Sending is opt-in: a fresh install and any malformed value remain in
 * dry-run. Only the explicit SQLite value `false` enables WhatsApp transport.
 * Re-exported from `store/settings.js` so existing callers (and tests) keep
 * importing it from here; the W4-U8 corrupt-setting test lives against this
 * polarity.
 */
export { resolveOutboxDryRun } from './store/settings.js';

/**
 * Re-exported so callers keep a single import site for boot-time resolution.
 * The implementation lives in `data-dir.ts` because the Electron main process
 * needs it before `app.whenReady()`, without loading this module's graph.
 */
export { resolveDataDirOverride } from './data-dir.js';

/**
 * Locate the adapter-static SPA output, whichever layout this module was loaded
 * from: `server/` in source, `dist/server/server/` compiled, or wherever a
 * packaged app bundle puts it. Counting `..` hops is what broke this before —
 * the compiled entry sits two levels deeper than the source one, so a fixed
 * depth is right for exactly one of them and silently serves nothing for the
 * other. Walk up instead and take the first ancestor that actually holds a
 * built SPA; fall back to the source-relative guess so the error surfaces as a
 * missing `build/` rather than a wrong path.
 */
function defaultStaticDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	let dir = here;
	for (;;) {
		const candidate = join(dir, 'build');
		if (existsSync(join(candidate, 'index.html'))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return join(here, '..', 'build');
}

/** PANEL-S1 — the panel configuration this process will actually run with. */
export type ResolvedPanelConfig = {
	harness: PanelHarnessId;
	model: string | null;
	timeoutMs?: number;
	harnessImpl?: PanelHarness;
	/**
	 * True when the owner's settings rows produced this, false for an explicit
	 * `options.panel`. Two things hang off the distinction: only a settings-born
	 * panel implies the MCP surface, and only a settings-born panel is
	 * reconciled when a row changes — the developer option is fixed for the life
	 * of the process by design.
	 */
	fromSettings: boolean;
};

/**
 * PANEL-S1 — reconcile the developer option with the owner's settings rows.
 *
 * Precedence is explicit-option-wins, so a `WHATSAGENT_MCP=1` dev run is never
 * silently re-pointed at whatever the owner last saved. An enabled row naming a
 * harness this build does not have is a configuration mistake, not a crash: it
 * returns no config and a warning the caller logs, which leaves the panel
 * reporting itself unavailable — and, unless something else armed the surface,
 * leaves `/mcp` closed rather than minting a token for tools nothing can reach.
 * Since MCPX-2 "something else" includes the owner's own `mcp_enabled` row: an
 * unusable panel no longer closes a surface external agents were promised.
 */
export function resolvePanelConfig(
	options: Pick<CreateAppOptions, 'panel'>,
	settings: { enabled: boolean; harness: string | null; model: string | null }
): { config: ResolvedPanelConfig | null; warning: string | null } {
	if (options.panel) {
		const explicit = options.panel;
		return {
			config: {
				harness: explicit.harness,
				model: explicit.model ?? null,
				...(explicit.timeoutMs === undefined ? {} : { timeoutMs: explicit.timeoutMs }),
				...(explicit.harnessImpl === undefined ? {} : { harnessImpl: explicit.harnessImpl }),
				fromSettings: false
			},
			warning: null
		};
	}
	if (!settings.enabled) return { config: null, warning: null };
	if (!isPanelHarnessId(settings.harness)) {
		return {
			config: null,
			warning:
				`[panel] ${PANEL_ENABLED_SETTING} is on but ${PANEL_HARNESS_SETTING} is ` +
				`${settings.harness === null ? 'not set' : JSON.stringify(settings.harness)} — ` +
				'expected "opencode" or "claude". The agent panel stays unavailable; ' +
				'pick a harness in Settings → Agent.'
		};
	}
	return {
		config: { harness: settings.harness, model: settings.model, fromSettings: true },
		warning: null
	};
}

/**
 * PANEL-S1 — the discovered absolute path for a harness binary, as a spreadable
 * fragment (`{}` when discovery has nothing, so the harness keeps its bare-name
 * default rather than being handed `undefined`).
 *
 * Shares `providerFactoryOptionsFromDiscovery` with the drafting providers on
 * purpose: the panel spawns the same two binaries, and a second resolution path
 * is a second thing to drift. Discovery failure is never fatal — a bare name on
 * PATH still works in a terminal-launched dev run, which is exactly where the
 * probe is most likely to be the thing that broke.
 */
async function discoveredHarnessCommand(
	discovery: ProviderDiscovery | undefined,
	harness: PanelHarnessId
): Promise<{ command?: string }> {
	if (!discovery) return {};
	try {
		const options = providerFactoryOptionsFromDiscovery(await discovery.snapshot());
		const command = options[PANEL_HARNESS_PROVIDERS[harness]]?.command;
		return command ? { command } : {};
	} catch (err) {
		console.warn(`[panel] provider discovery failed; spawning ${harness} off PATH`, err);
		return {};
	}
}

export function createApp(options: CreateAppOptions = {}): App {
	const requestedPort = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
	const host = options.host ?? DEFAULT_HOST;
	const db = options.db ?? openDatabase(options.dbOptions);
	const dataDir = options.dataDir ?? options.dbOptions?.dataDir ?? getDefaultDataDir();
	const events = options.events ?? new EventBus();
	const connection = createConnectionStatus();
	let historySyncComplete = getSetting(db, HISTORY_SYNC_COMPLETE_SETTING) === 'true';
	// D5 — derived pairing/sync view, pushed on every transition (QR rotations included).
	const session = createSessionState({
		initialSyncComplete: historySyncComplete,
		onChange: (view) => events.emit({ type: 'session', session: view })
	});
	const ingestHooks = createIngestEventHooks(events, db);
	const memory: Memory = options.memory ?? new NullMemory();
	// CAL-3 — the schedule digest source for the drafting prompt. Production
	// reads credentials fresh on each call (so a freshly-saved App Password is
	// picked up without a restart) and degrades to `null` when the calendar is
	// not connected or Google is unreachable. `fetchCalendarDigest` swallows
	// every failure, and `buildDraftInput` wraps the call in its own try/catch
	// too — two layers, because a bug in either must not reach the core loop.
	const calendarDigest: CalendarDigestSource = options.calendarDigest ?? (() => {
		const creds = getCalendarCredentials(
			db,
			options.calendarEncryptionKey ?? loadCalendarEncryptionKey()
		);
		if (!creds) return Promise.resolve(null);
		const client = createCalendarClient(
			creds,
			options.calendarFetch ? { fetch: options.calendarFetch } : {}
		);
		const nowMs = Date.now();
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
		return fetchCalendarDigest(client, nowMs, timeZone);
	});
	const scheduler = options.draftProvider
		? new DraftScheduler({
				db,
				provider: options.draftProvider,
				providerName: options.providerName ?? 'claude',
				memory,
				debounceMs: options.draftDebounceMs,
				calendarDigest,
				hooks: {
					onDraftUpdated: (draft) => events.emit({ type: 'draft-updated', draft }),
					onDraftRemoved: (chatJid) => events.emit({ type: 'draft-removed', chat_jid: chatJid }),
					onChatUpdated: (chat) => events.emit({ type: 'chat-updated', chat: chatViewFor(db, chat) }),
					onCalendarProposalUpdated: (proposal) =>
						events.emit({ type: 'calendar-proposal-updated', proposal })
				}
			})
		: undefined;
	const refiner = options.draftProvider
		? (request: Parameters<typeof refineDraft>[1]) =>
				refineDraft(
					{
						db,
						provider: options.draftProvider!,
						providerName: options.providerName ?? 'claude',
						onDraftUpdated: (draft) => events.emit({ type: 'draft-updated', draft })
					},
					request
				)
		: undefined;
	let schedulerStarted = false;
	const pacer = options.outboxTransport
		? new OutboxPacer({
				...options.outboxPacer,
				db,
				transport: options.outboxTransport,
				draftsPaused: true,
				onUpdated: (outbox) => {
					events.emit({ type: 'outbox-updated', outbox });
					const draft = getDraft(db, outbox.chat_jid);
					if (draft) events.emit({ type: 'draft-updated', draft });
					const chat = getChat(db, outbox.chat_jid);
					if (chat) events.emit({ type: 'chat-updated', chat: chatViewFor(db, chat) });
				}
			})
		: undefined;

	const downloadMedia =
		options.downloadMedia ??
		(options.channel
			? (messageId: string) => downloadAndCacheMedia(db, messageId, { dataDir })
			: undefined);
	const staticDir =
		options.staticDir === null
			? undefined
			: (options.staticDir ?? defaultStaticDir());

	let listeningPort = requestedPort;
	const startedAt = Date.now();

	const getAllowedOrigins = () => buildAllowedOrigins(listeningPort);

	const routeDeps: RoutesDeps = {
		db,
		events,
		getConnectionStatus: connection.get,
		getSessionStatus: session.get,
		regeneratePairing: options.channel
			? async () => {
					const channel = options.channel!;
					await channel.stop();
					// After `logged_out` the stored session is dead. A channel still
					// holding it will not offer a fresh QR, so forget it first.
					if (session.get().status === 'logged_out') await channel.resetAuth?.();
					await channel.start();
				}
			: undefined,
		dataDir,
		downloadMedia,
		staticDir,
		port: requestedPort,
		getAllowedOrigins,
		nextDraftJitterMs: pacer ? () => pacer.jitterMs() : undefined,
		wakeOutbox: pacer ? () => pacer.wake() : undefined,
		setOutboxDryRun: pacer ? (dryRun: boolean) => pacer.setDryRun(dryRun) : undefined,
		memory,
		refineDraft: refiner,
		// Owner-triggered generation shares the scheduler's queue and hooks, so a
		// manual run cancels any pending debounce for the chat rather than racing it.
		generateDraft: scheduler
			? (chatJid: string, requestedBy?: DraftTextSource) =>
					// An explicit `undefined` hits the default parameter, so the seam's
					// optional argument and the scheduler's default line up with no
					// branch in between.
					scheduler.generate(chatJid, requestedBy)
			: undefined,
		deepenHistory: options.channel?.deepenHistory
			? (chatJid, count) => options.channel!.deepenHistory!(chatJid, count)
			: undefined,
		// NEWCHAT-1 — `start-chat` refuses to create a chat for a number it cannot
		// confirm is on WhatsApp, so without this line the action is permanently
		// dep-absent in production and the feature does not exist outside its
		// tests. Absent when no channel is attached, which is the honest state:
		// the check needs a live socket.
		checkRegistered: options.channel?.checkRegistered
			? (jid) => options.channel!.checkRegistered!(jid)
			: undefined,
		activeProvider: options.activeProvider,
		providerDiscovery: options.providerDiscovery
	};

	/**
	 * MCP is off by default. The token is minted only while enabled — an unused
	 * token file would be pure attack surface.
	 *
	 * PANEL-S1 CHANGED THE THIRD INPUT. This used to be process-scoped only
	 * (`options.mcp` or `WHATSAGENT_MCP=1`), explicitly "not a settings row the
	 * SPA can flip by accident". A settings row can now switch it on — but only
	 * the `panel_enabled` row, and only once it names a usable harness, which is
	 * why the surface is resolved *after* the panel config rather than before.
	 * That is still an explicit opt-in, just an owner-facing one: the panel is
	 * unusable without the surface, so a toggle that enabled the panel and left
	 * `/mcp` closed would be a toggle that does nothing. The accident this
	 * comment guarded against was a *generic* settings write reaching a network
	 * surface; `set-setting` remains frontend-only, so the agent still cannot
	 * enable its own tools.
	 *
	 * Precedence: explicit option, else env, else the row.
	 */
	let mcpInfo: { token: string; tokenPath: string } | null = null;
	let panelSession: PanelSessionManager | undefined;
	/**
	 * What the running panel was built from, so a reconcile can tell "already
	 * running this" from "running something else". `null` whenever no panel is
	 * armed.
	 */
	let armedPanel: ResolvedPanelConfig | null = null;

	/**
	 * PL-U7 — the panel runtime, only when MCP is on. See
	 * `CreateAppOptions.panel` for why the panel option does not enable MCP itself.
	 *
	 * The harness is built lazily (on the first turn) so it can read the port the
	 * server actually bound: `port: 0` is the normal case in tests, and the MCP
	 * URL written into the harness config has to be the listening port, not the
	 * requested one. The same laziness is what lets PANEL-S2 arm a panel under a
	 * live process: the token this closes over is the one minted for the surface
	 * that is open right now, and a rebuild starts from a fresh, unbuilt harness.
	 */
	function buildPanelSession(config: ResolvedPanelConfig, token: string): PanelSessionManager {
		const discovery = options.providerDiscovery;
		let built: PanelHarness | undefined = config.harnessImpl;
		const harness: PanelHarness = {
			get id() {
				return config.harness;
			},
			run(turn, signal) {
				// An async generator so the first turn can AWAIT discovery and still
				// hand back an AsyncIterable synchronously — the laziness above is
				// about the bound port, and resolving the binary has the same shape:
				// it must not run at boot, and it must run exactly once.
				return (async function* () {
					if (!built) {
						built = createPanelHarness({
							harness: config.harness,
							port: listeningPort,
							token,
							registry: actionRegistry,
							...(config.model === null ? {} : { model: config.model }),
							...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
							...(await discoveredHarnessCommand(discovery, config.harness))
						});
					}
					yield* built.run(turn, signal);
				})();
			}
		};
		return new PanelSessionManager({ events, harness });
	}

	/**
	 * PANEL-S2 — bring the running panel and the `/mcp` surface in line with the
	 * settings rows as they are RIGHT NOW. The single arming path: boot calls it
	 * from the cold state and `set-setting` calls it again on every panel row
	 * write, so a surface armed live is identical to one armed at boot by
	 * construction rather than by inspection — same mint, same 0600 file, same
	 * Host+bearer validation, because it is the same three lines.
	 *
	 * Mutating `routeDeps` in place is what makes this take effect immediately:
	 * `routes.ts` reads `deps.mcp` and `deps.panelSession` per request, so the
	 * very next one sees the new answer. That is the same mechanism the outbox
	 * dry-run flip already uses; PANEL-S1's "restart to apply" was caution, not a
	 * constraint.
	 *
	 * Order on the way down is load-bearing: cancel the turn, then close the
	 * doors, then delete the token. A harness process must never outlive the
	 * toggle that authorized it, and it holds the token it was spawned with.
	 */
	function reconcilePanelRuntime(): void {
		const { config, warning } = resolvePanelConfig(options, getPanelSettings(db));
		if (warning) console.warn(warning);
		// MCPX-2 — three terms, in precedence order. An explicit `mcp:` answer
		// short-circuits everything (`?? `). Otherwise the env flag, the owner's
		// own `mcp_enabled` row, or a settings-born panel each arm it: panel-on
		// IMPLIES mcp-on because the panel has no tools without the surface, but
		// the implication does not run backwards — turning the panel off leaves
		// `mcp_enabled` alone, which is the whole point of the second row.
		const mcpEnabled =
			mcpOptionOverride(options) ??
			(isMcpEnabled(options) ||
				getMcpEnabledSetting(db) ||
				(config?.fromSettings ?? false));

		// Tear down when the panel is going away, losing its tools, or changing
		// what it runs. A rebuild cancels too: leaving the old manager alive would
		// orphan a turn nothing can cancel while the new one reports itself idle
		// and accepts a second concurrent one.
		const unchanged =
			config !== null &&
			armedPanel !== null &&
			config.harness === armedPanel.harness &&
			config.model === armedPanel.model;
		if (panelSession && (!config || !mcpEnabled || !unchanged)) {
			panelSession.cancel();
			panelSession = undefined;
			armedPanel = null;
			routeDeps.panelSession = undefined;
		}

		// The surface follows `mcpEnabled`, never `panel_enabled` directly: a
		// `WHATSAGENT_MCP=1` run keeps its `/mcp` when the owner turns the panel
		// off, and an explicit `mcp: false` is never re-opened by a row.
		if (!mcpEnabled && mcpInfo) {
			routeDeps.mcp = undefined;
			mcpInfo = null;
			removeMcpTokenFile(dataDir);
		}
		if (mcpEnabled && !mcpInfo) {
			const override =
				typeof options.mcp === 'object' && typeof options.mcp.token === 'string'
					? options.mcp.token
					: undefined;
			const minted = ensureMcpToken(dataDir, override);
			// Always a fresh surface: it closes over its token, so reusing one
			// after a re-mint would validate bearers against a dead secret.
			routeDeps.mcp = createMcpSurface({
				deps: routeDeps,
				token: minted.token,
				tokenPath: minted.path
			});
			mcpInfo = { token: minted.token, tokenPath: minted.path };
		}

		if (config && mcpInfo && !panelSession) {
			panelSession = buildPanelSession(config, mcpInfo.token);
			armedPanel = config;
			routeDeps.panelSession = panelSession;
		} else if (config && !mcpInfo) {
			// Two ways to land here, and they need different advice: a developer who
			// passed `panel` without `mcp`, or a caller who explicitly shut the
			// surface while the owner's rows ask for a panel. The second is the
			// override working as intended, so it is stated as such rather than as a
			// mistake to fix.
			console.warn(
				config.fromSettings
					? '[panel] the agent panel is enabled in Settings but this process was started with the MCP surface explicitly off — the panel has no tools and reports itself unavailable.'
					: '[panel] agent panel requested but the MCP surface is off — the panel has no tools and will report itself unavailable. Pass `mcp: true` (or WHATSAGENT_MCP=1) alongside the explicit panel option; the Settings toggle enables both together.'
			);
		}

		syncMcpRuntimeFile();
	}

	/**
	 * MCPX-3 — the packaged app binds port 0 and the token rotates every launch,
	 * so an external agent has no static URL or credential. This file is the
	 * discovery seam Unit D reads. Token is account-adjacent: never log it.
	 *
	 * Disable (or a boot with MCP off) must remove, not leave a stale pointer
	 * at a dead process. Write only when the surface is armed; `listeningPort`
	 * is still the requested value until `server.on('listening')`.
	 *
	 * The file therefore NEVER carries `port: 0`, and a reader may treat it as
	 * dialable without checking. The packaged app requests port 0, so between
	 * `reconcilePanelRuntime()` and the listening handler the port is not yet
	 * known — and a `createApp` whose `start()` never runs would otherwise leave
	 * an undialable file on disk whose pid IS live, defeating the liveness
	 * check. Not writing is the honest state: no file means no reachable
	 * surface, which is exactly what a reader should conclude.
	 */
	function syncMcpRuntimeFile(): void {
		if (!mcpInfo || listeningPort === 0) {
			removeMcpRuntimeFile(dataDir);
			return;
		}
		writeMcpRuntimeFile(dataDir, {
			pid: process.pid,
			startedAt,
			host,
			port: listeningPort,
			url: `http://${host}:${listeningPort}${MCP_PATH}`,
			token: mcpInfo.token,
			dataDir
		});
	}

	reconcilePanelRuntime();

	/**
	 * PANEL-S2 — what `set-setting` calls after writing a runtime row (see
	 * `RUNTIME_SETTINGS` there).
	 *
	 * MCPX-2 REMOVED THE `if (options.panel) return;` OPT-OUT. It existed to stop
	 * an unrelated settings write from cancelling an in-flight dev turn, but with
	 * `mcp_enabled` in the set it would also make the owner's MCP toggle a no-op
	 * for the whole life of any process started with an explicit `panel` option.
	 *
	 * Safe because the dev turn cannot be cancelled by an unrelated write anyway.
	 * Teardown at the top of `reconcilePanelRuntime` is gated on
	 * `panelSession && (!config || !mcpEnabled || !unchanged)`, and:
	 *   - with an explicit `options.panel`, `resolvePanelConfig` returns the same
	 *     config every time, so `config` is never null and its harness/model
	 *     always match `armedPanel`;
	 *   - `panelSession` and `armedPanel` are assigned together and cleared
	 *     together, so whenever `panelSession` is set `armedPanel` is too and
	 *     `unchanged` is therefore true. (The plan said "`unchanged` is true"
	 *     unconditionally; it is not — with no session ever built `armedPanel` is
	 *     null and `unchanged` is false. The `panelSession &&` gate is what makes
	 *     the conclusion hold.)
	 * So the only thing that can tear a dev panel down here is `mcpEnabled`
	 * genuinely flipping — which now means the owner switched off a row that was
	 * the sole reason the surface was armed. That is the toggle working.
	 */
	routeDeps.applyPanelSettings = () => {
		reconcilePanelRuntime();
	};

	const handleRequest = createRequestHandler(routeDeps);

	const server = createServer((req, res) => {
		void handleRequest(req, res);
	});

	const wss = new WebSocketServer({ noServer: true });
	const sockets = new Set<WebSocket>();

	server.on('upgrade', (req, socket, head) => {
		const hostHeader = req.headers.host ?? `${host}:${listeningPort}`;
		const url = new URL(req.url ?? '/', `http://${hostHeader}`);
		if (url.pathname !== '/api/ws') {
			socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
			socket.destroy();
			return;
		}

		const check = validateOriginAndHost(req, getAllowedOrigins());
		if (!check.ok) {
			socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', (ws) => {
		sockets.add(ws);
		ws.send(
			JSON.stringify({
				type: 'connection',
				state: connection.get().state
			} satisfies ServerEvent)
		);
		// Snapshot the derived session immediately — a client that connects
		// mid-QR-rotation must not wait up to 20s for the next push.
		ws.send(JSON.stringify({ type: 'session', session: session.get() } satisfies ServerEvent));
		// W4-U8: snapshot the current send-mode so the topbar indicator and the
		// settings toggle render the right state before any WS event lands.
		const liveSendMode = getSetting(db, OUTBOX_DRY_RUN_SETTING) === 'false';
		ws.send(
			JSON.stringify({
				type: 'send-mode',
				live: liveSendMode,
				dry_run: !liveSendMode
			} satisfies ServerEvent)
		);
		const qr = connection.get().qr;
		if (qr) {
			ws.send(JSON.stringify({ type: 'pairing-needed', qr } satisfies ServerEvent));
		}
		ws.on('close', () => sockets.delete(ws));
	});

	const unsubscribeEvents = events.subscribe((event) => {
		const payload = JSON.stringify(event);
		for (const ws of sockets) {
			if (ws.readyState === ws.OPEN) ws.send(payload);
		}
	});

	let channelUnsub: (() => void) | undefined;
	let started = false;
	let closing = false;
	let voiceBootstrap: Promise<void> | undefined;
	let reflectTimer: ReturnType<typeof setInterval> | undefined;
	let drainTimer: ReturnType<typeof setInterval> | undefined;

	function completeHistorySync(): void {
		if (voiceBootstrap) {
			if (schedulerStarted) scheduler?.start();
			return;
		}
		voiceBootstrap = bootstrapOwnerVoice(db, memory)
			.catch((error) => console.warn('[memory] voice bootstrap failed; continuing without it', error))
			.then(() => {
				if (closing || !scheduler) return;
				schedulerStarted = true;
				scheduler.start();
			});
	}

	server.on('listening', () => {
		const addr = server.address();
		if (addr && typeof addr !== 'string') {
			listeningPort = addr.port;
		}
		started = true;
		// The only place `listeningPort` is the OS-assigned port, not 0.
		syncMcpRuntimeFile();
	});

	async function start(): Promise<void> {
		if (started) return;
		closing = false;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(requestedPort, host, () => {
				server.off('error', reject);
				resolve();
			});
		});

		if (options.channel) {
			channelUnsub = options.channel.onEvent((event) => {
				// Every channel event feeds the D5 derivation, which emits `session`
				// itself via onChange. Transport events stay published as-is.
				session.applyChannelEvent(event);
				if (event.type === 'connection') {
					connection.setState(event.state);
					events.emit({ type: 'connection', state: event.state });
					if (event.state === 'connected') {
						pacer?.wake();
						if (historySyncComplete) {
							pacer?.setDraftsPaused(false);
							completeHistorySync();
						}
					} else {
						pacer?.setDraftsPaused(true);
					}
				} else if (event.type === 'pairing-needed') {
					historySyncComplete = false;
					setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'false');
					connection.setQr(event.qr);
					events.emit({ type: 'pairing-needed', qr: event.qr });
				} else if (event.type === 'sync-progress') {
					const view = session.get().sync;
					events.emit({
						type: 'sync-progress',
						phase: 'history',
						chatsSynced: view.chatsSynced,
						messagesSynced: view.messagesSynced,
						complete: view.complete
					});
					if (event.isLatest) {
						historySyncComplete = true;
						setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'true');
						completeHistorySync();
						pacer?.setDraftsPaused(false);
					}
				} else if (event.type === 'logged-out') {
					historySyncComplete = false;
					setSetting(db, HISTORY_SYNC_COMPLETE_SETTING, 'false');
				} else if (event.type === 'message-committed') {
					ingestHooks.onMessageIngested(event.message);
					if (!event.message.from_me) {
						for (const outbox of cancelStaleDraftOutbox(
							db,
							event.message.chat_jid,
							event.message.id
						)) {
							events.emit({ type: 'outbox-updated', outbox });
						}
					}
					if (schedulerStarted) scheduler?.onMessage(event.message);
				} else if (event.type === 'message-updated') {
					ingestHooks.onMessageUpdated(event.message);
				} else if (event.type === 'chats-merged') {
					// Survivor first, then the removal: a client that drops `from` on
					// receipt must already have the row it is about to be pointed at.
					const survivor = getChat(db, event.to);
					if (survivor) {
						events.emit({ type: 'chat-updated', chat: chatViewFor(db, survivor) });
					}
					events.emit({ type: 'chat-removed', jid: event.from, merged_into: event.to });
				}
			});
			await options.channel.start();
		}
		pacer?.start();
		const reflectMs = options.memoryReflectMs ?? 6 * 60 * 60 * 1_000;
		if (reflectMs > 0) {
			const sync = () =>
				void memory.reflect().catch((error) => console.warn('[memory] reflection failed', error));
			// `setInterval` does not fire immediately, and this call is now the voice mirror's
			// heartbeat — without a run at start, a restart would draft against files up to
			// one full interval stale.
			sync();
			reflectTimer = setInterval(sync, reflectMs);
		}
		// Short-interval queue retry: a cold-start retain timeout sets the memory's offline
		// window, and without this the queue sits until the next retain or the 6-hourly
		// reflect — one 2 s timeout parked the whole voice bootstrap for six hours. The
		// memory's `drain` is a no-op when offline or when the queue is empty.
		const drainMs = options.memoryQueueDrainMs ?? 60_000;
		if (drainMs > 0 && typeof memory.drain === 'function') {
			const drain = () =>
				void memory.drain!().catch((error) => console.warn('[memory] queue drain failed', error));
			drainTimer = setInterval(drain, drainMs);
		}
	}

	async function close(): Promise<void> {
		closing = true;
		removeMcpRuntimeFile(dataDir);
		channelUnsub?.();
		if (reflectTimer) clearInterval(reflectTimer);
		reflectTimer = undefined;
		if (drainTimer) clearInterval(drainTimer);
		drainTimer = undefined;
		scheduler?.stop();
		pacer?.stop();
		// Kills any in-flight harness process — a turn must not outlive the app.
		await panelSession?.stop();
		session.dispose();
		if (options.channel) await options.channel.stop();
		unsubscribeEvents();
		for (const ws of sockets) ws.close();
		sockets.clear();
		await new Promise<void>((resolve) => {
			wss.close(() => resolve());
		});
		if (started) {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
		db.close();
		started = false;
	}

	return {
		server,
		db,
		events,
		ingestHooks,
		host,
		get port() {
			return listeningPort;
		},
		get url() {
			return `http://${host}:${listeningPort}`;
		},
		// PANEL-S2: a getter, not a snapshot — the surface can be armed and
		// disarmed under a live process, so a value captured here would report
		// `null` for a panel the owner switched on a moment ago.
		get mcp() {
			return mcpInfo;
		},
		start,
		close
	};
}

/**
 * macOS is the supported platform (login keychain for WhatsApp auth encryption).
 * Fail at process start — before opening the DB or pairing — so Linux/Windows
 * users get a clear reason instead of a mid-pairing keychain error.
 * Exported for unit tests; `platform` is injectable so tests do not depend on
 * the host OS.
 */
export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
	if (platform === 'darwin') return;
	throw new Error(
		'whatsagent requires macOS.\n' +
			'\n' +
			'WhatsApp auth credentials are encrypted with a key stored in the macOS\n' +
			'login keychain. Other platforms are not supported.\n'
	);
}

/**
 * Resolve the draft provider used at process boot. Never throws — a typo or
 * trailing space in SQLite must not brick startup. Returns the normalized name
 * both `createDraftProvider` and the scheduler label must share, plus the raw
 * string when coercion happened so the caller can log a warning.
 */
export function resolveBootProvider(
	settings: Readonly<Record<string, string>>
): { name: DraftProviderName; coercedFrom: string | null } {
	const raw = settings.provider;
	if (raw === undefined) {
		return { name: DEFAULT_DRAFT_PROVIDER, coercedFrom: null };
	}
	if (typeof raw === 'string' && raw.trim() === '') {
		return { name: DEFAULT_DRAFT_PROVIDER, coercedFrom: null };
	}
	const name = normalizeDraftProviderName(raw);
	if (isDraftProviderName(raw) && raw === name) {
		return { name, coercedFrom: null };
	}
	return { name, coercedFrom: raw };
}

export type StartServerOptions = {
	/**
	 * Explicit app-data directory. Electron passes `app.getPath('userData')`
	 * here. When omitted, the env/argv override applies, and failing that the
	 * platform default — which is the only branch the worktree guard protects.
	 */
	dataDir?: string;
	/** Explicit SPA directory. Preferred over `defaultStaticDir()`'s search. */
	staticDir?: string;
	port?: number;
	host?: string;
};

/**
 * Build and start the full runtime: database, WhatsApp channel, provider,
 * memory, outbox. Exported so the Electron main process can start the exact
 * same server in-process rather than maintaining a second wiring of it.
 */
export async function startServer(options: StartServerOptions = {}): Promise<App> {
	assertSupportedPlatform();
	const dataDir = options.dataDir ?? resolveDataDirOverride();
	const db = openDatabase(dataDir === undefined ? {} : { dataDir });
	const settings = listSettings(db);
	const channel = new WhatsAppConnection(db);
	const { name: providerName, coercedFrom } = resolveBootProvider(settings);
	if (coercedFrom !== null) {
		console.warn(
			`Invalid draft provider setting ${JSON.stringify(coercedFrom)}; falling back to ${providerName}`
		);
	}
	// Both factory and scheduler label must see the same normalized name, or
	// drafts get stamped with a provider that is not the one running.
	const bootSettings = { ...settings, provider: providerName };

	const discovery = createDefaultProviderDiscovery();
	let factoryOptions = {};
	try {
		const snapshot = await discovery.snapshot();
		factoryOptions = providerFactoryOptionsFromDiscovery(snapshot);
	} catch (err) {
		console.warn('Provider discovery failed; drafting will use bare CLI names', err);
	}

	let draftProvider: DraftProvider | undefined;
	try {
		draftProvider = createDraftProvider(bootSettings, factoryOptions);
	} catch (err) {
		console.warn(
			`Draft provider ${JSON.stringify(providerName)} failed to initialize; drafting is off`,
			err
		);
	}

	// Memory (voice mirror files) must follow the same override, or a throwaway
	// run writes into the live data dir while the database sits elsewhere.
	const memory = createRuntimeMemory(settings, { dataDir: dataDir ?? getDefaultDataDir() });
	const dryRunSetting = getSetting(db, OUTBOX_DRY_RUN_SETTING);
	const app = createApp({
		db,
		dataDir: dataDir ?? getDefaultDataDir(),
		staticDir: options.staticDir,
		port: options.port,
		host: options.host,
		channel,
		draftProvider,
		providerName,
		activeProvider: {
			provider: providerName,
			coercedFrom,
			drafting: draftProvider !== undefined,
			model: settings.provider_model ?? null
		},
		providerDiscovery: discovery,
		memory,
		outboxTransport: createWhatsAppSendTransport(() => channel.getSendSocket()),
		outboxPacer: {
			dryRun: resolveOutboxDryRun(dryRunSetting)
		}
	});
	await app.start();
	// Log the data dir, not just the URL: when an override is in play this line
	// is the only visible proof of *which* database the process actually opened.
	console.log(`whatsagent data dir: ${dataDir ?? getDefaultDataDir()}${dataDir ? ' (override)' : ''}`);
	console.log(`whatsagent listening on ${app.url} (loopback only)`);
	return app;
}

async function main(): Promise<void> {
	const app = await startServer();
	const shutdown = async () => {
		console.log('shutting down…');
		await app.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());
}

const entry = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (
	typeof entry === 'string' &&
	(thisFile === entry ||
		entry.replace(/\\/g, '/').endsWith('/server/index.ts') ||
		entry.replace(/\\/g, '/').endsWith('/server/index.js'))
) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
