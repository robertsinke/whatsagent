/**
 * Provider domain types shared by the server (validation, GET /api/providers)
 * and the client (settings dropdown). Types-only so the generated catalog
 * (`shared/provider-catalog.generated.ts`) can import `CatalogModel` from here
 * with no runtime cycle, and so this module bundles for the browser with no
 * Node built-ins — see the `shared/` boundary rule in CLAUDE.md.
 */

/** The three draft-provider backends. Also the keys of the model catalog. */
export type DraftProviderName = 'claude' | 'codex' | 'ollama';

/**
 * A model entry in the vendored build-time catalog
 * (`shared/provider-catalog.generated.ts`). `id` is what gets passed to the
 * provider CLI's `--model` flag; `name` is the dropdown label; `releaseDate`
 * drives the sort-by-newest ordering and is absent for hand-maintained aliases
 * (opus/sonnet/haiku) which models.dev does not list.
 */
export interface CatalogModel {
	id: string;
	name: string;
	releaseDate?: string;
}

/**
 * A single option in the merged provider-model dropdown. `source` tells the UI
 * where this entry came from so it can badge a saved-but-unknown value or a
 * live-confirmed one. `note` carries live-only detail (e.g. an Ollama tag size).
 */
export interface ProviderModelOption {
	value: string;
	label: string;
	source: 'catalog' | 'live' | 'saved' | 'default';
	note?: string;
}

/** Why a provider is not usable right now. */
export type ProviderUnavailableReason =
	| 'not_installed'
	| 'not_logged_in'
	| 'offline'
	| 'unknown';

/** Auth/login state of a provider CLI, as discovered by probing. */
export type ProviderAuthState = 'logged_in' | 'logged_out' | 'unknown';

/**
 * Per-provider info returned by `GET /api/providers`. `models` is the merged
 * dropdown list; the other fields drive availability badges and the
 * restart-required indicator.
 */
export interface ProviderInfo {
	name: DraftProviderName;
	label: string;
	available: boolean;
	authState: ProviderAuthState;
	unavailableReason?: ProviderUnavailableReason;
	binaryPath?: string;
	version?: string;
	models: ProviderModelOption[];
}

/** Response of `GET /api/providers`. */
export interface ProvidersResponse {
	providers: ProviderInfo[];
	restartRequired: boolean;
}