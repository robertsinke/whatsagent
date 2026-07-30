import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { DraftTextSource } from '../../shared/approval-hash.js';
import type { AppDatabase } from '../store/db.js';
import { getChat, listChats } from '../store/chats.js';
import { getDraft } from '../store/drafts.js';
import { getMessage, listMessagesPage, type Message } from '../store/messages.js';
import { listOutbox } from '../store/outbox.js';
import { listOpenCancellationNotices } from '../store/cancellation-notices.js';
import { listPendingProposalsAll } from '../store/proposals.js';
import {
	getSetting,
	listEffectiveSettings,
	MEMORY_SETTING,
	OUTBOX_DRY_RUN_SETTING,
	PROVIDER_SETTING,
	PROVIDER_MODEL_SETTING
} from '../store/settings.js';
import type { Memory } from '../agent/memory/memory.js';
import type { RefinementAttempt, RefineDraftRequest } from '../agent/refiner.js';
import { VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import type { ConnectionStatus, EventBus } from './events.js';
import type { SessionView } from './session.js';
import {
	buildAllowedOrigins,
	isMutatingMethod,
	validateOriginAndHost,
	type AllowedOrigins
} from './security.js';
// `chatNeedsReply` lives with the view it feeds, so every emitter (REST *and*
// WebSocket) builds the same shape. Re-exported here because it was defined in
// this module first.
import { chatNeedsReply, toChatView } from './chat-view.js';
export { chatNeedsReply };
import { describeMedia, isMediaType, toMessageView } from './message-view.js';
import type { DiscoveredProvider } from '../providers/discovery.js';
import type { ProviderInfo, ProviderModelOption } from '../../shared/provider-types.js';
import { actionRegistry, dispatch } from '../actions/index.js';
import { writeActionResult } from '../actions/respond.js';
import { MCP_PATH, type McpSurface } from '../mcp/surface.js';

/**
 * Map a discovery {@link DiscoveredProvider} onto the shared {@link ProviderInfo}
 * shape that `GET /api/providers` returns. The two structs are aligned 1:1 so
 * the API does not define a third parallel set of fields — this is a literal
 * field-for-field copy with the model `source` narrowed to the shared union
 * (discovery only ever emits `source: 'live'`).
 */
function toProviderInfo(p: DiscoveredProvider): ProviderInfo {
	const models: ProviderModelOption[] = p.models.map((m) => ({
		value: m.value,
		label: m.label,
		source: 'live',
		...(m.note ? { note: m.note } : {})
	}));
	return {
		name: p.name,
		label: p.label,
		kind: p.kind,
		installed: p.installed,
		path: p.path,
		pathSource: p.pathSource,
		version: p.version,
		auth: p.auth,
		unavailableReason: p.unavailableReason,
		unavailableDetail: p.unavailableDetail,
		models,
		modelsLive: p.modelsLive,
		defaultModel: p.defaultModel,
		allowsCustomModel: true,
		probedAt: p.probedAt
	};
}

export type RoutesDeps = {
	db: AppDatabase;
	events: EventBus;
	getConnectionStatus: () => ConnectionStatus;
	/** D5 — derived view state for the pairing/sync surfaces. */
	getSessionStatus?: () => SessionView;
	/** Re-pair affordance for `qr_expired` / `logged_out`: restarts the channel. */
	regeneratePairing?: () => Promise<void>;
	/** App-data dir — media cache root (`{dataDir}/media/...`). */
	dataDir?: string;
	/** D2 — on-demand media fetch; absent when no channel is attached. */
	downloadMedia?: (messageId: string) => Promise<unknown>;
	/** Absolute path to adapter-static output (optional; API-only if omitted). */
	staticDir?: string;
	port: number;
	allowedOrigins?: AllowedOrigins;
	/** Prefer over static `allowedOrigins` when the listen port is ephemeral (0). */
	getAllowedOrigins?: () => AllowedOrigins;
	/** Pacer-owned jitter used when approved drafts enter the global schedule. */
	nextDraftJitterMs?: () => number;
	/** Wake the single-flight pacer after queue mutations. */
	wakeOutbox?: () => void;
	/**
	 * W4-U8: flip the pacer's live send-mode at runtime without a restart.
	 * The pacer remains the only sender; this only toggles whether it
	 * transmits. `true` = dry-run (safe default), `false` = live sends.
	 */
	setOutboxDryRun?: (dryRun: boolean) => void;
	/** Optional memory side effects; never participates in the outbox transaction. */
	memory?: Memory;
	/** Optional channel history deepener for thin voice samples. */
	deepenHistory?: (chatJid: string, count?: number) => Promise<unknown>;
	/** Preview-only draft refinement through the configured provider. */
	refineDraft?: (request: RefineDraftRequest) => Promise<RefinementAttempt>;
	/**
	 * W4-U15 — owner-triggered draft generation, queued on the draft scheduler.
	 * Returns false when the seam itself refused the request. Absent when no
	 * provider is configured. This never sends and never touches the outbox.
	 *
	 * `requestedBy` is the dispatching caller, recorded on the resulting row as
	 * `text_source`. Optional so existing one-argument test doubles stay
	 * assignable; the scheduler defaults it to `system`.
	 */
	generateDraft?: (chatJid: string, requestedBy?: DraftTextSource) => boolean;
	/**
	 * OSS-P2.4 — discovery used by `GET /api/providers`. Injected through
	 * `CreateAppOptions`; absent in tests that don't exercise the endpoint.
	 */
	providerDiscovery?: {
		snapshot(options?: { refresh?: boolean }): Promise<import('../providers/discovery.js').ProviderDiscoverySnapshot>;
		invalidate(): void;
	};
	/** What the running process built at boot — powers the `active` block. */
	activeProvider?: {
		provider: import('../../shared/providers.js').DraftProviderName;
		coercedFrom: string | null;
		drafting: boolean;
		model: string | null;
	};
	/**
	 * PL-U2 — MCP surface. Absent (the default) means the `/mcp` path is an
	 * unknown route (404). When present, Host+bearer auth replaces Origin for
	 * that path only; Host must still be loopback.
	 */
	mcp?: McpSurface;
	/**
	 * PL-U7 — the agent panel runtime. Injected rather than module-scoped so
	 * several `createApp()` instances in one test process cannot share
	 * single-flight state. Absent means the panel reports itself unavailable
	 * (503) rather than silently accepting turns that go nowhere.
	 */
	panelSession?: PanelSessionRuntime;
	/**
	 * PANEL-S2 — re-read the panel settings rows and arm, disarm, or rebuild the
	 * panel runtime and the `/mcp` surface to match. Called by `set-setting`
	 * after a `panel_*` write, exactly as the outbox dry-run key calls
	 * {@link setOutboxDryRun}, and it mutates the fields above on this same
	 * object — which is why the toggle takes effect on the next request rather
	 * than on the next launch.
	 *
	 * That this is reachable from a settings write is precisely why
	 * `set-setting` is frontend-only: an agent that could write `panel_enabled`
	 * could arm its own tool surface. Absent (the default) means a `RoutesDeps`
	 * built by hand in a test simply has no runtime to reconcile.
	 */
	applyPanelSettings?: () => void;
};

/**
 * The slice of `PanelSessionManager` the actions use. A structural type rather
 * than the class, so `routes.ts` does not pull the agent runtime's module graph
 * into every test that builds `RoutesDeps`.
 */
export type PanelSessionRuntime = {
	start: (text: string) => { sessionId: string; messageId: string; harness: string };
	cancel: () => boolean;
	status: () => {
		running: boolean;
		sessionId: string | null;
		messageId: string | null;
		harness: string | null;
	};
	/** PANEL-S3 — wipe history (and cancel any in-flight turn). */
	clearHistory: () => { cancelled: boolean; sessionId: string };
};

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.map': 'application/json'
};

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload)
	});
	res.end(payload);
}

