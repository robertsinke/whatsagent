import {
	buildPrompt,
	draftResultSchema,
	parseDraftResult,
	ProviderError,
	withSingleRetry,
	type DraftInput,
	type DraftProvider,
	type DraftResult
} from './provider.js';

export interface OllamaProviderOptions {
	baseUrl?: string;
	model: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
	sleep?: (milliseconds: number) => Promise<void>;
}

export class OllamaProvider implements DraftProvider {
	constructor(private readonly options: OllamaProviderOptions) {}

	draft(input: DraftInput): Promise<DraftResult> {
		return withSingleRetry(
			() => this.run(input),
			this.options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
		);
	}

	private async run(input: DraftInput): Promise<DraftResult> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);

		try {
			const response = await (this.options.fetch ?? fetch)(
				`${(this.options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						model: this.options.model,
						stream: false,
						format: draftResultSchema,
						messages: [
							{ role: 'system', content: input.system },
							{ role: 'user', content: buildPrompt(input) }
						]
					}),
					signal: controller.signal
				}
			);

			if (!response.ok) {
				const retryable = response.status === 429 || response.status >= 500;
				const retryAfter = response.headers.get('retry-after');
				const retryAfterMs = retryAfter ? Number(retryAfter) * 1_000 : Number.NaN;
				throw new ProviderError(
					response.status === 429 ? 'rate_limit' : 'unavailable',
					`Ollama returned HTTP ${response.status}`,
					retryable,
					response.status === 429 && Number.isFinite(retryAfterMs) ? retryAfterMs : 250
				);
			}

			const payload = (await response.json()) as { message?: { content?: unknown } };
			return parseDraftResult(payload.message?.content);
		} catch (cause) {
			if (cause instanceof ProviderError) throw cause;
			if (controller.signal.aborted) {
				throw new ProviderError('timeout', 'Ollama request timed out', true, 250, { cause });
			}
			throw new ProviderError('unavailable', 'Ollama request failed', true, 250, { cause });
		} finally {
			clearTimeout(timeout);
		}
	}
}
