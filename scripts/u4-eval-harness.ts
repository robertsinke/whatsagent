/**
 * W4-U4 — Offline draft-quality evaluation harness.
 *
 * Samples real inbound messages that the owner actually replied to, hides the
 * owner's real reply (and anything the owner sent after it in that chat), drafts
 * one with the configured provider via the real `draftChat` path, then compares
 * the draft against what the owner really wrote.
 *
 * Hard safety rules (enforced by the colocated test):
 * - Runs against a **copy** of the database, never the live file. The runner
 *   copies the live DB to a temp dir and opens that; `selectEvalPairs` and
 *   `runEvalHarness` never touch the live path.
 * - Never starts the real backend and never constructs a WhatsApp channel.
 *   `runEvalHarness` takes a `DraftProvider` and a `Memory` — no transport, no
 *   outbox. The provider is the only thing that can leave the machine, and the
 *   configured Ollama provider only speaks HTTP to the local Ollama server.
 * - The outbox is never touched: `draftChat` does not enqueue, and the test
 *   asserts the outbox row count is unchanged after a run.
 *
 * This is a development script (like `scripts/u6-refinement-smoke.ts`), not
 * shipped UI. It does not need a route or a settings toggle.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftChat } from '../server/agent/drafter.js';
import { NullMemory } from '../server/agent/memory/null-memory.js';
import { OllamaProvider } from '../server/providers/ollama.js';
import { getChat, setChatAgentState } from '../server/store/chats.js';
import { openDatabase, getDefaultDataDir, getDatabasePath, type AppDatabase } from '../server/store/db.js';
import { listOutbox } from '../server/store/outbox.js';
import { upsertMessage, type Message } from '../server/store/messages.js';
import type { DraftProvider } from '../server/providers/provider.js';
import type { Memory } from '../server/agent/memory/memory.js';

/** A short, human-readable label for a chat jid in the report. */
function chatLabel(db: AppDatabase, jid: string): string {
	const chat = getChat(db, jid);
	if (chat?.name) return `${chat.name} (${jid})`;
	return jid;
}

/** A (inbound, owner reply) pair drawn from the owner's real history. */
export type EvalPair = {
	chatJid: string;
	/** Human-readable label for the report, resolved at selection time. */
	label: string;
	inbound: { id: string; ts: number; text: string };
	ownerReply: { id: string; ts: number; text: string };
	/** All rows in this chat with ts > inbound.ts, to hide while drafting. */
	hideMessages: { id: string; row: Message }[];
};

/**
 * Select (inbound, owner reply) pairs from a database. An inbound qualifies when
 * it is a 1:1, non-muted, non-archived chat's text inbound that the owner
 * answered with a from-me text reply within `replyWindowMs`. The owner reply is
 * the earliest from-me text after the inbound. Every row in that chat with
 * `ts > inbound.ts` is recorded for hiding, so the inbound becomes the last
 * message and the classifier accepts it.
 */
