/**
 * The OpenAI subscription draft path used to spawn the Codex CLI. That CLI has
 * no equivalent of Claude's `--tools ''`: even under the hardest lockdown we
 * could construct, a decoy file read still succeeded (PL-S2).
 *
 * Route A (PL-S4) replaces that vehicle with OpenCode under an empty toolset
 * config verified in PL-S3. The settings key remains `codex` so existing saved
 * preferences keep working; discovery and spawn target the `opencode` binary.
 *
 * Re-export keeps older imports compiling. Prefer `OpenCodeProvider` directly.
 */
export {
	OpenCodeProvider as CodexProvider,
	normalizeOpenCodeModel,
	buildOpenCodeEmptyToolsConfig,
	type OpenCodeProviderOptions as CodexProviderOptions
} from './opencode.js';
