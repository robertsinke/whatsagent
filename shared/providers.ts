/**
 * Provider domain runtime: pure predicates and the model-option merge that the
 * settings dropdown and server-side validation share. Lives in `shared/` for the
 * same reason `provider-types.ts` does — both halves of `npm run check` and the
 * browser bundle must see it. No Node built-ins.
 */

import type { CatalogModel, DraftProviderName, ProviderModelOption } from './provider-types.js';

// Re-export the type so consumers can import `DraftProviderName` from the
// runtime module (`shared/providers.js`) rather than splitting the import across
// the types-only and runtime modules. `server/providers/index.ts` re-exports
// this name from here.
export type { DraftProviderName } from './provider-types.js';

/** The full set of draft-provider names, in catalog order. */
export const DRAFT_PROVIDER_NAMES: readonly DraftProviderName[] = ['claude', 'codex', 'ollama'];

/** The provider used when none is saved or the saved one is unusable. */
export const DEFAULT_DRAFT_PROVIDER: DraftProviderName = 'claude';

/**
 * Per-provider honesty about what the model can do *while drafting*. These are
 * not capability-equivalent: Claude and OpenCode (settings key `codex`) run
 * with tools removed; Ollama is a plain HTTP call. The old Codex CLI path is
 * gone — it could still read the filesystem under a "read-only sandbox".
 */
export const DRAFT_PROVIDER_CAPABILITY: Readonly<Record<DraftProviderName, string>> = {
	claude:
		'Claude Code with tools disabled (`--tools` empty). Subscription login only — no filesystem or network tools while drafting.',
	codex:
		'OpenCode with built-in tools disabled (verified empty toolset). Uses your ChatGPT / OpenAI OAuth login. Not the Codex CLI.',
	ollama: 'Local Ollama over HTTP. No tool surface — prompt in, JSON draft out.'
};
/**
 * The `<option value>` the dropdown uses for the "Custom…" escape hatch. A
 * model id colliding with this sentinel would be ambiguous, so `mergeModelOptions`
 * never emits it as a model row; the UI renders it separately as "Custom…".
 */
export const CUSTOM_MODEL_VALUE = '__custom__';

/**
 * The `<option value>` meaning "use the provider's default model" (no
 * `--model` flag threaded through). Distinct from empty string so the dropdown
 * can render a real label rather than a blank pill.
 */
export const DEFAULT_MODEL_VALUE = '__default__';

/** Human label for the default-model option. */
export const DEFAULT_MODEL_LABEL = 'Provider default';

const DRAFT_PROVIDER_NAME_SET: ReadonlySet<DraftProviderName> = new Set(DRAFT_PROVIDER_NAMES);

/** Type guard for {@link DraftProviderName}. */
export function isDraftProviderName(value: unknown): value is DraftProviderName {
	return typeof value === 'string' && DRAFT_PROVIDER_NAME_SET.has(value as DraftProviderName);
}

/**
 * Normalize an arbitrary saved-provider value to a {@link DraftProviderName},
 * never throwing. Unknown, non-string, empty, or near-miss values degrade to
 * {@link DEFAULT_DRAFT_PROVIDER} so a typo or trailing space in SQLite cannot
 * brick startup — the boot fallback and PUT validation both rely on this.
 */
export function normalizeDraftProviderName(value: unknown): DraftProviderName {
	if (typeof value !== 'string') return DEFAULT_DRAFT_PROVIDER;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === '') return DEFAULT_DRAFT_PROVIDER;
	if (DRAFT_PROVIDER_NAME_SET.has(trimmed as DraftProviderName)) {
		return trimmed as DraftProviderName;
	}
	return DEFAULT_DRAFT_PROVIDER;
}

/**
 * Merge the vendored catalog, a live model list (Ollama tags), and the saved
 * setting into the dropdown's `ProviderModelOption[]`.
 *
 * Ordering and the saved-value rule are load-bearing:
 *
 * 1. **A saved value present in neither the catalog nor the live list still
 *    appears, first, with `source: 'saved'`.** The naive `bind:value` dropdown
 *    sees an unmatched value, resets to `''`, and overwrites the setting on the
 *    next save. Emitting the saved value first prevents that silent loss. This
 *    is the headline case the test suite pins.
 * 2. A value present in both catalog and live appears once, keeping the live
 *    note (live is authoritative for "is it actually available right now").
 * 3. The custom sentinel ({@link CUSTOM_MODEL_VALUE}) is never emitted as a
 *    model row — the UI renders "Custom…" separately.
 * 4. No duplicate values.
 * 5. When `saved` is blank, the {@link DEFAULT_MODEL_VALUE} option is emitted
 *    so the dropdown can show "Provider default" rather than a blank pill.
 *
 * @param catalog  the vendored build-time catalog entries for this provider
 * @param live     models discovered live at request time (e.g. Ollama tags);
 *                 pass `[]` for providers without a live list
 * @param saved    the currently persisted model id, or `''`/`undefined`/`null`
 */
export function mergeModelOptions(
	catalog: readonly CatalogModel[],
	live: readonly ProviderModelOption[],
	saved: string | null | undefined
): ProviderModelOption[] {
	const out: ProviderModelOption[] = [];
	const seen = new Set<string>();
	const savedTrimmed = typeof saved === 'string' ? saved.trim() : '';
	const savedIsCustom = savedTrimmed === CUSTOM_MODEL_VALUE;

	// 1. Saved value first, if it is a real model id and not the custom sentinel.
	//    A saved value not in catalog or live is the headline case: it must
	//    survive so the next save does not silently wipe it.
	if (savedTrimmed !== '' && !savedIsCustom) {
		const inCatalog = catalog.some((m) => m.id === savedTrimmed);
		const inLive = live.some((m) => m.value === savedTrimmed);
		if (!inCatalog && !inLive) {
			out.push({ value: savedTrimmed, label: savedTrimmed, source: 'saved' });
			seen.add(savedTrimmed);
		}
	}

	// 2. Live list, with its notes preserved. A live entry that also matches a
	//    catalog entry is emitted here (live wins the note) and skipped in step 3.
	for (const opt of live) {
		if (opt.value === CUSTOM_MODEL_VALUE) continue;
		if (seen.has(opt.value)) continue;
		out.push({ ...opt, source: 'live' });
		seen.add(opt.value);
	}

	// 3. Catalog entries not already covered by live.
	for (const model of catalog) {
		if (model.id === CUSTOM_MODEL_VALUE) continue;
		if (seen.has(model.id)) continue;
		out.push({
			value: model.id,
			label: model.name || model.id,
			source: 'catalog',
			...(model.releaseDate ? { note: model.releaseDate } : {})
		});
		seen.add(model.id);
	}

	// 4. Default-model option. Emitted when saved is blank (so the dropdown has
	//    a real "Provider default" pill), and also when saved is the custom
	//    sentinel (the user picked Custom… but hasn't typed an id yet). Not
	//    emitted when saved is a real model id — that id is already in the list.
	if (savedTrimmed === '' || savedIsCustom) {
		if (!seen.has(DEFAULT_MODEL_VALUE)) {
			out.push({ value: DEFAULT_MODEL_VALUE, label: DEFAULT_MODEL_LABEL, source: 'default' });
			seen.add(DEFAULT_MODEL_VALUE);
		}
	}

	return out;
}