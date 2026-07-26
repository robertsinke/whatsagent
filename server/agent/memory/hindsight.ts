import { HindsightClient } from '@vectorize-io/hindsight-client';
import type { Chat } from '../../store/chats.js';
import { NullMemory } from './null-memory.js';
import type { EditDelta, Memory, VoiceObservation } from './memory.js';
import { composeVoice, GLOBAL_VOICE_STEM, VoiceFiles, voiceFileStem } from './voice-files.js';

const DEFAULT_BANK_ID = 'whatsagent-owner-voice';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8888';
/** D1b: nightly UTC. Hindsight runs this server-side; the app schedules nothing. */
const DEFAULT_REFRESH_CRON = '0 3 * * *';
const VOICE_MODEL_PREFIX = 'voice-';
/**
 * Hindsight parks this literal in `content` while a refresh is in flight. Mirroring it
 * would put "Generating content..." into the draft prompt as if it were the owner's
 * voice, and — worse — overwrite the last good document with it.
 */
const REFRESH_IN_PROGRESS_CONTENT = 'Generating content...';
const GLOBAL_MODEL_ID = `${VOICE_MODEL_PREFIX}${GLOBAL_VOICE_STEM}`;

/**
 * Positive test for "is this a real voice document?", replacing the two-string blocklist
 * that could not anticipate what an LLM writes when it has nothing to say. A valid voice
 * document carries at least one concrete habit as a markdown list item; an LLM with no
 * data writes a single declarative sentence about not having information (and the
 * in-flight placeholder is a single line of boilerplate). Both fail this test.
 *
 * Exported for testing — do not call from outside the module.
 */
export function looksLikeVoiceDocument(content: string): boolean {
	const trimmed = content.trim();
	if (!trimmed) return false;
	if (trimmed === REFRESH_IN_PROGRESS_CONTENT) return false;
	// A "no information" / "I don't have information" verdict — the failure mode the old
	// blocklist missed. Match the common phrasings regardless of surrounding sentence.
	const lower = trimmed.toLowerCase();
	if (
		lower.includes("don't have information") ||
		lower.includes('do not have information') ||
		lower.includes('no information about the owner') ||
		lower.includes('not enough information') ||
		lower.includes('no discernible') ||
		lower.includes('unable to determine')
	) {
		return false;
	}
	// A real voice document is a list of habits. Require at least one markdown list item
	// (`- `) that is more than a bare label — it has to carry a description of the habit.
	const items = trimmed.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line));
	if (items.length === 0) return false;
	// Reject a single-line "list" that is really just the no-information verdict restated
	// (e.g. "- No information about the owner's writing habits.").
	const substantive = items.filter((line) => {
		const text = line.replace(/^\s*[-*]\s+/, '').toLowerCase();
		return (
			text.length > 0 &&
			!text.startsWith('no information') &&
			!text.startsWith("don't have") &&
			!text.startsWith('do not have') &&
			!text.startsWith('unable to')
		);
	});
	return substantive.length > 0;
}

/**
 * The floor retain timeout. The steady-state `timeoutMs` (2 s) is a reasonable budget for a
 * single retain on the drafting path, but the floor cost of the first retain after a cold
 * start is the LLM warming, not the network. A 2 s budget there aborts the whole bootstrap
 * and parks the queue for the retry window. Retain uses this longer floor so one cold-start
 * timeout does not cascade.
 */
const DEFAULT_RETAIN_TIMEOUT_MS = 30_000;

const GLOBAL_SOURCE_QUERY =
	"What are the owner's durable writing habits across all conversations — tone, typical length, " +
	'greetings, sign-offs, punctuation, emoji use, and language? Quote evidence for each habit.';
const CHAT_SOURCE_QUERY =
	'How does the owner write specifically to this contact, and what draft edits or skips should ' +
	'guide the next reply to them? Quote evidence for each habit.';

