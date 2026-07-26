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
	): Promise<{ items: Array<{ id: string }> }>;
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
	timeoutMs?: number;
	maxQueuedRetains?: number;
	retryDelayMs?: number;
	refreshCron?: string;
	maxVoiceChars?: number;
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
	readonly #maxQueuedRetains: number;
	readonly #retryDelayMs: number;
	readonly #refreshCron: string;
	readonly #maxVoiceChars: number;
	readonly #fetch: typeof fetch;
	readonly #log: Pick<Console, 'warn'>;
	readonly #files: VoiceFiles;
	readonly #queued: PendingRetain[] = [];
	/** Dedupes concurrent ensures; a failed ensure is dropped so the next call retries. */
	readonly #ensuring = new Map<string, Promise<void>>();
	#offlineUntil = 0;

	constructor(options: HindsightMemoryOptions) {
		this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.#client = options.client ?? new HindsightClient({ baseUrl: this.#baseUrl });
		this.#bankId = options.bankId ?? DEFAULT_BANK_ID;
		this.#fallback = options.fallback ?? new NullMemory({ captureVoice: true });
		this.#timeoutMs = options.timeoutMs ?? 2_000;
		this.#maxQueuedRetains = options.maxQueuedRetains ?? 1_000;
		this.#retryDelayMs = options.retryDelayMs ?? 30_000;
		this.#refreshCron = options.refreshCron ?? DEFAULT_REFRESH_CRON;
		this.#maxVoiceChars = options.maxVoiceChars ?? 6_000;
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
	 */
	async reflect(): Promise<void> {
		if (Date.now() < this.#offlineUntil) return;
		try {
			await this.#flushQueued();
			await this.#ensureGlobalModel();
			await this.#mirrorAll();
		} catch (error) {
			this.#offlineUntil = Date.now() + this.#retryDelayMs;
			this.#log.warn('[memory] Hindsight voice sync unavailable; keeping the mirrored files', error);
		}
	}

	/**
	 * Owner-triggered "refresh now" (D1b), so the nightly cron never blocks demonstrating
	 * the loop. Refresh is asynchronous server-side: this submits it and mirrors whatever
	 * is present now — the regenerated content lands on a later `reflect`.
	 */
	async refreshVoiceModels(): Promise<string[]> {
		await this.#ensureGlobalModel();
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

	async #listVoiceModelIds(): Promise<string[]> {
		const models = await this.#withTimeout((signal) =>
			this.#client.listMentalModels(this.#bankId, { signal })
		);
		return models.items.map((model) => model.id).filter((id) => id.startsWith(VOICE_MODEL_PREFIX));
	}

	/** The model id carries its own file stem, so the mirror needs no lookup table. */
	async #mirrorAll(): Promise<void> {
		for (const id of await this.#listVoiceModelIds()) {
			const model = await this.#withTimeout((signal) =>
				this.#client.getMentalModel(this.#bankId, id, { signal })
			);
			const content = (model.content ?? '').trim();
			if (!content || content === REFRESH_IN_PROGRESS_CONTENT) continue;
			this.#files.write(id.slice(VOICE_MODEL_PREFIX.length), content);
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
		await this.#withTimeout((signal) => this.#client.retain(this.#bankId, retain.content, {
			context: retain.context,
			metadata: retain.metadata,
			tags: retain.tags,
			documentId: retain.documentId,
			updateMode: retain.updateMode,
			signal
		}));
	}

	async #withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
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