export function selectEvalPairs(db: AppDatabase, replyWindowMs = 86_400_000): EvalPair[] {
	const chats = db
		.prepare(
			`SELECT jid FROM chats
			 WHERE kind = '1:1' AND muted = 0 AND archived = 0`
		)
		.all() as { jid: string }[];

	const pairs: EvalPair[] = [];
	const inboundStmt = db.prepare(
		`SELECT id, ts, text FROM messages
		 WHERE chat_jid = ? AND from_me = 0 AND type = 'text'
		   AND text IS NOT NULL AND length(text) > 0
		 ORDER BY ts ASC, id ASC`
	);
	const firstReplyStmt = db.prepare(
		`SELECT id, ts, text FROM messages
		 WHERE chat_jid = ? AND from_me = 1 AND type = 'text'
		   AND text IS NOT NULL AND length(text) > 0
		   AND ts > ? AND ts <= ?
		 ORDER BY ts ASC, id ASC
		 LIMIT 1`
	);
	const laterFromMeStmt = db.prepare(
		`SELECT * FROM messages
		 WHERE chat_jid = ? AND ts > ?
		 ORDER BY ts ASC, id ASC`
	);

	for (const { jid } of chats) {
		const label = chatLabel(db, jid);
		const inbounds = inboundStmt.all(jid) as { id: string; ts: number; text: string }[];
		for (const ib of inbounds) {
			const reply = firstReplyStmt.get(jid, ib.ts, ib.ts + replyWindowMs) as
				| { id: string; ts: number; text: string }
				| undefined;
			if (!reply) continue;
			const hide = (laterFromMeStmt.all(jid, ib.ts) as Message[]).map((row) => ({
				id: row.id,
				row
			}));
			pairs.push({
				chatJid: jid,
				label,
				inbound: { id: ib.id, ts: ib.ts, text: ib.text },
				ownerReply: { id: reply.id, ts: reply.ts, text: reply.text },
				hideMessages: hide
			});
		}
	}
	return pairs;
}

/**
 * Similarity metrics kept deliberately simple and explainable. No NLP deps.
 * - `lengthRatio`: draft words / owner words (1.0 = same length, <1 shorter).
 * - `tokenOverlap`: |draft ∩ owner| / |draft ∪ owner| (Jaccard over word
 *   tokens, case-insensitive, punctuation stripped).
 * - `languageMatch`: best-effort — true when both texts share the dominant
 *   script of the owner's reply. Detects the common failure of replying in the
 *   wrong language.
 */
export type SimilarityMetrics = {
	lengthRatio: number;
	tokenOverlap: number;
	languageMatch: boolean;
};

const WORD_RE = /[\p{L}\p{N}]+/gu;

function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const match of text.toLowerCase().matchAll(WORD_RE)) {
		tokens.add(match[0]);
	}
	return tokens;
}

function dominantScript(text: string): 'latin' | 'cyrillic' | 'arabic' | 'cjk' | 'other' {
	let latin = 0;
	let cyrillic = 0;
	let arabic = 0;
	let cjk = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		if (code >= 0x0041 && code <= 0x024f) latin++;
		else if (code >= 0x0400 && code <= 0x04ff) cyrillic++;
		else if (code >= 0x0600 && code <= 0x06ff) arabic++;
		else if (code >= 0x4e00 && code <= 0x9fff) cjk++;
	}
	if (cyrillic > 0 && cyrillic >= latin && cyrillic >= arabic && cyrillic >= cjk) return 'cyrillic';
	if (arabic > 0 && arabic >= latin && arabic >= cyrillic && arabic >= cjk) return 'arabic';
	if (cjk > 0 && cjk >= latin && cjk >= cyrillic && cjk >= arabic) return 'cjk';
	if (latin > 0) return 'latin';
	return 'other';
}

export function computeSimilarity(draft: string, ownerReply: string): SimilarityMetrics {
	const draftTokens = tokenize(draft);
	const ownerTokens = tokenize(ownerReply);
	const draftCount = draftTokens.size;
	const ownerCount = ownerTokens.size;
	const union = new Set([...draftTokens, ...ownerTokens]);
	const intersection = [...draftTokens].filter((t) => ownerTokens.has(t)).length;
	const ownerWordCount = ownerReply.trim().split(/\s+/).filter(Boolean).length;
	const draftWordCount = draft.trim().split(/\s+/).filter(Boolean).length;
	return {
		lengthRatio: ownerWordCount === 0 ? 0 : draftWordCount / ownerWordCount,
		tokenOverlap: union.size === 0 ? 0 : intersection / union.size,
		languageMatch: dominantScript(draft) === dominantScript(ownerReply)
	};
}