function error(res: ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
	json(res, status, { error: message, ...extra });
}

async function dispatchAction(
	deps: RoutesDeps,
	res: ServerResponse,
	name: string,
	raw: unknown
): Promise<void> {
	const result = await dispatch(actionRegistry, name, raw, {
		caller: 'frontend',
		deps
	});
	writeActionResult(res, result, { json, error });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	if (chunks.length === 0) return undefined;
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw.trim()) return undefined;
	return JSON.parse(raw) as unknown;
}

function parsePositiveInt(value: string | null, fallback: number): number {
	if (value === null || value === '') return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function serveStatic(
	res: ServerResponse,
	staticDir: string,
	urlPath: string
): boolean {
	const decoded = decodeURIComponent(urlPath.split('?')[0] || '/');
	const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '');
	const candidate = normalize(join(staticDir, relative));
	if (!candidate.startsWith(staticDir + sep) && candidate !== staticDir) {
		error(res, 403, 'Forbidden');
		return true;
	}

	let filePath = candidate;
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		const fallback = join(staticDir, 'index.html');
		if (!existsSync(fallback)) return false;
		filePath = fallback;
	}

	const st = statSync(filePath);
	if (!st.isFile()) return false;

	const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
	res.writeHead(200, {
		'Content-Type': type,
		'Content-Length': st.size
	});
	createReadStream(filePath).pipe(res);
	return true;
}

