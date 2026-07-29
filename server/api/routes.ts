import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { AppDatabase } from '../store/db.js';
import {
	getChat,
	listChats,
	markChatRead,
	setChatAgentState,
	type Chat
} from '../store/chats.js';
import { deleteDraft, getDraft, upsertDraft } from '../store/drafts.js';
import { recordDraftFeedback } from '../store/draft-feedback.js';
import {
	getLastInboundMessage,
	getLastMessage,
	getMessage,
	listMessagesPage,
	type Message
} from '../store/messages.js';
import {
	cancelOutbox,
	cancelPendingDraftOutbox,
	enqueueDraftOutbox,
	enqueueManualOutbox,
	enqueueReactionOutbox,
	getOutbox,
	listOutbox
} from '../store/outbox.js';
import { getSetting, listEffectiveSettings, MEMORY_SETTING, OUTBOX_DRY_RUN_SETTING, resolveOutboxDryRun, setSetting, validateSettingValue, PROVIDER_SETTING, PROVIDER_MODEL_SETTING } from '../store/settings.js';
import type { Memory } from '../agent/memory/memory.js';
import type { RefinementAttempt, RefineDraftRequest } from '../agent/refiner.js';
import { retainDraftLearning } from '../agent/voice.js';
import { GLOBAL_VOICE_STEM, VoiceFiles, VOICE_STEMS } from '../agent/memory/voice-files.js';
import { looksLikeVoiceDocument } from '../../shared/voice-document.js';
import { isRefinementIntent } from '../providers/provider.js';
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
	 */
	generateDraft?: (chatJid: string) => boolean;
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

/**
 * Ceiling for a hand-saved voice document. The real one is ~8 KB; 256 KB is generous
 * enough that no legitimate edit hits it and small enough that a runaway client cannot
 * park megabytes in the data dir.
 */
const MAX_VOICE_DOCUMENT_BYTES = 256 * 1024;

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
				'Access-Control-Allow-Headers': 'Content-Type',
				'Access-Control-Max-Age': '86400'
			});
			res.end();
			return;
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
 * - `POST` fetches on demand (never bulk-prefetched) and persists the resulting
 *   state; failures come back with the `unavailable` / `transient` sub-reason so
 *   the UI can decide whether a retry button is even honest.
 * - `GET` streams cached bytes for the lightbox / inline audio / OS handoff.
 */
