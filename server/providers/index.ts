import { ClaudeProvider, type ClaudeProviderOptions } from './claude.js';
import { CodexProvider, type CodexProviderOptions } from './codex.js';
import { OllamaProvider, type OllamaProviderOptions } from './ollama.js';
import { ProviderError, type DraftProvider } from './provider.js';

export type DraftProviderName = 'claude' | 'codex' | 'ollama';

export interface ProviderFactoryOptions {
	claude?: ClaudeProviderOptions;
	codex?: CodexProviderOptions;
	ollama?: Omit<OllamaProviderOptions, 'model'>;
}

export function createDraftProvider(
	settings: Readonly<Record<string, string>>,
	options: ProviderFactoryOptions = {}
): DraftProvider {
	const name = settings.provider ?? 'claude';
	const model = settings.provider_model;

	switch (name) {
		case 'claude':
			return new ClaudeProvider({ ...options.claude, model: model ?? options.claude?.model });
		case 'codex':
			return new CodexProvider({ ...options.codex, model: model ?? options.codex?.model });
		case 'ollama':
			return new OllamaProvider({
				...options.ollama,
				model: model ?? 'qwen3'
			});
		default:
			throw new ProviderError('unavailable', `Unknown draft provider setting: ${name}`);
	}
}

export * from './provider.js';
export { ClaudeProvider } from './claude.js';
export { CodexProvider } from './codex.js';
export { OllamaProvider } from './ollama.js';