export function createRequestHandler(deps: RoutesDeps) {
	const origins = (): AllowedOrigins =>
		deps.getAllowedOrigins?.() ??
		deps.allowedOrigins ??
		buildAllowedOrigins(deps.port);

	return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const method = (req.method ?? 'GET').toUpperCase();
		const host = req.headers.host ?? `127.0.0.1:${deps.port}`;
		const url = new URL(req.url ?? '/', `http://${host}`);
		const allowedOrigins = origins();

		if (method === 'OPTIONS') {
			res.writeHead(204, {
				'Access-Control-Allow-Origin': [...allowedOrigins][0] ?? '',
				'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				'Access-Control-Max-Age': '86400'
			});
			res.end();
			return;
		}

		// MCP path: when enabled, Host+bearer (additional auth path). When
		// disabled, fall through so the path 404s like any unknown route —
		// never 401, which would advertise the feature.
		if (url.pathname === MCP_PATH) {
			if (deps.mcp) {
				try {
					await deps.mcp.handle(req, res);
				} catch (err) {
					console.error('[mcp]', err instanceof Error ? err.message : err);
					if (!res.headersSent) error(res, 500, 'Internal server error');
				}
				return;
			}
		}

		if (isMutatingMethod(method)) {
			const check = validateOriginAndHost(req, allowedOrigins);
			if (!check.ok) {
				error(res, 403, 'Forbidden', { reason: check.reason });
				return;
			}
		}

		try {
			if (url.pathname.startsWith('/api/')) {
				await handleApi(deps, req, res, method, url);
				return;
			}

			if (deps.staticDir && (method === 'GET' || method === 'HEAD')) {
				if (serveStatic(res, deps.staticDir, url.pathname)) return;
			}

			error(res, 404, 'Not found');
		} catch (err) {
			if (err instanceof SyntaxError) {
				error(res, 400, 'Invalid JSON body');
				return;
			}
			console.error('[api]', err);
			error(res, 500, 'Internal server error');
		}
	};
}

/**
 * D2 media endpoints.
 * - `POST` fetches on demand via the `load-media` action.
 * - `GET` streams cached bytes for the lightbox / inline audio / OS handoff.
 */