async function handleMedia(
	deps: RoutesDeps,
	res: ServerResponse,
	method: string,
	messageId: string
): Promise<void> {
	const message = getMessage(deps.db, messageId);
	if (!message) {
		error(res, 404, 'Message not found', { id: messageId });
		return;
	}
	if (!isMediaType(message.type)) {
		error(res, 400, 'Message has no media', { id: messageId, type: message.type });
		return;
	}

	if (method === 'POST') {
		if (message.media_state === 'ready' && message.media_ref) {
			json(res, 200, toMessageView(deps.db, message));
			return;
		}
		if (message.media_state === 'failed' && message.media_error === 'unavailable') {
			// Terminal — retrying cannot help, so do not pretend it might.
			error(res, 410, 'Media is no longer available', { id: messageId });
			return;
		}
		if (!deps.downloadMedia) {
			error(res, 503, 'No channel attached');
			return;
		}
		try {
			await deps.downloadMedia(messageId);
		} catch (err) {
			const updated = getMessage(deps.db, messageId);
			const reason = updated?.media_error ?? 'transient';
			error(res, reason === 'unavailable' ? 410 : 502, 'Media download failed', {
				id: messageId,
				reason
			});
			return;
		}
		json(res, 200, toMessageView(deps.db, getMessage(deps.db, messageId)!));
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
	const { db, events } = deps;
	const path = url.pathname;

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
		if (!deps.regeneratePairing) {
			error(res, 503, 'No channel attached');
			return;
		}
		await deps.regeneratePairing();
		json(res, 202, { ok: true });
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
		const message = getMessage(db, messageId);
		if (!message) {
			error(res, 404, 'Message not found', { id: messageId });
			return;
		}
		const body = (await readJsonBody(req)) as { emoji?: unknown } | undefined;
		const emoji = typeof body?.emoji === 'string' ? body.emoji.trim() : '';
		// An empty emoji string removes a reaction; a missing/non-string emoji is a 400.
		if (typeof body?.emoji !== 'string') {
			error(res, 400, 'Expected { emoji }');
			return;
		}
		const now = Date.now();
		const id = enqueueReactionOutbox(db, {
			chatJid: message.chat_jid,
			targetMsgId: messageId,
			emoji,
			now
		});
		const row = getOutbox(db, id)!;
		deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: row });
		json(res, 202, row);
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
			memory: {
				// Method presence, not a flag: a capability flag can disagree with the object.
				available: typeof deps.memory?.refreshVoiceModels === 'function',
				mode: getSetting(db, MEMORY_SETTING) ?? 'hindsight'
			}
		});
		return;
	}

	/**
	 * P3.2: save a hand edit of a voice document.
	 *
	 * CSRF needs no code here — `security.ts` routes every non-GET/HEAD/OPTIONS request
	 * through `validateOriginAndHost` before dispatch (see the `isMutatingMethod` gate in
	 * `handleRequest`), so a cross-origin `PUT` is rejected with 403 before this runs.
	 * There is a test asserting exactly that; it is the proof, not this comment.
	 *
	 * Ordering is load-bearing:
	 *   1. whitelist / size / `baseHash` checks — all of which leave the file untouched;
	 *   2. `writeOwnerEdit`, which arms the mirror guard and is NEVER rolled back;
	 *   3. the Hindsight directive, which is best-effort.
	 * A 409 must not reach step 2: arming the guard on a save that never happened would
	 * hold the mirror off a document the owner never edited.
	 */
	if (voiceGlobalMatch && method === 'PUT') {
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
		const body = (await readJsonBody(req)) as
			| { content?: unknown; baseHash?: unknown; note?: unknown }
			| undefined;
		if (typeof body?.content !== 'string' || typeof body.baseHash !== 'string') {
			error(res, 400, 'Expected { content, baseHash }');
			return;
		}
		// The real document is ~8 KB. The ceiling exists so a runaway client cannot park
		// megabytes in the data dir, and it is checked in BYTES before anything is hashed.
		if (Buffer.byteLength(body.content, 'utf8') > MAX_VOICE_DOCUMENT_BYTES) {
			error(res, 400, 'Voice document too large', { maxBytes: MAX_VOICE_DOCUMENT_BYTES });
			return;
		}
		const files = new VoiceFiles(dataDir);
		const current = files.inspect(stem);
		if (current.hash !== body.baseHash) {
			// Someone (the mirror, another tab) moved the document since this editor loaded
			// it. Return what is actually on disk and let the owner decide — silently
			// overwriting is how an edit disappears without anyone noticing.
			json(res, 409, {
				stem,
				conflict: true,
				content: current.content,
				hash: current.hash,
				byteLength: current.byteLength,
				modifiedAt:
					current.modifiedAt === null ? null : new Date(current.modifiedAt).toISOString(),
				mirrorGuard: current.mirrorGuard
			});
			return;
		}

		files.writeOwnerEdit(stem, body.content);

		// The directive is D3's "correction becomes a hard rule for reflect". It is
		// attempted after the write and can never undo it: an owner who saved and got a
		// 500 back would have no way to tell whether their text survived. `skipped` means
		// no memory service is wired at all; `failed` means one is and the call did not
		// land — the guard is armed either way, which is the whole point of arming it
		// unconditionally.
		let directive: 'recorded' | 'skipped' | 'failed' = 'skipped';
		if (typeof deps.memory?.recordVoiceCorrection === 'function') {
			const note = typeof body.note === 'string' ? body.note.trim() : '';
			try {
				await deps.memory.recordVoiceCorrection(
					`Owner voice correction (${stem})`,
					note ||
						'The owner hand-edited the voice document. Treat their edited version as ' +
							'authoritative about how they write, over anything inferred from message history.',
					undefined
				);
				directive = 'recorded';
			} catch {
				directive = 'failed';
			}
		}

		const saved = files.inspect(stem);
		json(res, 200, {
			stem,
			hash: saved.hash,
			byteLength: saved.byteLength,
			modifiedAt: saved.modifiedAt === null ? null : new Date(saved.modifiedAt).toISOString(),
			mirrorGuard: saved.mirrorGuard,
			// A WARNING, never a rejection (P3.1). Refusing a legitimate owner edit because a
			// heuristic disagreed is worse than the Milkdown mangling it watches for.
			looksLikeVoiceDocument: looksLikeVoiceDocument(body.content),
			directive
		});
		return;
	}

	/**
	 * P3.2: owner-triggered "refresh now" — the release valve for the mirror guard. It
	 * does not clear the guard: `refreshMentalModel` is a trigger, and the mirror that
	 * runs immediately after it still carries the PRE-EDIT document. The guard releases
	 * itself when genuinely new content arrives, which is the only moment it is safe to.
	 *
	 * "No memory service" is a 200 with `available: false`, not an error status, so the
	 * UI can explain the situation instead of alarming about it.
	 */
	const voiceRefreshMatch = /^\/api\/voice\/([^/]+)\/refresh$/.exec(path);
	if (voiceRefreshMatch && method === 'POST') {
		const stem = decodeURIComponent(voiceRefreshMatch[1]!);
		if (!VOICE_STEMS.has(stem)) {
			error(res, 404, 'Not found');
			return;
		}
		if (typeof deps.memory?.refreshVoiceModels !== 'function') {
			json(res, 200, { available: false, refreshed: [], error: null });
			return;
		}
		try {
			const refreshed = await deps.memory.refreshVoiceModels();
			json(res, 200, { available: true, refreshed, error: null });
		} catch (err) {
			// Hindsight being down is an expected state, not a server fault — report it as
			// data so the UI says "memory is offline" rather than "something broke".
			json(res, 200, {
				available: true,
				refreshed: [],
				error: err instanceof Error ? err.message : String(err)
			});
		}
		return;
	}

	if (path === '/api/settings' && method === 'PUT') {
		const body = (await readJsonBody(req)) as { key?: string; value?: string } | undefined;
		if (!body?.key || typeof body.value !== 'string') {
			error(res, 400, 'Expected { key, value }');
			return;
		}
		// OSS-P2.4: validate VALUES, never keys. A key whitelist is the wrong
		// instrument — this endpoint is also the write path for hindsight_url,
		// hindsight_bank, hindsight_refresh_cron, memory, the two pacing keys,
		// outbox_dry_run and whatsapp_history_sync_complete. Whitelisting keys
		// silently breaks every one of them. Closed domains are validated and
		// NORMALIZED here; everything else passes through unchanged. Today a
		// typo saves with a 200, looks like it worked, and the app fails to
		// start on the next boot — recoverable only by hand-editing SQLite.
		const result = validateSettingValue(body.key, body.value);
		if (!result.ok) {
			error(res, 400, result.message, { allowed: result.allowed });
			return;
		}
		setSetting(db, body.key, result.normalized);
		// W4-U8: when the outbox dry-run setting is touched, push the resolved
		// polarity into the live pacer so the toggle takes effect without a
		// restart. The generic PUT is the settings UI's only path today; a
		// dedicated endpoint would just duplicate this. The pacer stays the
		// sole sender — this only flips whether it transmits.
		if (body.key === OUTBOX_DRY_RUN_SETTING && deps.setOutboxDryRun) {
			deps.setOutboxDryRun(resolveOutboxDryRun(result.normalized));
		}
		// OSS-P2.4: invalidate the discovery cache when the provider or model
		// changed, so the next GET /api/providers reflects the new saved value
		// (and, for provider, re-probes against the new selection's auth state).
		if ((body.key === PROVIDER_SETTING || body.key === PROVIDER_MODEL_SETTING) && deps.providerDiscovery) {
			deps.providerDiscovery.invalidate();
		}
		json(res, 200, { key: body.key, value: getSetting(db, body.key) });
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
		const body = (await readJsonBody(req)) as { live?: unknown } | undefined;
		if (typeof body?.live !== 'boolean') {
			error(res, 400, 'Expected { live: boolean }');
			return;
		}
		const live = body.live;
		const value = live ? 'false' : 'true';
		setSetting(db, OUTBOX_DRY_RUN_SETTING, value);
		if (deps.setOutboxDryRun) deps.setOutboxDryRun(!live);
		const resolved = { live, dry_run: !live };
		events.emit({ type: 'send-mode', ...resolved });
		json(res, 200, resolved);
		return;
	}

	if (path === '/api/outbox' && method === 'GET') {
		const limit = parsePositiveInt(url.searchParams.get('limit'), 100);
		json(res, 200, { items: listOutbox(db, limit) });
		return;
	}

	const outboxMatch = /^\/api\/outbox\/(\d+)$/.exec(path);
	if (outboxMatch && method === 'DELETE') {
		const id = Number(outboxMatch[1]);
		const existing = getOutbox(db, id);
		if (!existing) {
			error(res, 404, 'Outbox item not found');
			return;
		}
		if (!cancelOutbox(db, id)) {
			error(res, 409, 'Outbox item is not cancellable');
			return;
		}
		const updated = getOutbox(db, id)!;
		deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: updated });
		json(res, 200, updated);
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
		// Composer send → outbox only. Never calls WhatsApp send (R9 / U9).
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const body = (await readJsonBody(req)) as
			| { text?: string; reply_to_msg_id?: unknown }
			| undefined;
		const text = body?.text?.trim();
		if (!text) {
			error(res, 400, 'Expected { text }');
			return;
		}
		let replyToMsgId: string | undefined;
		if (body?.reply_to_msg_id !== undefined) {
			if (typeof body.reply_to_msg_id !== 'string' || !body.reply_to_msg_id.trim()) {
				error(res, 400, 'Expected reply_to_msg_id to be a message id');
				return;
			}
			replyToMsgId = body.reply_to_msg_id.trim();
			const target = getMessage(db, replyToMsgId);
			if (!target) {
				error(res, 400, 'Reply target not found');
				return;
			}
			if (target.chat_jid !== jid) {
				error(res, 400, 'Reply target does not belong to this chat');
				return;
			}
		}
		const now = Date.now();
		const id = enqueueManualOutbox(db, {
			chatJid: jid,
			text,
			replyToMsgId,
			now
		});
		const row = getOutbox(db, id)!;
		deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: row });
		json(res, 202, row);
		return;
	}

	if (rest === 'history/deepen' && method === 'POST') {
		if (!deps.deepenHistory) {
			error(res, 503, 'History deepening unavailable');
			return;
		}
		const body = (await readJsonBody(req)) as { count?: number } | undefined;
		const requestedCount = typeof body?.count === 'number' && Number.isFinite(body.count)
			? Math.trunc(body.count)
			: 50;
		const count = Math.min(Math.max(requestedCount, 1), 200);
		json(res, 202, await deps.deepenHistory(jid, count));
		return;
	}

	if (rest === 'read' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		markChatRead(db, jid);
		const updated = toChatView(db, getChat(db, jid)!, (c) => chatNeedsReply(db, c));
		events.emit({ type: 'chat-updated', chat: updated });
		// U4 seam — intentionally unused. The local read cursor advanced above
		// is a LOCAL marker only. Emitting WhatsApp read receipts on view marks
		// the chat read on the owner's real phone and is a separate owner
		// decision that has been explicitly deferred (see plan D3). When that
		// decision is taken, hook the send transport here — and only here — with
		// a call like:
		//   emitReadReceiptOnView(deps, jid, updated.last_read_msg_id);
		// Do NOT broaden the existing post-send `transport.markRead` trigger in
		// `server/outbox/pacer.ts` (that one fires only as a follow-up to a reply
		// the owner actually sent).
		json(res, 200, updated);
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
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const existing = getDraft(db, jid);
		if (!existing) {
			error(res, 404, 'Draft not found');
			return;
		}
		if (!['ready', 'stale', 'drafted'].includes(existing.status)) {
			error(res, 409, 'Draft is not editable', { status: existing.status });
			return;
		}
		const body = (await readJsonBody(req)) as { text?: string } | undefined;
		if (typeof body?.text !== 'string') {
			error(res, 400, 'Expected { text }');
			return;
		}
		upsertDraft(db, { ...existing, text: body.text });
		const draft = getDraft(db, jid)!;
		events.emit({ type: 'draft-updated', draft });
		json(res, 200, draft);
		return;
	}

	/**
	 * W4-U15 — owner presses "Generate draft". Mutating, so the shared
	 * Origin/Host validation already covers it; no second check here.
	 *
	 * Accepts with 202 and does not wait on the provider: the existing
	 * `draft-updated` events carry the UI through drafting → ready.
	 *
	 * R9 is untouched. This writes a draft row; it enqueues nothing, wakes no
	 * pacer, and has no path to the WhatsApp send function.
	 */
	if (rest === 'draft/generate' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		// R8: groups are structurally excluded from drafting and the owner cannot
		// opt out of that. The scheduler seam refuses them again.
		if (chat.kind !== '1:1') {
			error(res, 400, 'Drafting is available for 1:1 chats only', { kind: chat.kind });
			return;
		}
		if (!deps.generateDraft) {
			error(res, 503, 'Draft generation unavailable');
			return;
		}
		// History sync creates chat rows independently of message delivery, so a
		// 1:1 chat with no messages is reachable. The drafter would return
		// `not_needed` for it and emit nothing at all — a 202 followed by silence
		// is exactly the silent no-op this unit is supposed to remove.
		if (!getLastMessage(db, jid)) {
			error(res, 409, 'No messages in this chat to draft from');
			return;
		}
		const existing = getDraft(db, jid);
		if (existing?.status === 'drafting') {
			error(res, 409, 'A draft is already being generated', { status: existing.status });
			return;
		}
		// An approved draft may already be queued in the outbox — regenerating
		// under one would swap the text out from beneath an owner approval.
		if (existing?.status === 'approved') {
			error(res, 409, 'Draft is already approved', { status: existing.status });
			return;
		}
		if (!deps.generateDraft(jid)) {
			error(res, 409, 'Draft generation was refused for this chat');
			return;
		}
		json(res, 202, { ok: true, chat_jid: jid });
		return;
	}

	if (rest === 'draft/refine' && method === 'POST') {
		const body = (await readJsonBody(req)) as { intent?: unknown; text?: unknown } | undefined;
		if (!isRefinementIntent(body?.intent)) {
			error(res, 400, 'Invalid refinement intent');
			return;
		}
		if (body.text !== undefined && typeof body.text !== 'string') {
			error(res, 400, 'Expected text to be a string');
			return;
		}
		if (!deps.refineDraft) {
			error(res, 503, 'Draft refinement unavailable');
			return;
		}

		const result = await deps.refineDraft({
			chatJid: jid,
			intent: body.intent,
			preview: body.text
		});
		if (result.kind === 'ready') {
			json(res, 200, result.draft);
			return;
		}
		if (result.kind === 'not_found') {
			error(res, 404, 'Draft not found');
			return;
		}
		if (result.kind === 'not_refinable') {
			error(res, 409, 'Draft is not refinable', { status: result.status });
			return;
		}
		if (result.kind === 'invalid_preview') {
			error(res, 400, 'Empty draft text');
			return;
		}
		if (result.kind === 'superseded') {
			error(res, 409, 'Draft changed during refinement');
			return;
		}
		error(res, result.code === 'rate_limit' ? 429 : 502, 'Draft refinement failed', {
			code: result.code
		});
		return;
	}

	if (rest === 'draft/approve' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const body = (await readJsonBody(req)) as
			| { text?: string; confirmed_latest_inbound_id?: string }
			| undefined;
		// Re-read after the await above. Another approval may have completed while
		// this request body was arriving; only one request may observe approvable.
		const existing = getDraft(db, jid);
		if (!existing) {
			error(res, 404, 'Draft not found');
			return;
		}
		if (!['ready', 'stale', 'drafted'].includes(existing.status)) {
			error(res, 409, 'Draft is not approvable', { status: existing.status });
			return;
		}
		const latestInbound = getLastInboundMessage(db, jid);
		if (
			existing.basis_msg_id &&
			latestInbound &&
			latestInbound.id !== existing.basis_msg_id &&
			body?.confirmed_latest_inbound_id !== latestInbound.id
		) {
			error(res, 409, 'Draft is stale; newer inbound arrived', {
				basis_msg_id: existing.basis_msg_id,
				latest_inbound_id: latestInbound.id
			});
			return;
		}
		const text = (body?.text ?? existing.text).trim();
		if (!text) {
			error(res, 400, 'Empty draft text');
			return;
		}
		const now = Date.now();
		const approve = db.transaction(() => {
			const id = enqueueDraftOutbox(db, {
				chatJid: jid,
				text,
				draftText: existing.original_text,
				basisMsgId: existing.basis_msg_id,
				now,
				jitterMs: deps.nextDraftJitterMs?.() ?? 30_000
			});
			recordDraftFeedback(db, {
				chat_jid: jid,
				kind: 'approved',
				draft_text: existing.original_text,
				final_text: text,
				basis_msg_id: existing.basis_msg_id,
				created_at: now
			});
			upsertDraft(db, { ...existing, text, status: 'approved' });
			return { row: getOutbox(db, id)!, draft: getDraft(db, jid)! };
		});
		const { row, draft } = approve();
		if (deps.memory) {
			void retainDraftLearning(deps.memory, {
				chatJid: jid,
				draft: existing.original_text,
				final: text,
				skipped: false
			});
		}
		deps.wakeOutbox?.();
		events.emit({ type: 'outbox-updated', outbox: row });
		events.emit({ type: 'draft-updated', draft });
		json(res, 202, { outbox: row, draft });
		return;
	}

	if (rest === 'draft/skip' && method === 'POST') {
		if (!chat) {
			error(res, 404, 'Chat not found', { jid });
			return;
		}
		const existing = getDraft(db, jid);
		if (!existing) {
			error(res, 404, 'Draft not found');
			return;
		}
		let cancelled: ReturnType<typeof cancelPendingDraftOutbox> = [];
		const skip = db.transaction(() => {
			if (existing.status === 'approved') {
				cancelled = cancelPendingDraftOutbox(db, jid, existing.basis_msg_id);
				if (cancelled.length === 0) return false;
			}
			recordDraftFeedback(db, {
				chat_jid: jid,
				kind: 'skipped',
				draft_text: existing.original_text,
				final_text: null,
				basis_msg_id: existing.basis_msg_id,
				created_at: Date.now()
			});
			deleteDraft(db, jid);
			setChatAgentState(db, jid, 'skipped');
			return true;
		});
		if (!skip()) {
			error(res, 409, 'Approved draft is already sending or sent');
			return;
		}
		if (deps.memory) {
			void retainDraftLearning(deps.memory, {
				chatJid: jid,
				draft: existing.original_text,
				final: null,
				skipped: true
			});
		}
		deps.wakeOutbox?.();
		for (const outbox of cancelled) events.emit({ type: 'outbox-updated', outbox });
		const updated = toChatView(db, getChat(db, jid)!, (c) => chatNeedsReply(db, c));
		events.emit({ type: 'draft-removed', chat_jid: jid });
		events.emit({ type: 'chat-updated', chat: updated });
		json(res, 200, { ok: true, chat: updated });
		return;
	}

	error(res, 404, 'Not found');
}
