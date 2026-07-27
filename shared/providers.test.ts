import { describe, expect, it } from 'vitest';
import {
	CUSTOM_MODEL_VALUE,
	DEFAULT_DRAFT_PROVIDER,
	DEFAULT_MODEL_VALUE,
	DRAFT_PROVIDER_NAMES,
	isDraftProviderName,
	mergeModelOptions,
	normalizeDraftProviderName
} from './providers.js';
import type { CatalogModel, ProviderModelOption } from './provider-types.js';
import { PROVIDER_CATALOG } from './provider-catalog.generated.js';

describe('normalizeDraftProviderName', () => {
	it('maps a near-miss ("claud") to the default (claude), never throwing', () => {
		expect(normalizeDraftProviderName('claud')).toBe('claude');
	});

	it('maps undefined to the default (claude)', () => {
		expect(normalizeDraftProviderName(undefined)).toBe('claude');
	});

	it('maps a padded and capitalised "Codex" to codex', () => {
		expect(normalizeDraftProviderName('  Codex  ')).toBe('codex');
	});

	it('maps an empty string to the default (claude)', () => {
		expect(normalizeDraftProviderName('')).toBe('claude');
	});

	it('maps null to the default (claude)', () => {
		expect(normalizeDraftProviderName(null)).toBe('claude');
	});

	it('passes through a valid name unchanged', () => {
		expect(normalizeDraftProviderName('ollama')).toBe('ollama');
	});

	it('degrades a trailing-space brick (" Codex ") to codex, not the default', () => {
		// PUT /api/settings value validation relies on this: a trailing space
		// bricks startup exactly as badly as a typo, so it must normalize to the
		// intended provider rather than the default.
		expect(normalizeDraftProviderName(' Codex ')).toBe('codex');
	});

	it('degrades a totally unknown string to the default', () => {
		expect(normalizeDraftProviderName('chatgpt')).toBe(DEFAULT_DRAFT_PROVIDER);
	});
});

describe('isDraftProviderName', () => {
	it('accepts each member of DRAFT_PROVIDER_NAMES', () => {
		for (const name of DRAFT_PROVIDER_NAMES) {
			expect(isDraftProviderName(name)).toBe(true);
		}
	});

	it('rejects non-strings', () => {
		expect(isDraftProviderName(undefined)).toBe(false);
		expect(isDraftProviderName(null)).toBe(false);
		expect(isDraftProviderName(42)).toBe(false);
		expect(isDraftProviderName({})).toBe(false);
	});

	it('rejects near-misses', () => {
		expect(isDraftProviderName('claud')).toBe(false);
		expect(isDraftProviderName('Codex')).toBe(false); // case-sensitive guard
		expect(isDraftProviderName(' codex ')).toBe(false); // whitespace guard
		expect(isDraftProviderName('chatgpt')).toBe(false);
		expect(isDraftProviderName('')).toBe(false);
	});
});