async function handleMedia(
	deps: RoutesDeps,
	res: ServerResponse,
	method: string,
	messageId: string
): Promise<void> {
	if (method === 'POST') {
		await dispatchAction(deps, res, 'load-media', { messageId });
		return;
	}

	const message = getMessage(deps.db, messageId);
	if (!message) {
		error(res, 404, 'Message not found', { id: messageId });
		return;
	}
	if (!isMediaType(message.type)) {
		error(res, 400, 'Message has no media', { id: messageId, type: message.type });
		return;
	}

	if (method === 'GET' || method === 'HEAD') {
		if (!message.media_ref || message.media_state !== 'ready' || !deps.dataDir) {
			error(res, 409, 'Media not downloaded', { id: messageId, state: message.media_state });
			return;
		}
		const filePath = normalize(join(deps.dataDir, message.media_ref));
		if (!filePath.startsWith(join(deps.dataDir, 'media') + sep) || !existsSync(filePath)) {
			error(res, 404, 'Cached media missing', { id: messageId });
			return;
		}
		const st = statSync(filePath);
		res.writeHead(200, {
			'Content-Type': mediaContentType(message),
			'Content-Length': st.size,
			'Content-Disposition': `${mediaDisposition(message)}; filename="${mediaFilename(message)}"`,
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "sandbox; default-src 'none'"
		});
		if (method === 'HEAD') {
			res.end();
			return;
		}
		const stream = createReadStream(filePath);
		stream.on('error', (err) => res.destroy(err));
		stream.pipe(res);
		return;
	}

	error(res, 405, 'Method not allowed');
}

function mediaContentType(message: Message): string {
	const described = describeMedia(message);
	const mime = described?.mime?.toLowerCase();
	if (message.type === 'image' && mime?.startsWith('image/') && mime !== 'image/svg+xml') return mime;
	if (
		(message.type === 'video' || message.type === 'ptv') &&
		mime?.startsWith('video/')
	) {
		return mime;
	}
	if (message.type === 'audio' && mime?.startsWith('audio/')) return mime;
	if (message.type === 'sticker') return 'image/webp';
	// Documents and unknown sender-declared types download rather than execute
	// inside the app's trusted origin.
	if (message.type === 'document') return 'application/octet-stream';
	return MIME[extname(message.media_ref ?? '').toLowerCase()] ?? 'application/octet-stream';
}

function mediaDisposition(message: Message): 'inline' | 'attachment' {
	return message.type === 'document' ? 'attachment' : 'inline';
}