/** A human-skimmable side-by-side for one sample. */
export function formatSideBySide(
	pair: EvalPair,
	draft: string | null,
	metrics: SimilarityMetrics,
	label?: string
): string {
	const name = label ?? pair.label ?? pair.chatJid;
	const lines: string[] = [];
	lines.push(`### ${name} — inbound ${pair.inbound.id}`);
	lines.push('');
	lines.push('**Inbound (what the contact sent):**');
	lines.push('```');
	lines.push(pair.inbound.text);
	lines.push('```');
	lines.push('');
	lines.push('**Owner actually replied:**');
	lines.push('```');
	lines.push(pair.ownerReply.text);
	lines.push('```');
	lines.push('');
	lines.push('**Agent drafted:**');
	lines.push('```');
	lines.push(draft ?? '(no draft — no_reply_needed or failed)');
	lines.push('```');
	lines.push('');
	lines.push(
		`metrics: lengthRatio=${metrics.lengthRatio.toFixed(2)} ` +
			`tokenOverlap=${metrics.tokenOverlap.toFixed(2)} ` +
			`languageMatch=${metrics.languageMatch}`
	);
	lines.push('');
	return lines.join('\n');
}

export type EvalSampleResult = {
	pair: EvalPair;
	draft: string | null;
	kind: 'draft' | 'no_reply_needed' | 'failed';
	metrics: SimilarityMetrics;
	elapsedMs: number;
};

export type EvalRunResult = {
	samples: EvalSampleResult[];
	/** Mean token overlap over samples that produced a draft. */
	meanTokenOverlap: number;
	/** Mean length ratio over samples that produced a draft. */
	meanLengthRatio: number;
	/** Fraction of drafted samples whose language matched the owner's. */
	languageMatchRate: number;
	/** Fraction of samples that produced a draft (not no_reply_needed/failed). */
	draftRate: number;
	/** Fraction of samples that failed with a provider error. */
	failureRate: number;
	outboxRowsBefore: number;
	outboxRowsAfter: number;
};

export type RunEvalHarnessOptions = {
	db: AppDatabase;
	provider: DraftProvider;
	providerName: string;
	memory?: Memory;
	/** Pairs to evaluate; defaults to all selectable pairs. */
	pairs?: EvalPair[];
	/** Max samples to evaluate (random sample of `pairs`). Default: all. */
	sampleSize?: number;
	/** RNG seed for deterministic sampling. */
	seed?: number;
	/** Conversation limit passed to `draftChat`. Default: 50. */
	conversationLimit?: number;
	/** Called once per sample with the result, for streaming progress. */
	onSample?: (result: EvalSampleResult, index: number, total: number) => void;
};

/**
 * Run the evaluation harness against `db`. The database must be a copy — the
 * harness mutates it (hides owner replies, writes draft rows) and does not
 * restore it. The caller owns the copy's lifecycle.
 *
 * The harness never receives a transport and never calls the outbox. `draftChat`
 * is the only drafting entry point, and it does not enqueue. The outbox row count
 * is recorded before and after the run so a regression that introduces a send
 * path is caught by the colocated test.
 */
