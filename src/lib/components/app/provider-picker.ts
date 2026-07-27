/**
 * Provider + model picker logic, extracted from `src/routes/settings/+page.svelte`
 * (OSS-P2.5) so first-run setup and Settings render the *same* control and
 * cannot drift apart.
 *
 * Pure functions only — the component beside this file holds the markup, and
 * these are what the tests assert against. Nothing here computes provider
 * state: `GET /api/providers` already decided `installed`, `version`, `auth`
 * and `unavailableReason`, and re-deriving any of it client-side is how the two
 * screens would start disagreeing.
 */
import type { ProviderInfo, ProvidersResponse } from '$lib/client/types.js';
import { PROVIDER_CATALOG } from '../../../../shared/provider-catalog.generated.js';
import type {
	CatalogModel,
	DraftProviderName,
	ProviderModelOption
} from '../../../../shared/provider-types.js';
import {
	CUSTOM_MODEL_VALUE,
	DEFAULT_MODEL_LABEL,
	DEFAULT_MODEL_VALUE,
	DRAFT_PROVIDER_NAMES,
	mergeModelOptions,
	normalizeDraftProviderName
} from '../../../../shared/providers.js';

export type ProviderOption = {
	value: DraftProviderName;
	label: string;
	disabled: boolean;
	reason: string | null;
};

/**
 * Why a provider cannot be used, in the owner's words.
 *
 * `not_running` is deliberately *not* collapsed into `not_found`: Ollama
 * reporting `installed: false` with reason `not_running` means the binary is
 * there and the daemon is not answering. Telling that user to install Ollama
 * would be telling them to install what they already have.
 */
export function unavailableReasonLabel(info: ProviderInfo): string {
	switch (info.unavailableReason) {
		case 'not_found':
			return 'not found on PATH';
		case 'probe_failed':
			return 'version probe failed';
		case 'not_running':
			return 'installed but not running';
		default:
			return info.unavailableDetail ?? 'unavailable';
	}
}

export function providerOptions(
	snapshot: ProvidersResponse | null,
	currentProvider: string | undefined
): ProviderOption[] {
	const byName = new Map((snapshot?.providers ?? []).map((p) => [p.name, p] as const));
	const current = normalizeDraftProviderName(currentProvider);
	return DRAFT_PROVIDER_NAMES.map((name) => {
		const info = byName.get(name);
		if (!info) {
			return { value: name, label: name, disabled: false, reason: null };
		}
		const unavailable = !info.installed || info.unavailableReason !== null;
		let label = info.label || name;
		if (info.installed && info.version) {
			label = `${name} — installed, v${info.version}`;
		} else if (info.installed) {
			label = `${name} — installed`;
		} else {
			label = `${name} — ${unavailableReasonLabel(info)}`;
		}
		if (unavailable && info.unavailableReason) {
			label = `${name} — ${unavailableReasonLabel(info)}`;
			if (info.version) label = `${name} — v${info.version} (${unavailableReasonLabel(info)})`;
		}
		return {
			value: name,
			label,
			// Keep the currently saved provider selectable so a missing binary
			// cannot silently clear the owner's choice from the control.
			disabled: unavailable && name !== current,
			reason: unavailable ? unavailableReasonLabel(info) : null
		};
	});
}

export function catalogFor(provider: DraftProviderName): readonly CatalogModel[] {
	if (provider === 'ollama') return [];
	return PROVIDER_CATALOG[provider] ?? [];
}

export function modelOptions(
	snapshot: ProvidersResponse | null,
	providerValue: string | undefined,
	savedModel: string | undefined
): ProviderModelOption[] {
	const provider = normalizeDraftProviderName(providerValue);
	const info = snapshot?.providers.find((p) => p.name === provider);
	const live = info?.models ?? [];
	const merged = mergeModelOptions(catalogFor(provider), live, savedModel);
	if (!merged.some((m) => m.value === DEFAULT_MODEL_VALUE)) {
		merged.push({
			value: DEFAULT_MODEL_VALUE,
			label: DEFAULT_MODEL_LABEL,
			source: 'default'
		});
	}
	return merged;
}

/**
 * The select's *view* value, derived rather than mirrored. Settings previously
 * kept this in a second piece of state kept in step by `syncModelViewFromValue`;
 * as a derivation the two cannot fall out of sync at all. Sentinels never reach
 * the wire — `Custom…` is a view mode whose text input binds to the real value.
 */
export function modelViewValue(custom: boolean, savedModel: string | undefined): string {
	if (custom) return CUSTOM_MODEL_VALUE;
	const trimmed = (savedModel ?? '').trim();
	return trimmed === '' ? DEFAULT_MODEL_VALUE : trimmed;
}

export function modelTriggerLabel(
	snapshot: ProvidersResponse | null,
	providerValue: string | undefined,
	savedModel: string | undefined,
	custom: boolean
): string {
	if (custom) return 'Custom…';
	const trimmed = (savedModel ?? '').trim();
	if (trimmed === '') return DEFAULT_MODEL_LABEL;
	const opt = modelOptions(snapshot, providerValue, savedModel).find((m) => m.value === trimmed);
	return opt?.label ?? trimmed;
}

/**
 * What the *running process* drafts with — not what is saved. The gap between
 * the two is the whole point of the restart-required banner, and on first run it
 * is always present: the process booted before the owner picked anything.
 */
export function activeDraftLabel(snapshot: ProvidersResponse | null): string {
	const active = snapshot?.active;
	if (!active) return 'the boot provider';
	const model = active.model?.trim();
	return model ? `${active.provider} / ${model}` : active.provider;
}

/** What is persisted, and therefore what the next start will use. */
export function savedDraftLabel(snapshot: ProvidersResponse | null): string {
	const saved = snapshot?.saved;
	if (!saved) return 'the saved settings';
	const provider = saved.provider?.trim() || 'claude';
	const model = saved.providerModel?.trim();
	return model ? `${provider} / ${model}` : `${provider} (provider default)`;
}

/** True when the saved model id is not in the detected/catalog list. */
export function savedModelWarning(
	snapshot: ProvidersResponse | null,
	providerValue: string | undefined,
	savedModel: string | undefined
): boolean {
	const trimmed = (savedModel ?? '').trim();
	if (trimmed === '') return false;
	return modelOptions(snapshot, providerValue, savedModel).some(
		(m) => m.value === trimmed && m.source === 'saved'
	);
}