function mediaFilename(message: Message): string {
	const described = describeMedia(message);
	const name = described?.filename ?? `${message.id}${extname(message.media_ref ?? '')}`;
	return name.replace(/["\\\r\n]/g, '_');
}

async function handleApi(
	deps: RoutesDeps,
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	url: URL
): Promise<void> {
	const { db } = deps;
	const path = url.pathname;

	/**
	 * PL-A1 — gated by WHATSAGENT_DEV_EVENTS=1 inside the agent-demo action.
	 */
	if (path === '/api/dev/agent-demo' && method === 'POST') {
		const body = await readJsonBody(req);
		await dispatchAction(deps, res, 'agent-demo', body ?? {});
		return;
	}

	/**
	 * PL-U7 — the agent panel runtime. `agent-turn` and `cancel-agent-turn` are
	 * both frontend-only in the registry; there is deliberately no MCP path to
	 * either (an agent must not start or stop an agent). The 202 here is an
	 * acknowledgement — the transcript arrives over the WebSocket.
	 */
	if (path === '/api/agent/turn' && method === 'POST') {
		const body = await readJsonBody(req);
		await dispatchAction(deps, res, 'agent-turn', body ?? {});
		return;
	}

	if (path === '/api/agent/cancel' && method === 'POST') {
		await dispatchAction(deps, res, 'cancel-agent-turn', {});
		return;
	}

	if (path === '/api/agent/clear' && method === 'POST') {
		await dispatchAction(deps, res, 'clear-agent-panel', {});
		return;
	}

	/**
	 * Whether the panel can run at all, and with which harness. The panel is
	 * unusable with `/mcp` off, so this reports honestly rather than letting the
	 * composer look wired when it is not.
	 *
	 * PANEL-S2 — `available` is now the whole answer. It used to be paired with
	 * `restartRequired` because a saved row could not reach a running process;
	 * `set-setting` reconciles the runtime in the same request, so "saved but not
	 * running" is no longer a state that exists. Read live from `deps` rather
	 * than captured, so the status flips on the request after the toggle.
	 */
	if (path === '/api/agent/status' && method === 'GET') {
		const panel = deps.panelSession;
		json(res, 200, {
			available: Boolean(panel),
			...(panel
				? panel.status()
				: { running: false, sessionId: null, messageId: null, harness: null })
		});
		return;
	}

	if (path === '/api/connection' && method === 'GET') {
		json(res, 200, deps.getConnectionStatus());
		return;
	}

	// D5 — derived session view (pairing + indeterminate sync) for the shell.
	if (path === '/api/session' && method === 'GET') {
		const session = deps.getSessionStatus?.();
		if (!session) {
			error(res, 503, 'Session state unavailable');
			return;
		}
		json(res, 200, session);
		return;
	}

	// Regenerate affordance for `qr_expired`, and re-pair after `logged_out`.
	if (path === '/api/session/pair' && method === 'POST') {
		await dispatchAction(deps, res, 'regenerate-pairing', {});
		return;
	}

	const mediaMatch = /^\/api\/messages\/([^/]+)\/media$/.exec(path);
	if (mediaMatch) {
		await handleMedia(deps, res, method, decodeURIComponent(mediaMatch[1]!));
		return;
	}

	const reactionMatch = /^\/api\/messages\/([^/]+)\/reactions$/.exec(path);
	if (reactionMatch && method === 'POST') {
		const messageId = decodeURIComponent(reactionMatch[1]!);
		// Preserve pre-extraction order: message 404 before body validation.
		if (!getMessage(db, messageId)) {
			error(res, 404, 'Message not found', { id: messageId });
			return;
		}
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'react', { messageId, ...(body ?? {}) });
		return;
	}

	if (path === '/api/settings' && method === 'GET') {
		json(res, 200, listEffectiveSettings(db));
		return;
	}

	/**
	 * W4-U10: read-only voice document inspector. Drafting reads the file
	 * (decision D2 — see server/agent/memory/voice-files.ts), so the inspector
	 * must show exactly what drafting sees: the file on disk, never the
	 * Hindsight model. Absent file is a 200 with content null — "nothing
	 * learned yet" is a normal state, not an error.
	 *
	 * SECURITY: VoiceFiles.read/joins the stem into a path with NO sanitization,
	 * and the data directory also holds the Baileys auth blobs (account-hijack
	 * credentials). So the route accepts NO caller-supplied stem — `/global`
	 * is the only path today, and the per-contact case (a future unit) will be
	 * a separate `/api/voice/contact/:jid` route that runs voiceFileStem()
	 * server-side. The regex below is shaped so that case can grow without
	 * restructuring, but today only the literal `global` segment resolves.
	 *
	 * P3.2 adds the WRITE path (`PUT`) and the refresh trigger below. The whitelist
	 * matters MORE there, not less: a traversal stem on a write path does not leak
	 * `auth/creds.json`, it overwrites it.
	 */
	const voiceGlobalMatch = /^\/api\/voice\/([^/]+)$/.exec(path);
	if (voiceGlobalMatch && method === 'GET') {
		const stem = decodeURIComponent(voiceGlobalMatch[1]!);
		if (!VOICE_STEMS.has(stem)) {
			error(res, 404, 'Not found');
			return;
		}
		const dataDir = deps.dataDir;
		if (!dataDir) {
			error(res, 503, 'Voice storage unavailable');
			return;
		}
		const view = new VoiceFiles(dataDir).inspect(stem);
		json(res, 200, {
			stem: view.stem,
			content: view.content,
			byteLength: view.byteLength,
			modifiedAt: view.modifiedAt === null ? null : new Date(view.modifiedAt).toISOString(),
			path: view.path,
			// `hash` is what the client sends back as `baseHash` — without it there is no
			// way to detect that the mirror moved the document under an open editor.
			hash: view.hash,
			mirrorGuard: view.mirrorGuard,
			// PL-U5 — pending agent suggestions live next to the document they
			// propose to change; Settings renders them from this same load.
			suggestions: new VoiceFiles(dataDir).listSuggestions(stem),
			memory: {
				// Method presence, not a flag: a capability flag can disagree with the object.
				available: typeof deps.memory?.refreshVoiceModels === 'function',
				mode: getSetting(db, MEMORY_SETTING) ?? 'hindsight'
			}
		});
		return;
	}

	/**
	 * P3.2: save a hand edit of a voice document — `save-voice` action.
	 * CSRF is enforced by `security.ts` before this runs.
	 */
	if (voiceGlobalMatch && method === 'PUT') {
		const stem = decodeURIComponent(voiceGlobalMatch[1]!);
		// Preserve pre-extraction order: whitelist + dataDir before body validation.
		if (!VOICE_STEMS.has(stem)) {
			error(res, 404, 'Not found');
			return;
		}
		if (!deps.dataDir) {
			error(res, 503, 'Voice storage unavailable');
			return;
		}
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'save-voice', { stem, ...(body ?? {}) });
		return;
	}

	/**
	 * P3.2: owner-triggered "refresh now" — `refresh-voice` action.
	 */
	const voiceRefreshMatch = /^\/api\/voice\/([^/]+)\/refresh$/.exec(path);
	if (voiceRefreshMatch && method === 'POST') {
		const stem = decodeURIComponent(voiceRefreshMatch[1]!);
		if (!VOICE_STEMS.has(stem)) {
			error(res, 404, 'Not found');
			return;
		}
		await dispatchAction(deps, res, 'refresh-voice', { stem });
		return;
	}

	/**
	 * PL-U5 — owner's half of a voice suggestion. Creation is tool-only via
	 * `suggest-voice-note` (MCP); the frontend can only promote or discard.
	 */
	const voiceSuggestionMatch =
		/^\/api\/voice\/([^/]+)\/suggestions\/([^/]+)\/(promote|discard)$/.exec(path);
	if (voiceSuggestionMatch && method === 'POST') {
		const stem = decodeURIComponent(voiceSuggestionMatch[1]!);
		const id = decodeURIComponent(voiceSuggestionMatch[2]!);
		if (!VOICE_STEMS.has(stem)) {
			error(res, 404, 'Not found');
			return;
		}
		const action =
			voiceSuggestionMatch[3] === 'promote'
				? 'promote-voice-suggestion'
				: 'discard-voice-suggestion';
		await dispatchAction(deps, res, action, { stem, id });
		return;
	}

	if (path === '/api/settings' && method === 'PUT') {
		const body = await readJsonBody(req);
		await dispatchAction(deps, res, 'set-setting', body ?? {});
		return;
	}

	if (path === '/api/providers' && method === 'GET') {
		// OSS-P2.4: discovery endpoint. The response lets the client compute
		// nothing — `active` describes what the running process built at boot
		// (with `coercedFrom` when the persisted value was invalid), `saved`
		// reports the persisted values, and `restartRequired` is a server-side
		// comparison of the two. A client-side "just saved" flag dies on reload
		// and would lie. `allowsCustomModel` is structural and always true for
		// every provider in every state, including total discovery failure,
		// because the escape hatch is the entire point. `auth` is tri-state and
		// defaults to `unknown` — a successful --version proves a binary
		// exists, not that a subscription login works, and there is no cheap
		// probe for that.
		if (!deps.providerDiscovery || !deps.activeProvider) {
			error(res, 503, 'Provider discovery unavailable');
			return;
		}
		const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
		const snapshot = await deps.providerDiscovery.snapshot({ refresh });
		const savedProvider = getSetting(db, PROVIDER_SETTING) ?? null;
		const savedModel = getSetting(db, PROVIDER_MODEL_SETTING) ?? null;
		const active = deps.activeProvider;
		const providers = snapshot.providers.map((p) => toProviderInfo(p));
		const restartRequired =
			active.provider !== (savedProvider ?? active.provider) ||
			(active.model ?? null) !== (savedModel ?? null);
		json(res, 200, {
			providers,
			active,
			saved: { provider: savedProvider, providerModel: savedModel },
			restartRequired,
			searchPath: snapshot.searchPath,
			probedAt: snapshot.probedAt
		});
		return;
	}

	/**
	 * W4-U8: explicit send-mode endpoint. Same persistence + live push as the
	 * generic settings PUT, but with a boolean body and a clear name so the UI
	 * toggle does not have to know the SQLite string polarity. `live: true`
	 * enables real WhatsApp sends (after owner confirmation in the UI);
	 * `live: false` is the safe default and is never confirmed.
	 */
	if (path === '/api/outbox/send-mode' && method === 'GET') {
		const live = getSetting(db, OUTBOX_DRY_RUN_SETTING) === 'false';
		json(res, 200, { live, dry_run: !live });
		return;
	}
	if (path === '/api/outbox/send-mode' && method === 'PUT') {
		const body = await readJsonBody(req);
		await dispatchAction(deps, res, 'set-send-mode', body ?? {});
		return;
	}

	if (path === '/api/outbox' && method === 'GET') {
		const limit = parsePositiveInt(url.searchParams.get('limit'), 100);
		json(res, 200, { items: listOutbox(db, limit) });
		return;
	}

	const outboxMatch = /^\/api\/outbox\/(\d+)$/.exec(path);
	if (outboxMatch && method === 'DELETE') {
		await dispatchAction(deps, res, 'cancel-outbox', { id: Number(outboxMatch[1]) });
		return;
	}

	/**
	 * PL-U3 — the owner's side of the permission channel. There is no POST that
	 * *creates* a proposal here: `propose-send` is tool-only and reaches the
	 * registry through the MCP surface, so the frontend can only ever decide one.
	 */
	if (path === '/api/proposals' && method === 'GET') {
		json(res, 200, { items: listPendingProposalsAll(db) });
		return;
	}

	const proposalMatch = /^\/api\/proposals\/(\d+)\/(confirm|reject)$/.exec(path);
	if (proposalMatch && method === 'POST') {
		const id = Number(proposalMatch[1]);
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		const action = proposalMatch[2] === 'confirm' ? 'confirm-proposal' : 'reject-proposal';
		await dispatchAction(deps, res, action, { ...(body ?? {}), id });
		return;
	}

	/**
	 * PL-U5 — durable notices that the agent cancelled an owner-approved send.
	 * Loaded on hydrate so a toast that already faded is not the only signal.
	 */
	if (path === '/api/cancellation-notices' && method === 'GET') {
		json(res, 200, { items: listOpenCancellationNotices(db) });
		return;
	}

	const cancellationMatch = /^\/api\/cancellation-notices\/(\d+)\/dismiss$/.exec(path);
	if (cancellationMatch && method === 'POST') {
		await dispatchAction(deps, res, 'dismiss-cancellation-notice', {
			id: Number(cancellationMatch[1])
		});
		return;
	}

	if (path === '/api/chats' && method === 'GET') {
		const filter = url.searchParams.get('filter') ?? 'all';
		let items = listChats(db).map((chat) =>
			toChatView(db, chat, (c) => chatNeedsReply(db, c))
		);
		if (filter === 'needs-reply') {
			items = items.filter((c) => c.needs_reply);
		} else if (filter === 'groups') {
			items = items.filter((c) => c.kind === 'group');
		}
		json(res, 200, { items });
		return;
	}

	const chatMatch = /^\/api\/chats\/([^/]+)(?:\/(.*))?$/.exec(path);
	if (!chatMatch) {
		error(res, 404, 'Not found');
		return;
	}

	const jid = decodeURIComponent(chatMatch[1]!);
	const rest = chatMatch[2] ?? '';

	const chat = getChat(db, jid);
	if (!chat && rest !== '') {
		// Sub-resources require the chat to exist.
		error(res, 404, 'Chat not found', { jid });
		return;
	}

	if (rest === '' && method === 'GET') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		json(res, 200, toChatView(db, chat, (c) => chatNeedsReply(db, c)));
		return;
	}

	if (rest === 'messages' && method === 'GET') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const limit = parsePositiveInt(url.searchParams.get('limit'), 50);
		const beforeTsRaw = url.searchParams.get('beforeTs');
		const beforeId = url.searchParams.get('beforeId') ?? undefined;
		const focusMsgId = url.searchParams.get('focusMsgId') ?? undefined;
		const beforeTs =
			beforeTsRaw !== null && beforeTsRaw !== ''
				? Number.parseInt(beforeTsRaw, 10)
				: undefined;
		// `focusMsgId` and `beforeTs` are mutually exclusive paging modes — the
		// former centers a page on a target (U5 jump-to-quote), the latter pages
		// backward from a cursor (W2-U1 load-older). If both arrive, `focusMsgId`
		// wins because a jump is an explicit navigation, not a continuation.
		const items = focusMsgId
			? listMessagesPage(db, jid, { limit, focusMsgId })
			: listMessagesPage(db, jid, {
					limit,
					beforeTs: beforeTs !== undefined && Number.isFinite(beforeTs) ? beforeTs : undefined,
					beforeId
				});
		json(res, 200, { items: items.map((message) => toMessageView(db, message)) });
		return;
	}

	if (rest === 'messages' && method === 'POST') {
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'send', { chatJid: jid, ...(body ?? {}) });
		return;
	}

	if (rest === 'history/deepen' && method === 'POST') {
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'deepen-history', { chatJid: jid, ...(body ?? {}) });
		return;
	}

	if (rest === 'read' && method === 'POST') {
		// U4 seam — intentionally unused in mark-read action. Local cursor only;
		// WhatsApp read receipts remain deferred (plan D3).
		await dispatchAction(deps, res, 'mark-read', { chatJid: jid });
		return;
	}

	if (rest === 'open' && method === 'POST') {
		// PANEL-S7 — the UI's chat-list click dispatches through the registry
		// (the same `open-chat` action the agent tool surface exposes). The
		// action emits a `focus-chat` event over the WebSocket, which the client
		// reducer routes into `AppState.openChat` (load-only). The click then
		// dispatches `mark-read` separately — two actions, both in the registry.
		await dispatchAction(deps, res, 'open-chat', { chatJid: jid });
		return;
	}

	if (rest === 'draft' && method === 'GET') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const draft = getDraft(db, jid);
		if (!draft) {
			error(res, 404, 'Draft not found');
			return;
		}
		json(res, 200, draft);
		return;
	}

	if (rest === 'draft' && method === 'PATCH') {
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'edit-draft', { chatJid: jid, ...(body ?? {}) });
		return;
	}

	if (rest === 'draft/generate' && method === 'POST') {
		await dispatchAction(deps, res, 'generate-draft', { chatJid: jid });
		return;
	}

	if (rest === 'draft/refine' && method === 'POST') {
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'refine-draft', { chatJid: jid, ...(body ?? {}) });
		return;
	}

	if (rest === 'draft/approve' && method === 'POST') {
		const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
		await dispatchAction(deps, res, 'approve-draft', { chatJid: jid, ...(body ?? {}) });
		return;
	}

	if (rest === 'draft/skip' && method === 'POST') {
		await dispatchAction(deps, res, 'skip-draft', { chatJid: jid });
		return;
	}

	error(res, 404, 'Not found');
}
