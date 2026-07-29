import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Verbatim empty-toolset config from
 * `docs/evidence/2026-07-29-pl-s3-opencode-recheck.md` (PL-S3).
 *
 * Do not hand-roll a subset: on opencode 1.18.9 a five-key tools block
 * (bash/read/todoread/patch/task) can hang every run, while this thirteen-key
 * shape returns in seconds. If you must change it, re-prove with a decoy file.
 */
export const OPENCODE_EMPTY_TOOLS_CONFIG = {
	$schema: 'https://opencode.ai/config.json',
	mcp: {
		'computer-use': { enabled: false },
		'legalwork-ui': { enabled: false },
		'open-knowledge': { enabled: false },
		pencil: { enabled: false }
	},
	permission: { '*': 'deny' },
	tools: {
		bash: false,
		edit: false,
		write: false,
		read: false,
		grep: false,
		glob: false,
		list: false,
		webfetch: false,
		websearch: false,
		todowrite: false,
		skill: false,
		question: false,
		lsp: false
	}
} as const;

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
			`${JSON.stringify(OPENCODE_EMPTY_TOOLS_CONFIG, null, 2)}\n`,
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
