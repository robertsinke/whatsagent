import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	buildPrompt,
	draftResultSchema,
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

export interface CodexProviderOptions {
	command?: string;
	model?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnProcess;
	sleep?: (milliseconds: number) => Promise<void>;
	killGraceMs?: number;
}

export class CodexProvider implements DraftProvider {
	constructor(private readonly options: CodexProviderOptions = {}) {}

	draft(input: DraftInput): Promise<DraftResult> {
		return withSingleRetry(
			() => this.run(input),
			this.options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
		);
	}

	private async run(input: DraftInput): Promise<DraftResult> {
		let result: DraftResult | undefined;
		const schemaDirectory = await mkdtemp(join(tmpdir(), 'whatsagent-codex-'));
		const schemaPath = join(schemaDirectory, 'draft-result.schema.json');
		await writeFile(schemaPath, JSON.stringify(draftResultSchema), { mode: 0o600 });
		// `--sandbox read-only` still leaves the shell tool enabled (it only
		// constrains writes). Drafting only needs a prompt→JSON round-trip, so
		// disable the shell — otherwise conversation text (attacker-controlled
		// via WhatsApp) can induce file reads whose contents land in the
		// owner-facing draft.
		//
		// THIS IS A REDUCTION, NOT A FIX, AND IT IS NOT PARITY WITH CLAUDE.
		// Verified 2026-07-29 with this exact flag set: the model still lists
		// `functions.exec`, `functions.apply_patch`, `web.run` and the MCP
		// resource tools, still loads the user's `~/.codex/config.toml` MCP
		// servers, and STILL READ A DECOY FILE and returned its contents when
		// asked. `--disable shell_tool` removes one execution path of several.
		// Evidence that injection "no longer works" was a model *refusal* under
		// one prompt, which is not the same as the capability being absent.
		//
		// Claude's `--tools ''` genuinely removes the whole built-in set; codex
		// has no equivalent. Until that gap is closed (candidates:
		// `--ignore-user-config` plus disabling the remaining features, each
		// verified by decoy rather than by asking the model), treat codex as a
		// provider that can read the filesystem while drafting attacker-supplied
		// text, and do not describe the providers as capability-equivalent.
		const args = [
			'exec',
			'--json',
			'--ephemeral',
			'--sandbox',
			'read-only',
			'--disable',
			'shell_tool',
			'--skip-git-repo-check',
			'--output-schema',
			schemaPath
		];
		if (this.options.model) args.push('--model', this.options.model);
		args.push('-');

		try {
			await runJsonLinesProcess({
				command: this.options.command ?? 'codex',
				args,
				env: sanitizedEnv(this.options.env ?? process.env, ['OPENAI_API_KEY', 'CODEX_API_KEY']),
				stdin: `${input.system}\n\n${buildPrompt(input)}\n`,
				timeoutMs: this.options.timeoutMs ?? 120_000,
				killGraceMs: this.options.killGraceMs,
				spawn: this.options.spawn,
				onEvent: (event) => {
					if (event.type === 'error') {
						const message =
							typeof event.message === 'string' ? event.message : 'Codex CLI returned an error';
						throw new ProviderError('unavailable', message, true, 250);
					}
					if (event.type !== 'item.completed') return;
					const item = event.item as Record<string, unknown> | undefined;
					if (item?.type === 'agent_message' && typeof item.text === 'string') {
						result = parseDraftResult(item.text);
					}
				}
			});
		} finally {
			await rm(schemaDirectory, { recursive: true, force: true });
		}

		if (!result) throw new ProviderError('invalid_response', 'Codex CLI exited without a result');
		return result;
	}
}