/**
 * Hand-written structural subset of `HindsightClient`. Every member must stay
 * assignable from the real client — widening this with a method the client does not
 * have breaks the `options.client ?? new HindsightClient(...)` default below.
 *
 * `refresh_cron` is deliberately absent: the typed client's `createMentalModel` and
 * `updateMentalModel` drop it when mapping options onto the request body (verified
 * against 0.8.5's `dist/index.js`), so the cron is set over raw REST instead — see
 * `#configureRefreshCron`.
 *
 * `listMentalModels` returns `content` and `last_refreshed_at` per item at the
 * default detail level, so the mirror reads from the list response and does not
 * pay a `getMentalModel` per model. The typed client wrapper drops the `limit`/
 * `offset`/`detail` query params (verified against 0.8.5's `dist/index.js`),
 * and the service caps an unparameterised list at 100 items — so the paginated
 * mirror goes over raw REST via `#listVoiceModelsPaginated`, not through this
 * method. The client method is kept for the existence-check path in
 * `#createModelIfMissing` and for tests that stub a small model set.
 */
export type HindsightClientLike = {
	retain(
		bankId: string,
		content: string,
		options?: {
			context?: string;
			metadata?: Record<string, string>;
			tags?: string[];
			documentId?: string;
			updateMode?: 'replace';
			signal?: AbortSignal;
		}
	): Promise<unknown>;
	createMentalModel(
		bankId: string,
		name: string,
		sourceQuery: string,
		options?: {
			id?: string;
			tags?: string[];
			maxTokens?: number;
			trigger?: {
				refreshAfterConsolidation?: boolean;
				tagsMatch?: 'any' | 'all' | 'any_strict' | 'all_strict' | 'exact';
			};
			signal?: AbortSignal;
		}
	): Promise<unknown>;
	listMentalModels(
		bankId: string,
		options?: { tags?: string[]; signal?: AbortSignal }
	): Promise<{ items: Array<{ id: string; content?: string | null; last_refreshed_at?: string | null }> }>;
	getMentalModel(
		bankId: string,
		mentalModelId: string,
		options?: { signal?: AbortSignal }
	): Promise<{ id: string; content?: string | null; last_refreshed_at?: string | null }>;
	refreshMentalModel(
		bankId: string,
		mentalModelId: string,
		options?: { signal?: AbortSignal }
	): Promise<unknown>;
	createDirective(
		bankId: string,
		name: string,
		content: string,
		options?: { priority?: number; isActive?: boolean; tags?: string[]; signal?: AbortSignal }
	): Promise<unknown>;
	listDirectives(
		bankId: string,
		options?: { tags?: string[]; signal?: AbortSignal }
	): Promise<{ items: Array<{ id: string; name: string }> }>;
};

type PendingRetain = {
	content: string;
	context: string;
	metadata: Record<string, string>;
	tags: string[];
	documentId?: string;
	updateMode?: 'replace';
};

export type HindsightMemoryOptions = {
	/** Where the voice markdown is mirrored and read from. Required — never defaulted to the live data dir. */
	dataDir: string;
	client?: HindsightClientLike;
	baseUrl?: string;
	bankId?: string;
	fallback?: Memory;
	/** Timeout for the light mirror/ensure/refresh calls (default 2 s). */
	timeoutMs?: number;
	/** Timeout for the retain send path (default 30 s). The first retain after a cold start pays the LLM warm-up, not the network. */
	retainTimeoutMs?: number;
	maxQueuedRetains?: number;
	retryDelayMs?: number;
	refreshCron?: string;
	maxVoiceChars?: number;
	/**
	 * Page size for the paginated mental-model list (default 100). The service caps an
	 * unparameterised list at 100, so this only matters once the per-contact voice model
	 * set grows past a single page — which the demand-driven per-contact creation can
	 * reach. The mirror walks pages until a short page signals the end (the list
	 * response carries no total/cursor).
	 */
	mirrorListPageSize?: number;
	fetchImpl?: typeof fetch;
	log?: Pick<Console, 'warn'>;
};

