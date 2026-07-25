import { HindsightClient, type RecallResponse } from '@vectorize-io/hindsight-client';
import type { Chat } from '../../store/chats.js';
import { NullMemory } from './null-memory.js';
import type { EditDelta, Memory, VoiceObservation } from './memory.js';

const DEFAULT_BANK_ID = 'whatsagent-owner-voice';

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
	recall(
		bankId: string,
		query: string,
		options?: { tags?: string[]; tagsMatch?: 'all_strict'; maxTokens?: number; signal?: AbortSignal }
	): Promise<RecallResponse>;
	reflect(
		bankId: string,
		query: string,
		options?: { budget?: 'low'; signal?: AbortSignal }
	): Promise<unknown>;
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
	client?: HindsightClientLike;
	baseUrl?: string;
	bankId?: string;
	fallback?: Memory;
	timeoutMs?: number;
	maxQueuedRetains?: number;
	retryDelayMs?: number;
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
	readonly #fallback: Memory;
	readonly #timeoutMs: number;
	readonly #maxQueuedRetains: number;
	readonly #retryDelayMs: number;
	readonly #log: Pick<Console, 'warn'>;
	readonly #queued: PendingRetain[] = [];
	readonly #styleCache = new Map<string, string>();
	#offlineUntil = 0;

	constructor(options: HindsightMemoryOptions = {}) {
		this.#client = options.client ?? new HindsightClient({
			baseUrl: options.baseUrl ?? 'http://127.0.0.1:8888'
		});
		this.#bankId = options.bankId ?? DEFAULT_BANK_ID;
		this.#fallback = options.fallback ?? new NullMemory({ captureVoice: true });
		this.#timeoutMs = options.timeoutMs ?? 2_000;
		this.#maxQueuedRetains = options.maxQueuedRetains ?? 1_000;
		this.#retryDelayMs = options.retryDelayMs ?? 30_000;
		this.#log = options.log ?? console;
	}

	get queuedRetains(): number {
		return this.#queued.length;
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
	}

	async retainEditDelta(delta: EditDelta): Promise<void> {
		await this.#fallback.retainEditDelta(delta);
		await this.#retain({
			content: summarizeEdit(delta),
			context: delta.skipped ? 'Owner skipped an AI draft' : 'Owner edited an AI draft before approval',
			metadata: { chat_jid: delta.chatJid, signal: delta.skipped ? 'skip' : 'edit' },
			tags: [chatTag(delta.chatJid), delta.skipped ? 'skip' : 'edit', 'voice']
		});
	}

	async recallStyleFor(chat: Chat): Promise<string | null> {
		if (Date.now() < this.#offlineUntil) {
			return this.#styleCache.get(chat.jid) ?? this.#fallback.recallStyleFor(chat);
		}
		try {
			await this.#flushQueued();
			const response = await this.#withTimeout((signal) => this.#client.recall(
				this.#bankId,
				'How does the owner write to this contact, and what draft edits or skips should guide the next reply?',
				{ tags: [chatTag(chat.jid)], tagsMatch: 'all_strict', maxTokens: 500, signal }
			));
			const style = response.results.map((result) => result.text.trim()).filter(Boolean).join('\n');
			if (style) {
				this.#styleCache.set(chat.jid, style);
				return style;
			}
		} catch (error) {
			this.#offlineUntil = Date.now() + this.#retryDelayMs;
			this.#log.warn('[memory] Hindsight recall unavailable; using local voice fallback', error);
		}
		return this.#styleCache.get(chat.jid) ?? this.#fallback.recallStyleFor(chat);
	}

	async reflect(): Promise<void> {
		if (Date.now() < this.#offlineUntil) return;
		try {
			await this.#flushQueued();
			await this.#withTimeout((signal) => this.#client.reflect(
				this.#bankId,
				"Consolidate the owner's writing style and repeated draft corrections into durable guidance.",
				{ budget: 'low', signal }
			));
		} catch (error) {
			this.#offlineUntil = Date.now() + this.#retryDelayMs;
			this.#log.warn('[memory] Hindsight reflection unavailable', error);
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

export function createRuntimeMemory(settings: Readonly<Record<string, string>>): Memory {
	const mode = (settings.memory ?? 'null') as MemoryMode;
	if (mode === 'off') return new NullMemory();
	const fallback = new NullMemory({ captureVoice: true });
	if (mode !== 'hindsight') return fallback;
	return new HindsightMemory({
		baseUrl: settings.hindsight_url ?? 'http://127.0.0.1:8888',
		bankId: settings.hindsight_bank ?? DEFAULT_BANK_ID,
		fallback
	});
}
