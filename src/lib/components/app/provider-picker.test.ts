import { describe, expect, it } from 'vitest';
import type { ProviderInfo, ProvidersResponse } from '$lib/client/types.js';
import {
	activeDraftLabel,
	modelOptions,
	modelTriggerLabel,
	modelViewValue,
	providerCapabilityHelp,
	providerOptions,
	savedDraftLabel,
	savedModelWarning,
	unavailableReasonLabel
} from './provider-picker.js';
import {
	CUSTOM_MODEL_VALUE,
	DEFAULT_MODEL_LABEL,
	DEFAULT_MODEL_VALUE
} from '../../../../shared/providers.js';

function info(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, 'name'>): ProviderInfo {
	return {
		label: overrides.name,
		kind: 'cli',
		installed: false,
		path: null,
		pathSource: null,
		version: null,
		auth: 'unknown',
		unavailableReason: 'not_found',
		unavailableDetail: null,
		models: [],
		modelsLive: false,
		defaultModel: null,
		allowsCustomModel: true,
		probedAt: 1,
		...overrides
	};
}

function snapshot(
	providers: ProviderInfo[],
	overrides: Partial<ProvidersResponse> = {}
): ProvidersResponse {
	return {
		providers,
		active: { provider: 'claude', coercedFrom: null, drafting: true, model: null },
		saved: { provider: null, providerModel: null },
		restartRequired: false,
		searchPath: [],
		probedAt: 1,
		...overrides
	};
}

describe('unavailableReasonLabel', () => {
	it('keeps not_running distinct from not_found', () => {
		expect(unavailableReasonLabel(info({ name: 'ollama', unavailableReason: 'not_running' }))).toBe(
			'installed but not running'
		);
		expect(unavailableReasonLabel(info({ name: 'claude', unavailableReason: 'not_found' }))).toBe(
			'not found on PATH'
		);
	});
});

describe('providerOptions', () => {
	it('labels an unavailable provider with its reason and disables it', () => {
		const opts = providerOptions(
			snapshot([
				info({ name: 'claude', installed: true, version: '2.1.220', unavailableReason: null }),
				info({ name: 'codex' }),
				info({ name: 'ollama', version: '0.32.4', unavailableReason: 'not_running' })
			]),
			'claude'
		);
		expect(opts.find((o) => o.value === 'claude')).toMatchObject({
			label: 'claude — installed, v2.1.220',
			disabled: false
		});
		expect(opts.find((o) => o.value === 'codex')).toMatchObject({
			label: 'codex — not found on PATH',
			disabled: true
		});
		expect(opts.find((o) => o.value === 'ollama')?.label).toBe(
			'ollama — v0.32.4 (installed but not running)'
		);
	});

	it('keeps the currently selected provider selectable even when it is missing', () => {
		const opts = providerOptions(snapshot([info({ name: 'codex' })]), 'codex');
		expect(opts.find((o) => o.value === 'codex')?.disabled).toBe(false);
	});

	it('offers all three with plain labels when discovery is unavailable', () => {
		const opts = providerOptions(null, 'claude');
		expect(opts.map((o) => o.value)).toEqual(['claude', 'codex', 'ollama']);
		expect(opts.every((o) => !o.disabled)).toBe(true);
	});

	it('uses discovery labels so the OpenAI slot reads as OpenCode, not Codex CLI', () => {
		const opts = providerOptions(
			snapshot([info({ name: 'codex', label: 'OpenCode', installed: true, version: '1.18.9', unavailableReason: null })]),
			'codex'
		);
		expect(opts.find((o) => o.value === 'codex')?.label).toBe('OpenCode — installed, v1.18.9');
	});
});

describe('providerCapabilityHelp', () => {
	it('does not describe the three providers as capability-equivalent', () => {
		const claude = providerCapabilityHelp('claude');
		const codex = providerCapabilityHelp('codex');
		const ollama = providerCapabilityHelp('ollama');
		expect(claude).toMatch(/tools disabled/i);
		expect(codex).toMatch(/OpenCode/i);
		expect(codex).toMatch(/empty toolset|tools disabled/i);
		expect(ollama).toMatch(/No tool surface/i);
		expect(new Set([claude, codex, ollama]).size).toBe(3);
	});
});

describe('model view value', () => {
	it('maps an empty override to the Default sentinel and never leaks Custom', () => {
		expect(modelViewValue(false, '')).toBe(DEFAULT_MODEL_VALUE);
		expect(modelViewValue(false, '  ')).toBe(DEFAULT_MODEL_VALUE);
		expect(modelViewValue(false, 'claude-opus-5')).toBe('claude-opus-5');
		expect(modelViewValue(true, 'claude-opus-5')).toBe(CUSTOM_MODEL_VALUE);
	});

	it('labels the trigger from the saved value, not from the sentinel', () => {
		expect(modelTriggerLabel(null, 'claude', '', false)).toBe(DEFAULT_MODEL_LABEL);
		expect(modelTriggerLabel(null, 'claude', 'anything', true)).toBe('Custom…');
		expect(modelTriggerLabel(null, 'claude', 'not-a-real-model', false)).toBe('not-a-real-model');
	});
});

describe('modelOptions', () => {
	it('always includes the Default entry', () => {
		expect(modelOptions(null, 'ollama', '').some((m) => m.value === DEFAULT_MODEL_VALUE)).toBe(true);
	});

	it('merges live Ollama tags in', () => {
		const opts = modelOptions(
			snapshot([
				info({
					name: 'ollama',
					installed: true,
					unavailableReason: null,
					modelsLive: true,
					models: [{ value: 'llama3.2:3b', label: 'llama3.2:3b', note: '2.0 GB', source: 'live' }]
				})
			]),
			'ollama',
			''
		);
		expect(opts.find((m) => m.value === 'llama3.2:3b')).toMatchObject({ source: 'live' });
	});
});

describe('savedModelWarning', () => {
	it('warns only for a saved id that discovery and the catalog both missed', () => {
		expect(savedModelWarning(null, 'claude', 'claude-haiku-9-9-undetected')).toBe(true);
		expect(savedModelWarning(null, 'claude', '')).toBe(false);
	});
});

describe('draft labels', () => {
	it('describes the running process and the saved settings separately', () => {
		const snap = snapshot([], {
			active: { provider: 'claude', coercedFrom: null, drafting: true, model: null },
			saved: { provider: 'codex', providerModel: 'gpt-5-codex' },
			restartRequired: true
		});
		expect(activeDraftLabel(snap)).toBe('claude');
		expect(savedDraftLabel(snap)).toBe('codex / gpt-5-codex');
		expect(savedDraftLabel(snapshot([]))).toBe('claude (provider default)');
	});
});
