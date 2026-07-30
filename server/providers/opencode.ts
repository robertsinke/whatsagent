import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	disabledInheritedMcp,
	OPENCODE_BUILTIN_TOOLS_OFF,
	readUserOpenCodeMcpNames,
	type OpenCodeGlobalsOptions
} from './opencode-config.js';
import {
	buildPrompt,
	parseDraftResult,
	ProviderError,
	runJsonLinesProcess,
	sanitizedEnv,
	withSingleRetry,
	type DraftInput,
	type DraftProvider,
	type DraftResult,
	type SpawnProcess
} from './provider.js';

/**
 * The empty-toolset config for DRAFTING: no MCP tools, no builtins, everything
 * denied. The panel's config is the inverse of this one (our MCP tools, still
 * no builtins) and lives in `server/agent/panel/opencode-harness.ts`. The two
 * mechanical pieces they share — the verified thirteen-key `tools` block and
 * the inherited-globals disable list — come from `opencode-config.ts`; the
 * `mcp` and `permission` blocks are deliberately NOT shared.
 *
 * Built as a function rather than a frozen literal because the inherited-MCP
 * names are read off the user's own opencode configs at spawn time. They used
 * to be four hardcoded names that happened to exist on the owner's machine,
 * which both leaked and was wrong for everybody else.
 */
export function buildOpenCodeEmptyToolsConfig(
	options: OpenCodeGlobalsOptions = {}
): Record<string, unknown> {
	return {
		$schema: 'https://opencode.ai/config.json',
		mcp: disabledInheritedMcp(readUserOpenCodeMcpNames(options)),
		permission: { '*': 'deny' },
		tools: { ...OPENCODE_BUILTIN_TOOLS_OFF }
	};
}

export interface OpenCodeProviderOptions {
	command?: string;
	model?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnProcess;
	sleep?: (milliseconds: number) => Promise<void>;
	killGraceMs?: number;
}

/** Map a catalog / saved model id onto opencode's `provider/model` flag. */
export function normalizeOpenCodeModel(model: string): string {
	const trimmed = model.trim();
	if (!trimmed) return trimmed;
	if (trimmed.includes('/')) return trimmed;
	return `openai/${trimmed}`;
}

export class OpenCodeProvider implements DraftProvider {
	constructor(private readonly options: OpenCodeProviderOptions = {}) {}

	draft(input: DraftInput): Promise<DraftResult> {
		return withSingleRetry(
			() => this.run(input),
			this.options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
		);
	}

	private async run(input: DraftInput): Promise<DraftResult> {
		const configDirectory = await mkdtemp(join(tmpdir(), 'whatsagent-opencode-'));
		await writeFile(
			join(configDirectory, 'opencode.json'),
			`${JSON.stringify(buildOpenCodeEmptyToolsConfig({ env: this.options.env }), null, 2)}\n`,
			{ mode: 0o600 }
		);

		// `opencode run` (not serve + run --attach): PL-S3 showed attach returns
		// incomplete turns. Prompt is argv — never shell-interpolated.
		const args = [
			'run',
			'--auto',
			'--pure',
			'--format',
			'json',
			'--dir',
			configDirectory
		];
		if (this.options.model) {
			args.push('-m', normalizeOpenCodeModel(this.options.model));
		}
		args.push(`${input.system}\n\n${buildPrompt(input)}`);

		let text = '';
		try {
			await runJsonLinesProcess({
				command: this.options.command ?? 'opencode',
				args,
				env: sanitizedEnv(this.options.env ?? process.env, [
					'OPENAI_API_KEY',
					'CODEX_API_KEY',
					'ANTHROPIC_API_KEY',
					'ANTHROPIC_AUTH_TOKEN'
				]),
				stdin: '',
				timeoutMs: this.options.timeoutMs ?? 120_000,
				killGraceMs: this.options.killGraceMs,
				spawn: this.options.spawn,
				onEvent: (event) => {
					if (event.type !== 'text') return;
					const part = event.part as Record<string, unknown> | undefined;
					if (typeof part?.text === 'string') {
						text = part.text;
					}
				}
			});
		} finally {
			await rm(configDirectory, { recursive: true, force: true });
		}

		if (!text.trim()) {
			throw new ProviderError('invalid_response', 'OpenCode exited without a text result');
		}
		return parseDraftResult(text);
	}
}