function chatTag(chatJid: string): string {
	return `chat:${chatJid}`;
}

function summarizeEdit(delta: EditDelta): string {
	if (delta.skipped) {
		return `Owner skipped this suggested reply: "${delta.draft}". Do not assume similar messages need a reply.`;
	}
	const final = delta.final ?? '';
	const changes: string[] = [];
	if (final.length < delta.draft.length) changes.push('shortened the reply');
	if ((delta.draft.match(/!/g) ?? []).length > (final.match(/!/g) ?? []).length) {
		changes.push('removed exclamation marks');
	}
	const detail = changes.length > 0 ? ` (${changes.join(' and ')})` : '';
	return `Owner edited the draft${detail}. Draft: "${delta.draft}" Final preferred wording: "${final}".`;
}

export class HindsightMemory implements Memory {
	readonly #client: HindsightClientLike;
	readonly #bankId: string;
	readonly #baseUrl: string;
	readonly #fallback: Memory;
	readonly #timeoutMs: number;
	readonly #retainTimeoutMs: number;
	readonly #maxQueuedRetains: number;
	readonly #retryDelayMs: number;
	readonly #refreshCron: string;
	readonly #maxVoiceChars: number;
	readonly #mirrorListPageSize: number;
	readonly #fetch: typeof fetch;
	readonly #log: Pick<Console, 'warn'>;
	readonly #files: VoiceFiles;
	readonly #queued: PendingRetain[] = [];
	/** Dedupes concurrent ensures; a failed ensure is dropped so the next call retries. */
	readonly #ensuring = new Map<string, Promise<void>>();
	/**
	 * Per-model `last_refreshed_at` of the content last written to disk. The change-driven
	 * mirror (`drain`) compares this against the list response and only fetches/writes the
	 * models that advanced, instead of re-mirroring the whole set every 6 hours. Null
	 * `last_refreshed_at` (a freshly created model that has not yet refreshed) is treated
	 * as "never mirrored" so the first refresh reaches disk promptly.
	 */
	readonly #lastMirroredAt = new Map<string, string>();
	#offlineUntil = 0;

	constructor(options: HindsightMemoryOptions) {
		this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.#client = options.client ?? new HindsightClient({ baseUrl: this.#baseUrl });
		this.#bankId = options.bankId ?? DEFAULT_BANK_ID;
		this.#fallback = options.fallback ?? new NullMemory({ captureVoice: true });
		this.#timeoutMs = options.timeoutMs ?? 2_000;
		this.#retainTimeoutMs = options.retainTimeoutMs ?? DEFAULT_RETAIN_TIMEOUT_MS;
		this.#maxQueuedRetains = options.maxQueuedRetains ?? 1_000;
		this.#retryDelayMs = options.retryDelayMs ?? 30_000;
		this.#refreshCron = options.refreshCron ?? DEFAULT_REFRESH_CRON;
		this.#maxVoiceChars = options.maxVoiceChars ?? 6_000;
		this.#mirrorListPageSize = options.mirrorListPageSize ?? 100;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#log = options.log ?? console;
		this.#files = new VoiceFiles(options.dataDir);
	}

	get queuedRetains(): number {
		return this.#queued.length;
	}

	get voiceDirectory(): string {
		return this.#files.directory;
	}

