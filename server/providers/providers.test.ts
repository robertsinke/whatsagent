import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { OllamaProvider } from './ollama.js';
import { createDraftProvider } from './index.js';
import {
	buildRefinementInput,
	type ChildProcessLike,
	type DraftInput,
	type SpawnProcess
} from './provider.js';

const input: DraftInput = {
	system: 'Draft a concise reply in the owner voice.',
	conversation: [
		{ role: 'user', content: 'Are we still meeting at 7?' },
		{ role: 'assistant', content: 'Yes, that works.' }
	]
};

describe('refinement prompts', () => {
	it('builds a closed, preview-specific request for the same provider contract', () => {
		const refinement = buildRefinementInput(input.conversation, 'shorter', 'Current preview');

		expect(refinement.conversation).toBe(input.conversation);
		expect(refinement.system).toContain('Make the current draft shorter');
		expect(refinement.system).toContain('Current preview');
		expect(refinement.system).toContain('never return no_reply_needed');
	});
});

function fixture(name: string): string {
	return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

class FakeChild extends EventEmitter implements ChildProcessLike {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdinText = '';
	killed = false;
	stdin = {
		write: (data: string) => {
			this.stdinText += data;
		},
		end: () => undefined,
		on: () => undefined
	};

	constructor(
		stdout: string,
		private readonly exitCode: number | null = 0,
		stderr = '',
		autoClose = true
	) {
		super();
		if (autoClose) {
			setTimeout(() => {
				if (stdout) this.stdout.emit('data', Buffer.from(stdout));
				if (stderr) this.stderr.emit('data', Buffer.from(stderr));
				this.emit('close', this.exitCode, null);
			}, 0);
		}
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

function fakeSpawn(
	transcripts: Array<{ stdout?: string; stderr?: string; exitCode?: number | null; autoClose?: boolean }>
): { spawn: SpawnProcess; calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>; children: FakeChild[] } {
	const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
	const children: FakeChild[] = [];
	const spawn: SpawnProcess = (command, args, options) => {
		const transcript = transcripts.shift();
		if (!transcript) throw new Error('No fake transcript queued');
		calls.push({ command, args, env: options.env });
		const child = new FakeChild(
			transcript.stdout ?? '',
			transcript.exitCode === undefined ? 0 : transcript.exitCode,
			transcript.stderr,
			transcript.autoClose ?? true
		);
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}

describe('ClaudeProvider', () => {
	it('parses stream JSON and ignores in-band Error text', async () => {
		const process = fakeSpawn([{ stdout: fixture('claude-success.jsonl') }]);
		const provider = new ClaudeProvider({ spawn: process.spawn });

		await expect(provider.draft(input)).resolves.toEqual({
			kind: 'draft',
			text: 'Sounds good, see you then.'
		});
		expect(process.calls[0]?.args).toContain('stream-json');
		expect(process.children[0]?.stdinText).toContain('"type":"user"');
	});

	it('builds a child env without Anthropic API credentials', async () => {
		const process = fakeSpawn([{ stdout: fixture('claude-success.jsonl') }]);
		const provider = new ClaudeProvider({
			spawn: process.spawn,
			env: {
				PATH: '/usr/bin',
				HOME: '/tmp/home',
				ANTHROPIC_API_KEY: 'api-secret',
				ANTHROPIC_AUTH_TOKEN: 'auth-secret'
			}
		});

		await provider.draft(input);
		expect(process.calls[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/home' });
	});

	it('backs off once on a rejected rate-limit event', async () => {
		const rejected = `${JSON.stringify({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected', resetsAt: 2 }
		})}\n`;
		const process = fakeSpawn([
			{ stdout: rejected },
			{ stdout: fixture('claude-success.jsonl') }
		]);
		const sleep = vi.fn(async () => undefined);
		const provider = new ClaudeProvider({ spawn: process.spawn, sleep, now: () => 1_000 });

		await expect(provider.draft(input)).resolves.toMatchObject({ kind: 'draft' });
		expect(sleep).toHaveBeenCalledOnce();
		expect(sleep).toHaveBeenCalledWith(1_000);
		expect(process.calls).toHaveLength(2);
	});
});

describe('CodexProvider', () => {
	it('parses Codex JSONL and strips OPENAI_API_KEY', async () => {
		const process = fakeSpawn([{ stdout: fixture('codex-success.jsonl') }]);
		const provider = new CodexProvider({
			spawn: process.spawn,
			env: {
				PATH: '/usr/bin',
				HOME: '/tmp/home',
				OPENAI_API_KEY: 'api-secret',
				CODEX_API_KEY: 'codex-secret'
			}
		});

		await expect(provider.draft(input)).resolves.toEqual({
			kind: 'draft',
			text: "I'll check and let you know."
		});
		expect(process.calls[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/home' });
		expect(process.calls[0]?.args).toEqual(
			expect.arrayContaining(['exec', '--json', '--ephemeral', 'read-only', '--output-schema', '-'])
		);
	});
});

describe('OllamaProvider', () => {
	it('sends the DraftResult JSON schema and returns no_reply_needed', async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body.format).toMatchObject({
				type: 'object',
				required: ['kind', 'text', 'reason'],
				additionalProperties: false
			});
			return new Response(
				JSON.stringify({
					message: {
						content: JSON.stringify({ kind: 'no_reply_needed', reason: 'Only an acknowledgement' })
					}
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		const provider = new OllamaProvider({ model: 'qwen3', fetch });

		await expect(provider.draft(input)).resolves.toEqual({
			kind: 'no_reply_needed',
			reason: 'Only an acknowledgement'
		});
	});
});

describe('typed process failures', () => {
	it('returns a typed error after one retry on non-zero exit', async () => {
		const process = fakeSpawn([
			{ exitCode: 2, stderr: 'login required' },
			{ exitCode: 2, stderr: 'login required' }
		]);
		const provider = new ClaudeProvider({ spawn: process.spawn, sleep: async () => undefined });

		await expect(provider.draft(input)).rejects.toMatchObject({
			name: 'ProviderError',
			code: 'process_exit',
			retryable: true
		});
	});

	it('returns a typed error after one retry on timeout', async () => {
		const process = fakeSpawn([{ autoClose: false }, { autoClose: false }]);
		const provider = new ClaudeProvider({
			spawn: process.spawn,
			timeoutMs: 5,
			killGraceMs: 1,
			sleep: async () => undefined
		});

		await expect(provider.draft(input)).rejects.toMatchObject({
			name: 'ProviderError',
			code: 'timeout',
			retryable: true
		});
		expect(process.children.every((child) => child.killed)).toBe(true);
	});
});

describe('provider selection', () => {
	it('creates the provider selected by persisted settings', () => {
		expect(createDraftProvider({ provider: 'claude' })).toBeInstanceOf(ClaudeProvider);
		expect(createDraftProvider({ provider: 'codex' })).toBeInstanceOf(CodexProvider);
		expect(createDraftProvider({ provider: 'ollama', provider_model: 'llama3.2' })).toBeInstanceOf(
			OllamaProvider
		);
	});
});
