import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { fakeSpawn } from './fake-spawn.js';
import { OllamaProvider } from './ollama.js';
import { createDraftProvider } from './index.js';
import { providerFactoryOptionsFromDiscovery } from './discovery.js';
import { buildRefinementInput, type DraftInput } from './provider.js';

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
		// Shell must be off: read-only sandbox alone still exposes command_execution.
		const args = process.calls[0]?.args ?? [];
		const disableAt = args.indexOf('--disable');
		expect(disableAt).toBeGreaterThanOrEqual(0);
		expect(args[disableAt + 1]).toBe('shell_tool');
	});
});

describe('OllamaProvider', () => {
	it('requests generic JSON mode and returns no_reply_needed', async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			// Not a schema object: the cloud passthrough ignores those and returns
			// prose. buildPrompt carries the shape instead.
			expect(body.format).toBe('json');
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

	it('accepts a response wrapped in a markdown code fence', async () => {
		const fenced = '```json\n{"kind":"draft","text":"Ja, tot vrijdag!","reason":null}\n```';
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: { content: fenced } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const provider = new OllamaProvider({ model: 'deepseek-v4-flash:cloud', fetch });

		await expect(provider.draft(input)).resolves.toEqual({
			kind: 'draft',
			text: 'Ja, tot vrijdag!'
		});
	});

	it('retries once when the model ignores the shape, then succeeds', async () => {
		// JSON mode guarantees syntax, not our keys — the shape comes from the
		// prompt, so a one-off miss must be re-rolled rather than failing the draft.
		const responses = [
			'Hoi! Ja, tot vrijdag.',
			JSON.stringify({ kind: 'draft', text: 'Hoi! Ja, tot vrijdag.', reason: null })
		];
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: { content: responses.shift() } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const provider = new OllamaProvider({
			model: 'deepseek-v4-flash:cloud',
			fetch,
			sleep: async () => undefined
		});

		await expect(provider.draft(input)).resolves.toEqual({
			kind: 'draft',
			text: 'Hoi! Ja, tot vrijdag.'
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('fails loudly when both attempts miss the shape', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: { content: 'just prose, no json' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const provider = new OllamaProvider({
			model: 'deepseek-v4-flash:cloud',
			fetch,
			sleep: async () => undefined
		});

		await expect(provider.draft(input)).rejects.toMatchObject({ code: 'invalid_response' });
		expect(fetch).toHaveBeenCalledTimes(2);
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

	it('throws on an unknown provider name', () => {
		expect(() => createDraftProvider({ provider: 'nope' })).toThrow(/Unknown draft provider/);
	});
});

function discoverySnapshot(
	overrides: Partial<{
		claudePath: string | null;
		codexPath: string | null;
		ollamaInstalled: boolean;
	}> = {}
) {
	const claudePath = overrides.claudePath === undefined ? null : overrides.claudePath;
	const codexPath = overrides.codexPath === undefined ? null : overrides.codexPath;
	const ollamaInstalled = overrides.ollamaInstalled ?? false;
	return {
		probedAt: 1,
		searchPath: [] as string[],
		providers: [
			{
				name: 'claude' as const,
				label: 'Claude',
				kind: 'cli' as const,
				installed: Boolean(claudePath),
				path: claudePath,
				pathSource: claudePath ? ('known-location' as const) : null,
				version: claudePath ? '2.1.220' : null,
				auth: 'unknown' as const,
				unavailableReason: claudePath ? null : ('not_found' as const),
				unavailableDetail: claudePath ? null : 'missing',
				models: [],
				modelsLive: false,
				defaultModel: null,
				allowsCustomModel: true as const,
				probedAt: 1
			},
			{
				name: 'codex' as const,
				label: 'Codex',
				kind: 'cli' as const,
				installed: Boolean(codexPath),
				path: codexPath,
				pathSource: codexPath ? ('known-location' as const) : null,
				version: codexPath ? '0.145.0' : null,
				auth: 'unknown' as const,
				unavailableReason: codexPath ? null : ('not_found' as const),
				unavailableDetail: codexPath ? null : 'missing',
				models: [],
				modelsLive: false,
				defaultModel: null,
				allowsCustomModel: true as const,
				probedAt: 1
			},
			{
				name: 'ollama' as const,
				label: 'Ollama',
				kind: 'http' as const,
				installed: ollamaInstalled,
				path: null,
				pathSource: null,
				version: null,
				auth: 'unknown' as const,
				unavailableReason: ollamaInstalled ? null : ('not_running' as const),
				unavailableDetail: ollamaInstalled ? null : 'down',
				models: [],
				modelsLive: ollamaInstalled,
				defaultModel: null,
				allowsCustomModel: true as const,
				probedAt: 1
			}
		]
	};
}

describe('discovery paths through the factory', () => {
	it('spawns the absolute path from a discovery snapshot, not the bare name', async () => {
		const absolute = '/tmp/bin/claude';
		const process = fakeSpawn([{ stdout: fixture('claude-success.jsonl') }]);
		const options = providerFactoryOptionsFromDiscovery(
			discoverySnapshot({ claudePath: absolute })
		);
		const provider = createDraftProvider(
			{ provider: 'claude' },
			{ claude: { ...options.claude, spawn: process.spawn } }
		);

		await expect(provider.draft(input)).resolves.toMatchObject({ kind: 'draft' });
		expect(process.calls[0]?.command).toBe(absolute);
	});

	it('preserves bare-name spawn when the snapshot leaves the command unresolved', async () => {
		const process = fakeSpawn([{ stdout: fixture('claude-success.jsonl') }]);
		const options = providerFactoryOptionsFromDiscovery(discoverySnapshot({ claudePath: null }));
		expect(options.claude).toBeUndefined();

		const provider = createDraftProvider(
			{ provider: 'claude' },
			{ claude: { spawn: process.spawn } }
		);

		await expect(provider.draft(input)).resolves.toMatchObject({ kind: 'draft' });
		expect(process.calls[0]?.command).toBe('claude');
	});
});
