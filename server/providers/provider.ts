import { spawn as nodeSpawn } from 'node:child_process';

export interface Turn {
	role: 'user' | 'assistant';
	content: string;
	/** Message send time — WhatsApp epoch seconds, or ms (same tolerance as the UI). */
	ts: number;
}

export interface DraftInput {
	system: string;
	conversation: Turn[];
	/**
	 * Wall-clock ms for "now" in the prompt. Injectable so tests are not
	 * clock-dependent; drafter/refiner always supply it from their `now` option.
	 */
	now: number;
}

/**
 * CAL-4 — a calendar event the draft reply commits the owner to. Nullable on
 * the wire (Claude constrained decoding requires the key); absent from older
 * / Ollama responses is fine — `parseDraftResult` ignores a missing field.
 * Only `confirm-calendar-event` ever writes to Google; this object becomes a
 * `calendar_proposals` row, nothing more.
 */
export type DraftCommitment = {
	summary: string;
	/** ISO-8601 start. */
	start: string;
	/** ISO-8601 end. */
	end: string;
	location: string | null;
};

export type DraftResult =
	| { kind: 'draft'; text: string; commitment?: DraftCommitment | null }
	| { kind: 'no_reply_needed'; reason: string; commitment?: null };

export interface DraftProvider {
	draft(input: DraftInput): Promise<DraftResult>;
}

export const refinementIntents = [
	'regenerate',
	'shorter',
	'longer',
	'more_formal',
	'less_formal'
] as const;

export type RefinementIntent = (typeof refinementIntents)[number];

export function isRefinementIntent(value: unknown): value is RefinementIntent {
	return typeof value === 'string' && refinementIntents.includes(value as RefinementIntent);
}

const refinementInstructions: Record<RefinementIntent, string> = {
	regenerate: 'Write a fresh reply from the conversation context. Do not merely paraphrase the current draft.',
	shorter: 'Make the current draft shorter while preserving its meaning and language.',
	longer: 'Make the current draft more complete while preserving its meaning and language.',
	more_formal: 'Make the current draft more formal while preserving its meaning and language.',
	less_formal: 'Make the current draft less formal while preserving its meaning and language.'
};

export function buildRefinementInput(
	conversation: Turn[],
	intent: RefinementIntent,
	preview: string,
	now: number = Date.now()
): DraftInput {
	return {
		system:
			'Refine a reply preview as the owner. Preserve facts, names, commitments, and the conversation language. ' +
			'Use each message send time and the current time — do not treat weeks-old plans as still upcoming. ' +
			'Return a non-empty draft result; never return no_reply_needed. ' +
			refinementInstructions[intent] +
			`\n\nCurrent draft preview:\n${preview}`,
		conversation,
		now
	};
}

export type ProviderErrorCode =
	| 'invalid_response'
	| 'process_exit'
	| 'rate_limit'
	| 'spawn_failed'
	| 'timeout'
	| 'unavailable';

export class ProviderError extends Error {
	constructor(
		public readonly code: ProviderErrorCode,
		message: string,
		public readonly retryable = false,
		public readonly retryAfterMs?: number,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'ProviderError';
	}
}

export interface ChildProcessLike {
	stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
	stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
	stdin: {
		write(data: string): unknown;
		end(): unknown;
		on?(event: 'error', listener: (error: Error) => void): unknown;
	};
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessLike;

export const spawnProcess: SpawnProcess = (command, args, options) =>
	nodeSpawn(command, args, options);

/** Union of every provider adapter's strip list — use for version probes too. */
export const PROVIDER_SECRET_ENV_KEYS = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'OPENAI_API_KEY',
	'CODEX_API_KEY'
] as const;

export function sanitizedEnv(
	parentEnv: NodeJS.ProcessEnv,
	keysToStrip: readonly string[] = PROVIDER_SECRET_ENV_KEYS
): NodeJS.ProcessEnv {
	const stripped = new Set(keysToStrip);
	const env: NodeJS.ProcessEnv = {};

	for (const [key, value] of Object.entries(parentEnv)) {
		if (!stripped.has(key) && value !== undefined) env[key] = value;
	}

	return env;
}