export async function runEvalHarness(options: RunEvalHarnessOptions): Promise<EvalRunResult> {
	const db = options.db;
	const memory = options.memory ?? new NullMemory();
	const conversationLimit = options.conversationLimit ?? 50;
	const pairs = options.pairs ?? selectEvalPairs(db);
	const sampled = samplePairs(pairs, options.sampleSize, options.seed);

	const outboxRowsBefore = listOutbox(db).length;
	const samples: EvalSampleResult[] = [];

	for (let i = 0; i < sampled.length; i++) {
		const pair = sampled[i]!;
		// Hide every from-me message after the inbound so it becomes the last
		// message and the classifier accepts the chat. We delete by id and
		// restore by re-inserting the original row afterwards — the conversation
		// context for the next sample stays intact.
		for (const hide of pair.hideMessages) {
			db.prepare('DELETE FROM messages WHERE id = ?').run(hide.id);
		}
		// Reset agent state so the classifier does not skip the chat.
		setChatAgentState(db, pair.chatJid, null);

		const start = Date.now();
		let draft: string | null = null;
		let kind: EvalSampleResult['kind'] = 'failed';
		try {
			const result = await draftChat({
				db,
				provider: options.provider,
				providerName: options.providerName,
				memory,
				chatJid: pair.chatJid,
				conversationLimit
			});
			if (result.kind === 'ready') {
				draft = result.draft.text;
				kind = 'draft';
			} else if (result.kind === 'no_reply_needed') {
				kind = 'no_reply_needed';
			} else {
				kind = 'failed';
			}
		} catch {
			kind = 'failed';
		}
		const elapsedMs = Date.now() - start;

		// Restore the hidden messages so the next sample sees the real history.
		for (const hide of pair.hideMessages) {
			upsertMessage(db, hide.row);
		}

		const metrics = draft ? computeSimilarity(draft, pair.ownerReply.text) : zeroMetrics();
		const result: EvalSampleResult = { pair, draft, kind, metrics, elapsedMs };
		samples.push(result);
		options.onSample?.(result, i, sampled.length);
	}

	const outboxRowsAfter = listOutbox(db).length;
	return summarize(samples, outboxRowsBefore, outboxRowsAfter);
}

function zeroMetrics(): SimilarityMetrics {
	return { lengthRatio: 0, tokenOverlap: 0, languageMatch: false };
}

