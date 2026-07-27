import { spawn as nodeSpawn } from 'node:child_process';

export interface Turn {
	role: 'user' | 'assistant';
	content: string;
}

export interface DraftInput {
	system: string;
	conversation: Turn[];
}

export type DraftResult =
	| { kind: 'draft'; text: string }
	| { kind: 'no_reply_needed'; reason: string };

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
	preview: string
): DraftInput {
	return {
		system:
			'Refine a reply preview as the owner. Preserve facts, names, commitments, and the conversation language. ' +
			'Return a non-empty draft result; never return no_reply_needed. ' +
			refinementInstructions[intent] +
			`\n\nCurrent draft preview:\n${preview}`,
		conversation
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

export function buildPrompt(input: DraftInput): string {
	const conversation = input.conversation
		.map((turn) => `${turn.role === 'user' ? 'Contact' : 'Owner'}: ${turn.content}`)
		.join('\n');

	return `${conversation}\n\nReturn JSON only, matching exactly one of these shapes:\n{"kind":"draft","text":"...","reason":null}\n{"kind":"no_reply_needed","text":null,"reason":"..."}`;
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
		return { kind: 'draft', text: result.text };
	}
	if (
		result.kind === 'no_reply_needed' &&
		typeof result.reason === 'string' &&
		result.reason.trim()
	) {
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
		reason: { type: ['string', 'null'] }
	},
	required: ['kind', 'text', 'reason'],
	additionalProperties: false
} as const;