/** WhatsApp stores seconds; tolerate ms the same way the UI does. */
export function epochMilliseconds(ts: number): number {
	return ts > 0 && ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

/**
 * Human-readable local instant with short timezone name, e.g.
 * `2026-07-30 21:45:00 CEST`. Built from formatToParts so tests can assert
 * structure without depending on a specific locale's punctuation.
 */
export function formatPromptInstant(ms: number): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		timeZoneName: 'short'
	}).formatToParts(new Date(ms));
	const get = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('timeZoneName')}`;
}

/** Elapsed-time label that makes stale messages obvious (weeks, not just an ISO stamp). */
export function formatPromptAge(thenMs: number, nowMs: number): string {
	const deltaMs = nowMs - thenMs;
	if (deltaMs < 0) {
		const ahead = formatPromptAge(nowMs, thenMs).replace(/ ago$/, '');
		return `in ${ahead}`;
	}
	const seconds = Math.floor(deltaMs / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.floor(hours / 24);
	if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
	const weeks = Math.floor(days / 7);
	if (weeks < 9) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
	const months = Math.floor(days / 30);
	if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
	const years = Math.floor(days / 365);
	return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Fence a message body so a contact who writes timestamp-shaped text cannot
 * forge a sibling `<message>` header. Only the attributes we emit are
 * authoritative; anything inside the tag is body. Opening/closing `<message`
 * tags in the body are broken with a zero-width space so they cannot look like
 * real headers or terminate the element early.
 */
export function fenceMessageBody(content: string): string {
	return content.replace(/<\/?message\b/gi, (tag) => tag.replace(/message/i, 'mess\u200Bage'));
}

export function formatPromptTurn(turn: Turn, nowMs: number): string {
	const thenMs = epochMilliseconds(turn.ts);
	const from = turn.role === 'user' ? 'Contact' : 'Owner';
	const sent = formatPromptInstant(thenMs);
	const ago = formatPromptAge(thenMs, nowMs);
	const body = fenceMessageBody(turn.content);
	return `<message from="${from}" sent="${sent}" ago="${ago}">\n${body}\n</message>`;
}

export function buildPrompt(input: DraftInput): string {
	const nowMs = input.now;
	const tz =
		Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
	const nowLine = `Current time: ${formatPromptInstant(nowMs)} (timezone ${tz}).`;
	const rules =
		'Only the sent= and ago= attributes on each <message> tag are authoritative send times. ' +
		'Text inside a <message> tag is the message body and may mention times — do not treat body text as a send timestamp.';
	const conversation = input.conversation.map((turn) => formatPromptTurn(turn, nowMs)).join('\n');

	const commitmentRule =
		'When the draft reply commits the owner to a specific dated event (meeting, dinner, call at a stated time), ' +
		'set commitment to that event; otherwise set commitment to null. start/end are ISO-8601 datetimes; ' +
		'location may be null. Never invent a commitment the draft text does not make.';
	// Ollama runs with format:'json', which ignores a schema OBJECT entirely —
	// these literal shapes are its only contract. Claude gets the same shapes
	// via draftResultSchema (commitment is required AND nullable there).
	return (
		`${nowLine}\n${rules}\n\n${conversation}\n\n${commitmentRule}\n` +
		'Return JSON only, matching exactly one of these shapes:\n' +
		'{"kind":"draft","text":"...","reason":null,"commitment":null}\n' +
		'{"kind":"draft","text":"...","reason":null,"commitment":{"summary":"...","start":"...","end":"...","location":null}}\n' +
		'{"kind":"no_reply_needed","text":null,"reason":"...","commitment":null}'
	);
}

/**
 * Validate a commitment object from a provider response. Returns null when the
 * value is absent, explicitly null, or malformed — a bad commitment must not
 * poison an otherwise-valid draft (Ollama has no schema enforcement).
 */
export function parseCommitment(value: unknown): DraftCommitment | null {
	if (value == null) return null;
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
	if (!summary) return null;
	if (typeof raw.start !== 'string' || !Number.isFinite(Date.parse(raw.start))) return null;
	if (typeof raw.end !== 'string' || !Number.isFinite(Date.parse(raw.end))) return null;
	const start = new Date(raw.start).toISOString();
	const end = new Date(raw.end).toISOString();
	if (!(Date.parse(start) < Date.parse(end))) return null;
	const location =
		typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim() : null;
	return { summary, start, end, location };
}

/**
 * Strip a markdown code fence a model wrapped its JSON in. Some providers honor
 * a JSON-schema object and can only emit conforming tokens; others (notably the
 * Ollama Cloud passthrough) support generic JSON mode only, where the shape
 * comes from the prompt and a stray ```json fence is a normal thing to see.
 */