function samplePairs(pairs: EvalPair[], sampleSize?: number, seed?: number): EvalPair[] {
	if (sampleSize === undefined || sampleSize >= pairs.length) return pairs;
	const rng = mulberry32(seed ?? 0xc0ffee);
	const indices = pairs.map((_, i) => i);
	// Fisher-Yates shuffle.
	for (let i = indices.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[indices[i], indices[j]] = [indices[j]!, indices[i]!];
	}
	return indices.slice(0, sampleSize).map((i) => pairs[i]!);
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function summarize(
	samples: EvalSampleResult[],
	outboxRowsBefore: number,
	outboxRowsAfter: number
): EvalRunResult {
	const drafted = samples.filter((s) => s.kind === 'draft');
	const failed = samples.filter((s) => s.kind === 'failed');
	const meanTokenOverlap =
		drafted.length === 0
			? 0
			: drafted.reduce((sum, s) => sum + s.metrics.tokenOverlap, 0) / drafted.length;
	const meanLengthRatio =
		drafted.length === 0
			? 0
			: drafted.reduce((sum, s) => sum + s.metrics.lengthRatio, 0) / drafted.length;
	const languageMatchRate =
		drafted.length === 0
			? 0
			: drafted.filter((s) => s.metrics.languageMatch).length / drafted.length;
	return {
		samples,
		meanTokenOverlap,
		meanLengthRatio,
		languageMatchRate,
		draftRate: samples.length === 0 ? 0 : drafted.length / samples.length,
		failureRate: samples.length === 0 ? 0 : failed.length / samples.length,
		outboxRowsBefore,
		outboxRowsAfter
	};
}

/** Format the full run summary plus per-sample side-by-side as markdown. */
export function formatReport(result: EvalRunResult): string {
	const lines: string[] = [];
	lines.push('# W4-U4 draft-quality evaluation');
	lines.push('');
	lines.push(`- samples: ${result.samples.length}`);
	lines.push(`- draftRate: ${result.draftRate.toFixed(2)}`);
	lines.push(`- failureRate: ${result.failureRate.toFixed(2)}`);
	lines.push(`- meanTokenOverlap: ${result.meanTokenOverlap.toFixed(3)}`);
	lines.push(`- meanLengthRatio: ${result.meanLengthRatio.toFixed(3)}`);
	lines.push(`- languageMatchRate: ${result.languageMatchRate.toFixed(2)}`);
	lines.push(`- outbox rows before/after: ${result.outboxRowsBefore}/${result.outboxRowsAfter}`);
	lines.push('');
	lines.push('## Per-sample side-by-side');
	lines.push('');
	for (const sample of result.samples) {
		lines.push(formatSideBySide(sample.pair, sample.draft, sample.metrics, sample.pair.label));
		lines.push(`_kind=${sample.kind} elapsed=${sample.elapsedMs}ms_`);
		lines.push('');
		lines.push('---');
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * Copy the live database to a temp dir and open the copy. Returns the copy's
 * database handle and the temp dir (the caller removes it). The live file is
 * never opened by the harness — only read once for the OS copy.
 */
export function openDatabaseCopy(options: {
	/** Path to the live DB to copy. Default: the platform app-data DB. */
	sourceDbPath?: string;
	/** Temp dir prefix. */
	prefix?: string;
}): { db: AppDatabase; dataDir: string; remove: () => void } {
	const source = options.sourceDbPath ?? getDatabasePath({ dataDir: getDefaultDataDir() });
	const dataDir = mkdtempSync(join(tmpdir(), options.prefix ?? 'whatsagent-u4-eval-'));
	const destPath = join(dataDir, 'whatsagent.db');
	copyFileSync(source, destPath);
	// Also copy WAL/SHM if present so the copy reflects committed state.
	for (const suffix of ['-wal', '-shm']) {
		try {
			copyFileSync(`${source}${suffix}`, `${destPath}${suffix}`);
		} catch {
			// Absent is fine.
		}
	}
	const db = openDatabase({ dataDir });
	return {
		db,
		dataDir,
		remove: () => {
			db.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const sampleSize = parseFlag(args, '--samples');
	const sourceDbPath = parseFlag(args, '--db');
	const outPath = parseFlag(args, '--out');
	const providerModel = parseFlag(args, '--model') ?? 'gemma3:4b';
	const baseUrl = parseFlag(args, '--base-url') ?? 'http://127.0.0.1:11434';

	const copy = openDatabaseCopy({
		sourceDbPath: sourceDbPath ? String(sourceDbPath) : undefined
	});

	const pairs = selectEvalPairs(copy.db);
	console.error(`[u4] ${pairs.length} (inbound, owner reply) pairs available`);
	const limit = sampleSize ? Number(sampleSize) : 30;
	console.error(`[u4] sampling ${limit} of them`);

	const provider = new OllamaProvider({ model: String(providerModel), baseUrl: String(baseUrl) });
	const result = await runEvalHarness({
		db: copy.db,
		provider,
		providerName: 'ollama',
		pairs,
		sampleSize: limit,
		seed: 12345,
		onSample: (s, i, total) => {
			const name = s.pair.label;
			console.error(
				`[u4] ${i + 1}/${total} ${name} kind=${s.kind} overlap=${s.metrics.tokenOverlap.toFixed(
					2
				)} lenRatio=${s.metrics.lengthRatio.toFixed(2)} lang=${s.metrics.languageMatch} ${s.elapsedMs}ms`
			);
		}
	});

	const report = formatReport(result);
	if (outPath) {
		const { writeFileSync } = await import('node:fs');
		writeFileSync(String(outPath), report, 'utf8');
		console.error(`[u4] report written to ${outPath}`);
	} else {
		console.log(report);
	}

	console.error(
		`[u4] baseline meanTokenOverlap=${result.meanTokenOverlap.toFixed(3)} ` +
			`meanLengthRatio=${result.meanLengthRatio.toFixed(3)} ` +
			`languageMatchRate=${result.languageMatchRate.toFixed(2)} ` +
			`draftRate=${result.draftRate.toFixed(2)} ` +
			`outbox=${result.outboxRowsBefore}->${result.outboxRowsAfter}`
	);

	copy.remove();
}

function parseFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

const entry = process.argv[1];
if (typeof entry === 'string' && import.meta.url === `file://${entry}`) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}