describe('mergeModelOptions — saved value not in catalog or live (the headline case)', () => {
	const catalog: CatalogModel[] = [
		{ id: 'claude-opus-5', name: 'Claude Opus 5', releaseDate: '2026-07-24' },
		{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', releaseDate: '2026-06-29' }
	];
	const live: ProviderModelOption[] = [{ value: 'claude-opus-5', label: 'Claude Opus 5', source: 'live' }];

	it('emits the saved value exactly once, first, with source "saved"', () => {
		const merged = mergeModelOptions(catalog, live, 'claude-haiku-9-9');
		expect(merged[0]).toEqual({ value: 'claude-haiku-9-9', label: 'claude-haiku-9-9', source: 'saved' });
		expect(merged.filter((m) => m.value === 'claude-haiku-9-9')).toHaveLength(1);
	});

	it('does NOT emit the default-model option when a real saved value is present', () => {
		// The naive bind:value dropdown resets an unmatched value to '' and
		// overwrites the setting on the next save. mergeModelOptions must keep
		// the saved value visible so that never happens — and must not slip in
		// the default option as a side effect, which would also reset the UI.
		const merged = mergeModelOptions(catalog, live, 'claude-haiku-9-9');
		expect(merged.find((m) => m.value === DEFAULT_MODEL_VALUE)).toBeUndefined();
	});
});

describe('mergeModelOptions — value in both catalog and live', () => {
	const catalog: CatalogModel[] = [
		{ id: 'claude-opus-5', name: 'Claude Opus 5', releaseDate: '2026-07-24' },
		{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', releaseDate: '2026-06-29' }
	];
	const live: ProviderModelOption[] = [
		{ value: 'claude-opus-5', label: 'Claude Opus 5 (live)', source: 'live', note: 'confirmed available' }
	];

	it('emits the value once, retaining the live note', () => {
		const merged = mergeModelOptions(catalog, live, 'claude-opus-5');
		const entry = merged.find((m) => m.value === 'claude-opus-5');
		expect(entry).toBeDefined();
		expect(merged.filter((m) => m.value === 'claude-opus-5')).toHaveLength(1);
		// Live wins the note and the source label.
		expect(entry?.source).toBe('live');
		expect(entry?.note).toBe('confirmed available');
	});

	it('still emits the catalog-only entries', () => {
		const merged = mergeModelOptions(catalog, live, 'claude-opus-5');
		expect(merged.find((m) => m.value === 'claude-sonnet-5')).toBeDefined();
	});
});

describe('mergeModelOptions — sentinels, duplicates, and blank saved', () => {
	const catalog: CatalogModel[] = [
		{ id: 'claude-opus-5', name: 'Claude Opus 5', releaseDate: '2026-07-24' },
		{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', releaseDate: '2026-06-29' }
	];
	const live: ProviderModelOption[] = [{ value: 'live-only-tag', label: 'Live Tag', source: 'live' }];

	it('never emits the custom sentinel as a model row', () => {
		// Even if a malformed catalog/live entry carries the sentinel, it is filtered.
		const liveWithSentinel: ProviderModelOption[] = [
			...live,
			{ value: CUSTOM_MODEL_VALUE, label: 'Custom…', source: 'live' }
		];
		const merged = mergeModelOptions(catalog, liveWithSentinel, undefined);
		expect(merged.find((m) => m.value === CUSTOM_MODEL_VALUE)).toBeUndefined();
	});

	it('does not treat a saved custom sentinel as a saved model (no saved row emitted)', () => {
		const merged = mergeModelOptions(catalog, live, CUSTOM_MODEL_VALUE);
		expect(merged.find((m) => m.source === 'saved')).toBeUndefined();
	});

	it('never emits duplicate values', () => {
		const dupCatalog: CatalogModel[] = [
			...catalog,
			{ id: 'live-only-tag', name: 'Dup From Catalog', releaseDate: '2026-01-01' }
		];
		const merged = mergeModelOptions(dupCatalog, live, undefined);
		const values = merged.map((m) => m.value);
		expect(new Set(values).size).toBe(values.length);
	});

	it('emits the default-model option when saved is blank', () => {
		const merged = mergeModelOptions(catalog, live, '');
		const entry = merged.find((m) => m.value === DEFAULT_MODEL_VALUE);
		expect(entry).toBeDefined();
		expect(entry?.source).toBe('default');
	});

	it('emits the default-model option when saved is undefined', () => {
		const merged = mergeModelOptions(catalog, live, undefined);
		expect(merged.find((m) => m.value === DEFAULT_MODEL_VALUE)).toBeDefined();
	});

	it('emits the default-model option when saved is null', () => {
		const merged = mergeModelOptions(catalog, live, null);
		expect(merged.find((m) => m.value === DEFAULT_MODEL_VALUE)).toBeDefined();
	});

	it('emits the default-model option when saved is the custom sentinel', () => {
		// The user picked "Custom…" but hasn't typed an id yet — the dropdown
		// still needs a real pill to bind, and "Provider default" is the safe one.
		const merged = mergeModelOptions(catalog, live, CUSTOM_MODEL_VALUE);
		expect(merged.find((m) => m.value === DEFAULT_MODEL_VALUE)).toBeDefined();
	});
});

describe('PROVIDER_CATALOG (vendored)', () => {
	it('catalogues claude and codex, not ollama', () => {
		expect(Object.keys(PROVIDER_CATALOG).sort()).toEqual(['claude', 'codex']);
	});

	it('prepends the hand-maintained claude aliases that survive regeneration', () => {
		const ids = PROVIDER_CATALOG.claude.map((m) => m.id);
		expect(ids.slice(0, 3)).toEqual(['opus', 'sonnet', 'haiku']);
	});

	it('does not exceed the cap of 12 catalog entries per provider (aliases excluded from the cap)', () => {
		// claude has 3 aliases + up to 12 catalog entries; codex has 0 aliases + up to 12.
		expect(PROVIDER_CATALOG.claude.length).toBeLessThanOrEqual(15);
		expect(PROVIDER_CATALOG.codex.length).toBeLessThanOrEqual(12);
	});

	it('has no duplicate ids within a provider', () => {
		for (const provider of ['claude', 'codex'] as const) {
			const ids = PROVIDER_CATALOG[provider].map((m) => m.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it('codex entries match the plausibility pattern (gpt-5, codex, or o<digits>)', () => {
		const re = /^(gpt-5|codex|o\d)/;
		for (const m of PROVIDER_CATALOG.codex) {
			expect(re.test(m.id)).toBe(true);
		}
	});
});