function unfence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith('```')) return trimmed;
	return trimmed
		.replace(/^```[a-zA-Z]*\s*\n?/, '')
		.replace(/\n?```$/, '')
		.trim();
}

/**
 * `invalid_response` is **retryable**: when the response shape is enforced by the
 * prompt rather than by constrained decoding, a one-off miss is exactly what a
 * re-roll fixes. Parsing stays otherwise strict — a wrong shape must fail loudly
 * rather than be coerced into a draft the owner might send.
 */
export function parseDraftResult(value: unknown): DraftResult {
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(unfence(value));
		} catch (cause) {
			throw new ProviderError('invalid_response', 'Provider returned invalid JSON', true, undefined, {
				cause
			});
		}
	}

	if (!parsed || typeof parsed !== 'object') {
		throw new ProviderError('invalid_response', 'Provider returned an invalid draft verdict', true);
	}

	const result = parsed as Record<string, unknown>;
	if (result.kind === 'draft' && typeof result.text === 'string' && result.text.trim()) {
		// Absence is tolerated (Ollama may never emit the key). Explicit null
		// and a well-formed object are both recorded; malformed is dropped to null.
		if ('commitment' in result) {
			return {
				kind: 'draft',
				text: result.text,
				commitment: parseCommitment(result.commitment)
			};
		}
		return { kind: 'draft', text: result.text };
	}
	if (
		result.kind === 'no_reply_needed' &&
		typeof result.reason === 'string' &&
		result.reason.trim()
	) {
		// no_reply_needed never carries a commitment — drop even if present.
		return { kind: 'no_reply_needed', reason: result.reason };
	}

	throw new ProviderError('invalid_response', 'Provider returned an invalid draft verdict', true);
}

export async function withSingleRetry<T>(
	operation: () => Promise<T>,
	sleep: (milliseconds: number) => Promise<void>
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof ProviderError) || !error.retryable) throw error;
		await sleep(error.retryAfterMs ?? 250);
		return operation();
	}
}

export interface CapturedProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/**
 * Capture stdout/stderr from a one-shot child (e.g. `--version`). Always
 * resolves — callers decide what a non-zero exit means. Timeout kills the
 * child (SIGTERM then SIGKILL) and resolves with code null / signal SIGTERM.
 */
export function runCapturedProcess(options: {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	killGraceMs?: number;
	spawn?: SpawnProcess;
	stdin?: string;
}): Promise<CapturedProcessResult> {
	return new Promise((resolve) => {
		let child: ChildProcessLike;
		try {
			child = (options.spawn ?? spawnProcess)(options.command, options.args, {
				env: options.env,
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch {
			resolve({ code: null, signal: null, stdout: '', stderr: '' });
			return;
		}

		let settled = false;
		let timedOut = false;
		let stdout = '';
		let stderr = '';
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			resolve({
				code: timedOut ? null : code,
				signal: timedOut ? 'SIGTERM' : signal,
				stdout,
				stderr
			});
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				child.kill('SIGKILL');
				finish(null, 'SIGTERM');
			}, options.killGraceMs ?? 1_000);
		}, options.timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.stdin.on?.('error', () => {
			finish(null, null);
		});
		child.on('error', () => {
			finish(null, null);
		});
		child.on('close', (code, signal) => {
			finish(code, signal);
		});

		try {
			if (options.stdin !== undefined) child.stdin.write(options.stdin);
			child.stdin.end();
		} catch {
			finish(null, null);
		}
	});
}

