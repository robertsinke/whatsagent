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

/**
 * Why a provider is not usable right now. Aligned with the discovery module's
 * enum (`server/providers/discovery.ts`), which is the source of truth — a
 * found-but-dead Ollama daemon is meaningfully different from a missing binary,
 * and collapsing them hides the "installed but not running" affordance the
 * settings UI needs.
 */
export type ProviderUnavailableReason =
	| 'not_found'
	| 'probe_failed'
	| 'not_running';

/** Auth/login state of a provider CLI, as discovered by probing. */
export type ProviderAuthState = 'logged_in' | 'logged_out' | 'unknown';

/** Where a resolved binary path came from. Mirrors `path-resolver.ts`. */
export type ProviderPathSource = 'env-path' | 'known-location' | 'login-shell' | 'where';

/**
 * Per-provider info returned by `GET /api/providers`. This is the canonical
 * API response shape — `server/providers/discovery.ts`'s `DiscoveredProvider`
 * maps onto it 1:1 so the API does not define a third parallel set of fields.
 * `allowsCustomModel` is structural and always `true`: the "Custom…" escape
 * hatch is the entire point, and must be available in every state including
 * total discovery failure.
 */
export interface ProviderInfo {
	name: DraftProviderName;
	label: string;
	kind: 'cli' | 'http';
	installed: boolean;
	path: string | null;
	pathSource: ProviderPathSource | null;
	version: string | null;
	auth: ProviderAuthState;
	unavailableReason: ProviderUnavailableReason | null;
	unavailableDetail: string | null;
	models: ProviderModelOption[];
	modelsLive: boolean;
	defaultModel: string | null;
	allowsCustomModel: true;
	probedAt: number;
}

/**
 * What the running process actually constructed at boot. `coercedFrom` is set
 * when the persisted `provider` value was invalid and the boot fallback
 * substituted the default — the UI shows a warning so the owner knows the
 * saved value did not take effect. `drafting` is false when the factory threw
 * and the app degraded to "drafting off" rather than exiting.
 */
export interface ActiveProviderInfo {
	provider: DraftProviderName;
	coercedFrom: string | null;
	drafting: boolean;
	model: string | null;
}

/** Persisted settings values the client needs alongside discovery. */
export interface SavedProviderInfo {
	provider: string | null;
	providerModel: string | null;
}

/** Response of `GET /api/providers`. */
export interface ProvidersResponse {
	providers: ProviderInfo[];
	active: ActiveProviderInfo;
	saved: SavedProviderInfo;
	restartRequired: boolean;
	searchPath: string[];
	probedAt: number;
}