	async retainVoiceObservation(observation: VoiceObservation): Promise<void> {
		await this.#fallback.retainVoiceObservation(observation);
		await this.#retain({
			content: `Owner sent these ${observation.language ?? 'unknown-language'} messages:\n${observation.text}`,
			context: 'WhatsApp owner voice bootstrap',
			metadata: { chat_jid: observation.chatJid, language: observation.language ?? 'und' },
			tags: [chatTag(observation.chatJid), `language:${observation.language ?? 'und'}`, 'voice'],
			documentId: `voice:${observation.chatJid}:${observation.language ?? 'und'}`,
			updateMode: 'replace'
		});
		// Deliberately no per-chat model here. `bootstrapOwnerVoice` emits one observation
		// per 1:1 chat per language over the whole message table — hundreds of them — so
		// ensuring a model from this path would fire hundreds of background syntheses on
		// first boot. The memory still carries `chat:<jid>` and `voice`, so it feeds the
		// global model at once and the per-chat model the moment an edit or skip creates one.
	}

	async retainEditDelta(delta: EditDelta): Promise<void> {
		await this.#fallback.retainEditDelta(delta);
		await this.#retain({
			content: summarizeEdit(delta),
			context: delta.skipped ? 'Owner skipped an AI draft' : 'Owner edited an AI draft before approval',
			metadata: { chat_jid: delta.chatJid, signal: delta.skipped ? 'skip' : 'edit' },
			tags: [chatTag(delta.chatJid), delta.skipped ? 'skip' : 'edit', 'voice']
		});
		await this.#ensureChatModel(delta.chatJid);
	}

	/**
	 * D2: reads the mirrored files, never the service. No network call sits on the
	 * drafting path, so a Hindsight outage costs freshness and nothing else (W4-R6).
	 */
	async recallStyleFor(chat: Chat): Promise<string | null> {
		const composed = composeVoice(
			this.#files.read(GLOBAL_VOICE_STEM),
			this.#files.read(voiceFileStem(chat.jid)),
			this.#maxVoiceChars
		);
		// Before the first consolidation there is nothing on disk; the local floor still applies.
		return composed ?? this.#fallback.recallStyleFor(chat);
	}

	/**
	 * The mirror heartbeat. Ensures the models exist and copies whatever markdown they
	 * currently hold onto disk. Regeneration itself is Hindsight's cron (D1b), so this
	 * costs no LLM call and a stale file is an acceptable outcome by design.
	 *
	 * This does **not** create the global model: creating it before any observation has
	 * been retained makes Hindsight synthesize a "no information about the owner's writing
	 * habits" document, which would then be mirrored to `voice/global.md` and handed to
	 * the drafter as the owner's voice. The global model is ensured lazily on the first
	 * successful retain (see `#retain`), so by the time it exists the bank has data to
	 * synthesize from. On a restart the model already exists server-side, so this just
	 * mirrors its current content.
	 */
	async reflect(): Promise<void> {
		if (Date.now() < this.#offlineUntil) return;
		try {
			await this.#flushQueued();
			await this.#mirrorAll();
		} catch (error) {
			this.#offlineUntil = Date.now() + this.#retryDelayMs;
			this.#log.warn('[memory] Hindsight voice sync unavailable; keeping the mirrored files', error);
		}
	}

	/**
	 * The short-interval memory tick. Two jobs, one timer (the runtime wires a ~1-minute
	 * interval around this — preferable to three independent schedules):
	 *
	 * 1. Drain the retain queue. A cold-start retain that times out sets `#offlineUntil`;
	 *    without this, the queue sits until the next retain or the 6-hourly `reflect` —
	 *    one 2 s timeout parked the whole voice bootstrap for six hours (W4-U5).
	 * 2. Mirror voice documents whose `last_refreshed_at` advanced since the last mirror.
	 *    Hindsight's nightly cron (D1b) refreshes the model server-side, but without this
	 *    tick a freshly consolidated voice document can sit in the service for hours
	 *    before `reflect()` copies it to disk — and drafting reads the disk (W4-U6).
	 *
	 * No-op while still offline (the gate matches `#retain`). The change-driven mirror
	 * uses the paginated list response's `last_refreshed_at` to fetch and write only the
	 * models that changed, so this scales to the per-contact model set without an N+1
	 * `getMentalModel` per model every minute.
	 */
	async drain(): Promise<void> {
		if (Date.now() < this.#offlineUntil) return;
		try {
			await this.#flushQueued();
			await this.#mirrorChanged();
		} catch (error) {
			this.#offlineUntil = Date.now() + this.#retryDelayMs;
			this.#log.warn('[memory] memory tick (drain/mirror) failed; will retry', error);
		}
	}

	/**
	 * Owner-triggered "refresh now" (D1b), so the nightly cron never blocks demonstrating
	 * the loop. Refresh is asynchronous server-side: this submits it and mirrors whatever
	 * is present now — the regenerated content lands on a later `reflect`.
	 *
	 * Does not create the global model here: an owner hitting "refresh now" before any
	 * observation has been retained would otherwise synthesize the "no information"
	 * document. The model is ensured lazily on the first successful retain.
	 */
	async refreshVoiceModels(): Promise<string[]> {
		const ids = await this.#listVoiceModelIds();
		for (const id of ids) {
			await this.#withTimeout((signal) => this.#client.refreshMentalModel(this.#bankId, id, { signal }));
		}
		await this.#mirrorAll();
		return ids;
	}

	/** D3: an owner correction becomes a hard rule for reflect, not a file edit we merge. */
	async recordVoiceCorrection(name: string, content: string, chatJid?: string): Promise<void> {
		await this.#withTimeout((signal) => this.#client.createDirective(this.#bankId, name, content, {
			tags: chatJid ? [chatTag(chatJid), 'voice'] : ['voice'],
			signal
		}));
	}

	/**
	 * Voice model ids, paginated over raw REST so a >100-model set does not silently
	 * truncate (the typed client caps at 100). Used by `refreshVoiceModels` to trigger
	 * server-side refreshes; the mirror itself reads `#listVoiceModelsPaginated`.
	 */
	async #listVoiceModelIds(): Promise<string[]> {
		const models = await this.#listVoiceModelsPaginated();
		return models.map((model) => model.id);
	}

	/**
	 * Paginated list of voice models with content, over raw REST. The typed client
	 * wrapper drops the `limit`/`offset`/`detail` query params (verified against 0.8.5's
	 * `dist/index.js`), and the service caps an unparameterised list at 100 items — so a
	 * per-contact model set in the hundreds would silently truncate through the client
	 * method. `detail=content` makes each item carry `content` and `last_refreshed_at`,
	 * so the mirror reads from the list response and pays no `getMentalModel` per model.
	 *
	 * The response carries no total/cursor — done is a page strictly shorter than the
	 * requested page size. A full page means "there may be more", so the walk continues.
	 */
	async #listVoiceModelsPaginated(): Promise<Array<{ id: string; content: string | null; lastRefreshed: string | null }>> {
		const out: Array<{ id: string; content: string | null; lastRefreshed: string | null }> = [];
		const size = Math.max(1, this.#mirrorListPageSize);
		for (let offset = 0; ; offset += size) {
			const url =
				`${this.#baseUrl}/v1/default/banks/${encodeURIComponent(this.#bankId)}/mental-models` +
				`?detail=content&limit=${size}&offset=${offset}`;
			const response = await this.#withTimeout((signal) => this.#fetch(url, { signal }));
			if (!response.ok) {
				throw new Error(`Hindsight list mental-models failed at offset ${offset}: ${response.status}`);
			}
			const payload = (await response.json()) as {
				items: Array<{ id: string; content?: string | null; last_refreshed_at?: string | null }>;
			};
			for (const item of payload.items) {
				if (!item.id.startsWith(VOICE_MODEL_PREFIX)) continue;
				out.push({
					id: item.id,
					content: item.content ?? null,
					lastRefreshed: item.last_refreshed_at ?? null
				});
			}
			if (payload.items.length < size) break;
		}
		return out;
	}

	/**
	 * The 6-hourly heartbeat. Re-mirrors every voice model unconditionally — a model whose
	 * `last_refreshed_at` is null (a create with no refresh yet) still gets its current
	 * content written, so a restart-recovered model reaches disk even if the change-driven
	 * `drain` skipped it. Uses the paginated list-with-content (no N+1 `getMentalModel`),
	 * and updates `#lastMirroredAt` so the next `drain` does not re-fetch what this just
	 * wrote.
	 */
	async #mirrorAll(): Promise<void> {
		for (const model of await this.#listVoiceModelsPaginated()) {
			const content = (model.content ?? '').trim();
			if (!looksLikeVoiceDocument(content)) continue;
			this.#files.write(model.id.slice(VOICE_MODEL_PREFIX.length), content);
			if (model.lastRefreshed) this.#lastMirroredAt.set(model.id, model.lastRefreshed);
		}
	}

	/**
	 * The change-driven mirror. Compares each model's `last_refreshed_at` against the last
	 * content written to disk and fetches/writes only the models that advanced. A null
	 * `last_refreshed_at` (a freshly created model that has not yet refreshed) is treated
	 * as "never mirrored" so the first refresh reaches disk promptly rather than waiting
	 * for the 6-hourly `reflect`. The `looksLikeVoiceDocument` write filter still gates
	 * what reaches disk — it is verified against the live document and rejects the
	 * in-flight placeholder and the "no information" failure mode alike.
	 */
	async #mirrorChanged(): Promise<void> {
		for (const model of await this.#listVoiceModelsPaginated()) {
			const last = this.#lastMirroredAt.get(model.id) ?? null;
			if (model.lastRefreshed === last && last !== null) continue;
			const content = (model.content ?? '').trim();
			if (!looksLikeVoiceDocument(content)) {
				// Even a rejected document advances the cache: remember its refresh timestamp
				// so we do not re-fetch it every tick until the nightly cron refreshes it.
				if (model.lastRefreshed) this.#lastMirroredAt.set(model.id, model.lastRefreshed);
				continue;
			}
			this.#files.write(model.id.slice(VOICE_MODEL_PREFIX.length), content);
			if (model.lastRefreshed) this.#lastMirroredAt.set(model.id, model.lastRefreshed);
		}
	}

	async #ensureGlobalModel(): Promise<void> {
		await this.#ensureModel(GLOBAL_MODEL_ID, GLOBAL_SOURCE_QUERY, ['voice'], 1_200);
	}

	async #ensureChatModel(chatJid: string): Promise<void> {
		await this.#ensureModel(
			`${VOICE_MODEL_PREFIX}${voiceFileStem(chatJid)}`,
			CHAT_SOURCE_QUERY,
			[chatTag(chatJid)],
			800
		);
	}

	async #ensureModel(id: string, sourceQuery: string, tags: string[], maxTokens: number): Promise<void> {
		const existing = this.#ensuring.get(id);
		if (existing) return existing;
		const pending = this.#createModelIfMissing(id, sourceQuery, tags, maxTokens).catch((error) => {
			// Model creation is never worth failing a retain or a draft over.
			this.#ensuring.delete(id);
			this.#log.warn(`[memory] could not ensure voice model ${id}`, error);
		});
		this.#ensuring.set(id, pending);
		return pending;
	}

	async #createModelIfMissing(
		id: string,
		sourceQuery: string,
		tags: string[],
		maxTokens: number
	): Promise<void> {
		try {
			await this.#withTimeout((signal) => this.#client.getMentalModel(this.#bankId, id, { signal }));
			return;
		} catch {
			// Not there yet — fall through and create it.
		}
		await this.#withTimeout((signal) => this.#client.createMentalModel(this.#bankId, id, sourceQuery, {
			id,
			tags,
			maxTokens,
			// Explicit, not inherited: the default for a tagged model is `all_strict`, which
			// silently drops memories carrying only a subset of the model's tags. Each voice
			// model carries exactly one tag, so `all_strict` matches every memory bearing it
			// while still excluding untagged memories (`any`/`all` would let them leak in).
			trigger: { tagsMatch: 'all_strict', refreshAfterConsolidation: false },
			signal
		}));
		await this.#configureRefreshCron(id, tags);
	}

	/**
	 * The 0.8.5 typed client drops `refresh_cron` when building the request body, so the
	 * schedule is set over raw REST. `refresh_after_consolidation` is sent as false in the
	 * same PATCH because the two triggers are mutually exclusive server-side, and PATCH
	 * replaces the trigger object wholesale — `tags_match` has to be restated with it.
	 */
	async #configureRefreshCron(id: string, tags: string[]): Promise<void> {
		const url = `${this.#baseUrl}/v1/default/banks/${encodeURIComponent(this.#bankId)}/mental-models/${encodeURIComponent(id)}`;
		const response = await this.#withTimeout((signal) => this.#fetch(url, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tags,
				trigger: {
					refresh_cron: this.#refreshCron,
					refresh_after_consolidation: false,
					tags_match: 'all_strict'
				}
			}),
			signal
		}));
		if (!response.ok) {
			throw new Error(`Hindsight refresh_cron PATCH failed for ${id}: ${response.status}`);
		}
	}

	async #retain(retain: PendingRetain): Promise<void> {
		if (Date.now() < this.#offlineUntil) {
			this.#queue(retain);
			return;
		}
		try {
			await this.#flushQueued();
			await this.#send(retain);
			// Ensure the global model exists now that the bank has at least one observation.
		 // Creating it earlier would make Hindsight synthesize a "no information about the
		 // owner's writing habits" document from an empty bank. `#ensureModel` dedupes via
		 // `#ensuring`, so the bootstrap's hundreds of retains pay one creation, not
		 // hundreds — the rest return the same in-flight promise. Per-chat models stay
		 // deferred to a real edit/skip demand signal. Awaited (not fire-and-forget) so a
		 // reflect that runs immediately after sees the created model, but errors here
		 // are swallowed inside `#ensureModel` and never fail the retain.
			await this.#ensureGlobalModel();
		} catch (error) {
			this.#queue(retain);
			this.#offlineUntil = Date.now() + this.#retryDelayMs;
			this.#log.warn('[memory] Hindsight unavailable; queued observation locally', error);
		}
	}

	#queue(retain: PendingRetain): void {
		this.#queued.push(retain);
		if (this.#queued.length > this.#maxQueuedRetains) this.#queued.shift();
	}

	async #flushQueued(): Promise<void> {
		while (this.#queued.length > 0) {
			const pending = this.#queued[0]!;
			await this.#send(pending);
			this.#queued.shift();
		}
	}

	async #send(retain: PendingRetain): Promise<void> {
		await this.#withTimeout(
			(signal) => this.#client.retain(this.#bankId, retain.content, {
				context: retain.context,
				metadata: retain.metadata,
				tags: retain.tags,
				documentId: retain.documentId,
				updateMode: retain.updateMode,
				signal
			}),
			this.#retainTimeoutMs
		);
	}

	async #withTimeout<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		timeoutMs: number = this.#timeoutMs
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await operation(controller.signal);
		} finally {
			clearTimeout(timeout);
		}
	}
}

export type MemoryMode = 'off' | 'null' | 'hindsight';

/**
 * `dataDir` is required rather than defaulted: the voice mirror writes real files, and
 * silently defaulting to the live data dir would let a test or a worktree write into it.
 */
export function createRuntimeMemory(
	settings: Readonly<Record<string, string>>,
	options: { dataDir: string }
): Memory {
	const mode = (settings.memory ?? 'hindsight') as MemoryMode;
	if (mode === 'off') return new NullMemory();
	const fallback = new NullMemory({ captureVoice: true });
	if (mode !== 'hindsight') return fallback;
	return new HindsightMemory({
		dataDir: options.dataDir,
		baseUrl: settings.hindsight_url ?? DEFAULT_BASE_URL,
		bankId: settings.hindsight_bank ?? DEFAULT_BANK_ID,
		refreshCron: settings.hindsight_refresh_cron ?? DEFAULT_REFRESH_CRON,
		fallback
	});
}