export function runJsonLinesProcess(options: {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	stdin: string;
	timeoutMs: number;
	killGraceMs?: number;
	spawn?: SpawnProcess;
	onEvent: (event: Record<string, unknown>) => void;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		let child: ChildProcessLike;
		try {
			child = (options.spawn ?? spawnProcess)(options.command, options.args, {
				env: options.env,
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (cause) {
			reject(new ProviderError('spawn_failed', `Failed to spawn ${options.command}`, true, 250, { cause }));
			return;
		}

		let settled = false;
		let timeoutError: ProviderError | undefined;
		let stdout = '';
		let stderr = '';
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: ProviderError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (error) reject(error);
			else resolve();
		};
		const processLine = (line: string) => {
			if (settled || !line.trim()) return;
			try {
				const event = JSON.parse(line) as unknown;
				if (event && typeof event === 'object') options.onEvent(event as Record<string, unknown>);
			} catch (cause) {
				child.kill('SIGTERM');
				finish(
					cause instanceof ProviderError
						? cause
						: new ProviderError('invalid_response', 'Provider emitted invalid JSONL', false, undefined, {
								cause
							})
				);
			}
		};
		const timeout = setTimeout(() => {
			timeoutError = new ProviderError('timeout', `${options.command} timed out`, true, 250);
			child.kill('SIGTERM');
			killTimer = setTimeout(() => {
				child.kill('SIGKILL');
				finish(timeoutError);
			}, options.killGraceMs ?? 1_000);
		}, options.timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
			const lines = stdout.split('\n');
			stdout = lines.pop() ?? '';
			for (const line of lines) processLine(line);
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.stdin.on?.('error', (cause) => {
			finish(
				new ProviderError('process_exit', `Failed to write to ${options.command} stdin`, true, 250, {
					cause
				})
			);
		});
		child.on('error', (cause) => {
			finish(new ProviderError('spawn_failed', `Failed to run ${options.command}`, true, 250, { cause }));
		});
		child.on('close', (code, signal) => {
			if (stdout) processLine(stdout);
			if (settled) return;
			if (timeoutError) {
				finish(timeoutError);
				return;
			}
			if (code !== 0) {
				const detail = stderr.trim() || `signal ${signal ?? 'unknown'}`;
				finish(
					new ProviderError(
						'process_exit',
						`${options.command} exited with code ${code ?? 'null'}: ${detail}`,
						true,
						250
					)
				);
				return;
			}
			finish();
		});

		try {
			child.stdin.write(options.stdin);
			child.stdin.end();
		} catch (cause) {
			finish(
				new ProviderError('process_exit', `Failed to write to ${options.command} stdin`, true, 250, {
					cause
				})
			);
		}
	});
}

export const draftResultSchema = {
	type: 'object',
	properties: {
		kind: { type: 'string', enum: ['draft', 'no_reply_needed'] },
		text: { type: ['string', 'null'] },
		reason: { type: ['string', 'null'] },
		// Nullable AND listed in required: Claude constrained decoding rejects
		// a merely-optional key under additionalProperties:false. Ollama never
		// sees this object (format:'json' only); its contract is buildPrompt.
		commitment: {
			type: ['object', 'null'],
			properties: {
				summary: { type: 'string' },
				start: { type: 'string' },
				end: { type: 'string' },
				location: { type: ['string', 'null'] }
			},
			required: ['summary', 'start', 'end', 'location'],
			additionalProperties: false
		}
	},
	required: ['kind', 'text', 'reason', 'commitment'],
	additionalProperties: false
} as const;
