import { ClaudeProvider, type ClaudeProviderOptions } from './claude.js';
import { CodexProvider, type CodexProviderOptions } from './codex.js';
import { OpenCodeProvider, type OpenCodeProviderOptions } from './opencode.js';
import { OllamaProvider, type OllamaProviderOptions } from './ollama.js';
import { ProviderError, type DraftProvider } from './provider.js';

// Re-exported from shared/ so server validation and the client dropdown share
// one definition. The local union used to live here; server/index.ts imports
// DraftProviderName from this module, so the re-export keeps that import working.
export type { DraftProviderName } from '../../shared/providers.js';

export interface ProviderFactoryOptions {
	claude?: ClaudeProviderOptions;
	/** OpenAI subscription path — spawns OpenCode, not the Codex CLI. */
	codex?: OpenCodeProviderOptions | CodexProviderOptions;
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
			// Settings key stays `codex`; the vehicle is OpenCode (PL-S4 Route A).
			return new OpenCodeProvider({ ...options.codex, model: model ?? options.codex?.model });
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
export { OpenCodeProvider } from './opencode.js';
export { OllamaProvider } from './ollama.js';
