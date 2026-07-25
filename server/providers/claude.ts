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

export interface ClaudeProviderOptions {
	command?: string;
	model?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnProcess;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	killGraceMs?: number;
}

export class ClaudeProvider implements DraftProvider {
	constructor(private readonly options: ClaudeProviderOptions = {}) {}

	draft(input: DraftInput): Promise<DraftResult> {
		return withSingleRetry(
			() => this.run(input),
			this.options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
		);
	}

	private async run(input: DraftInput): Promise<DraftResult> {
		let result: DraftResult | undefined;
		const now = this.options.now ?? Date.now;
		const args = [
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--safe-mode',
			'--disable-slash-commands',
			'--no-session-persistence',
			'--tools',
			'',
			'--json-schema',
			JSON.stringify(draftResultSchema),
			'--system-prompt',
			input.system
		];
		if (this.options.model) args.push('--model', this.options.model);

		const userMessage = JSON.stringify({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'text', text: buildPrompt(input) }]
			}
		});

		await runJsonLinesProcess({
			command: this.options.command ?? 'claude',
			args,
			env: sanitizedEnv(this.options.env ?? process.env, [
				'ANTHROPIC_API_KEY',
				'ANTHROPIC_AUTH_TOKEN'
			]),
			stdin: `${userMessage}\n`,
			timeoutMs: this.options.timeoutMs ?? 120_000,
			killGraceMs: this.options.killGraceMs,
			spawn: this.options.spawn,
			onEvent: (event) => {
				if (event.type === 'rate_limit_event') {
					const info = event.rate_limit_info as Record<string, unknown> | undefined;
					if (info?.status !== 'allowed') {
						const resetsAt = typeof info?.resetsAt === 'number' ? info.resetsAt * 1000 : now() + 1_000;
						throw new ProviderError(
							'rate_limit',
							'Claude CLI is rate limited',
							true,
							Math.max(0, Math.min(resetsAt - now(), 60_000))
						);
					}
				}
				if (event.type === 'result') {
					if (event.is_error === true) {
						throw new ProviderError('unavailable', 'Claude CLI returned an error result', true, 250);
					}
					result = parseDraftResult(event.structured_output ?? event.result);
				}
			}
		});

		if (!result) throw new ProviderError('invalid_response', 'Claude CLI exited without a result');
		return result;
	}
}
