import { describe, expect, it } from 'vitest';
import type { ProviderInfo, ProvidersResponse } from '$lib/client/types.js';
import { VERIFIED_HARNESS_VERSIONS } from '../../../../shared/harness-versions.js';
import {
	AUTH_DISCLAIMER,
	anyProviderUsable,
	panelSetupSummary,
	providerRoleLabel,
	providerSetupRows,
	setupSummary
} from './provider-setup.js';

function info(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, 'name'>): ProviderInfo {
	return {
		label: overrides.name,
		kind: overrides.name === 'ollama' ? 'http' : 'cli',
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

function snapshot(providers: ProviderInfo[]): ProvidersResponse {
	return {
		providers,
		active: { provider: 'claude', coercedFrom: null, drafting: true, model: null },
		saved: { provider: null, providerModel: null },
		restartRequired: false,
		searchPath: [],
		probedAt: 1
	};
}

const ALL_DETECTED = snapshot([
	info({ name: 'claude', installed: true, version: '2.1.220', path: '/bin/claude', unavailableReason: null }),
	info({ name: 'codex', installed: true, version: '1.18.9', path: '/bin/opencode', unavailableReason: null }),
	info({ name: 'ollama', installed: true, version: '0.32.4', path: '/bin/ollama', unavailableReason: null })
]);

const NONE_DETECTED = snapshot([
	info({ name: 'claude' }),
	info({ name: 'codex' }),
	info({ name: 'ollama' })
]);

describe('providerSetupRows', () => {
	it('names all three providers with an install affordance when nothing is detected', () => {
		const rows = providerSetupRows(NONE_DETECTED);
		expect(rows.map((r) => r.name)).toEqual(['claude', 'codex', 'ollama']);
		expect(rows.every((r) => r.status === 'missing')).toBe(true);
		expect(rows.every((r) => r.showInstallLink)).toBe(true);
		expect(rows.map((r) => r.installUrl)).toEqual([
			'https://docs.anthropic.com/en/docs/claude-code',
			'https://opencode.ai',
			'https://ollama.com'
		]);
		expect(rows.find((r) => r.name === 'codex')?.title).toBe('OpenCode');
		// Pinned shell commands for Claude and OpenCode; Ollama stays a docs link.
		expect(rows.find((r) => r.name === 'claude')?.installCommand).toContain(
			VERIFIED_HARNESS_VERSIONS.claude
		);
		expect(rows.find((r) => r.name === 'codex')?.installCommand).toContain(
			`--version ${VERIFIED_HARNESS_VERSIONS.codex}`
		);
		expect(rows.find((r) => r.name === 'ollama')?.installCommand).toBeNull();
		expect(rows.find((r) => r.name === 'ollama')?.installLinkReason).toMatch(/macOS|sudo/i);
	});

	it('reports a dead Ollama daemon as installed-but-not-running, with a start hint', () => {
		const rows = providerSetupRows(
			snapshot([
				info({ name: 'claude', installed: true, version: '2.1.220', unavailableReason: null }),
				info({ name: 'codex', installed: true, version: '1.18.9', unavailableReason: null }),
				info({
					name: 'ollama',
					// The real discovery shape: not installed, still has a path.
					installed: false,
					path: '/opt/homebrew/bin/ollama',
					version: '0.32.4',
					unavailableReason: 'not_running',
					unavailableDetail: 'connect ECONNREFUSED 127.0.0.1:11434'
				})
			])
		);
		const ollama = rows.find((r) => r.name === 'ollama')!;
		expect(ollama.status).toBe('not_running');
		expect(ollama.statusLabel).toBe('Installed but not running — v0.32.4');
		expect(ollama.hint).toContain('ollama serve');
		// Never an install prompt: the binary is right there. Not in the status
		// line, and not as a link either.
		expect(ollama.statusLabel.toLowerCase()).not.toContain('not installed');
		expect(ollama.showInstallLink).toBe(false);
		expect(ollama.path).toBe('/opt/homebrew/bin/ollama');
	});

	it('never claims the user is authenticated, even if auth said logged_in', () => {
		// `auth` is always `unknown` in practice — a version probe cannot prove a
		// subscription login. This asserts the row builder ignores it entirely, so
		// no future API change can start painting a checkmark by accident.
		const rows = providerSetupRows(
			snapshot([
				info({ name: 'claude', installed: true, version: '2.1.220', unavailableReason: null, auth: 'logged_in' }),
				info({ name: 'codex', auth: 'logged_out' }),
				info({ name: 'ollama', auth: 'logged_in' })
			])
		);
		const text = rows.map((r) => `${r.statusLabel} ${r.hint ?? ''}`).join(' ').toLowerCase();
		expect(text).not.toContain('logged in');
		expect(text).not.toContain('signed in');
		expect(text).not.toContain('authenticated');
		// And the screen carries the disclaimer instead.
		expect(AUTH_DISCLAIMER.toLowerCase()).toContain('cannot tell whether your subscription login');
	});

	it('degrades to a re-scan hint when discovery reported nothing at all', () => {
		const rows = providerSetupRows(null);
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.status === 'missing')).toBe(true);
		expect(rows.every((r) => r.hint?.includes('Re-scan'))).toBe(true);
	});

	it('labels drafting vs panel roles, and keeps Ollama drafting-only', () => {
		const rows = providerSetupRows(NONE_DETECTED);
		expect(providerRoleLabel(rows.find((r) => r.name === 'claude')!.roles)).toBe(
			'Drafting · Agent panel'
		);
		expect(providerRoleLabel(rows.find((r) => r.name === 'codex')!.roles)).toBe(
			'Drafting · Agent panel'
		);
		expect(providerRoleLabel(rows.find((r) => r.name === 'ollama')!.roles)).toBe('Drafting only');
	});

	it('shows a mismatch notice when detected version differs from the pin, not when it matches', () => {
		const mismatched = providerSetupRows(
			snapshot([
				info({
					name: 'claude',
					installed: true,
					version: '2.1.220',
					unavailableReason: null
				}),
				info({
					name: 'codex',
					installed: true,
					// DERIVED from the pin, never a literal. This asserted a hardcoded
					// `1.18.10` and broke the day the pin was bumped to exactly that —
					// the test is about "differs → notice", not about any one version.
					version: `${VERIFIED_HARNESS_VERSIONS.codex}-different`,
					unavailableReason: null
				}),
				info({ name: 'ollama', installed: true, version: '0.32.4', unavailableReason: null })
			])
		);
		expect(mismatched.find((r) => r.name === 'claude')?.versionMismatch).toBeNull();
		expect(mismatched.find((r) => r.name === 'codex')?.versionMismatch).toBe(
			`Verified against ${VERIFIED_HARNESS_VERSIONS.codex}, you have ${VERIFIED_HARNESS_VERSIONS.codex}-different.`
		);
		expect(mismatched.find((r) => r.name === 'ollama')?.versionMismatch).toBeNull();
	});
});

describe('anyProviderUsable', () => {
	it('is false when nothing is installed and when the only binary is not running', () => {
		expect(anyProviderUsable(NONE_DETECTED)).toBe(false);
		expect(
			anyProviderUsable(
				snapshot([
					info({ name: 'claude' }),
					info({ name: 'codex' }),
					info({ name: 'ollama', path: '/bin/ollama', unavailableReason: 'not_running' })
				])
			)
		).toBe(false);
	});

	it('is true as soon as one provider is installed and healthy', () => {
		expect(anyProviderUsable(ALL_DETECTED)).toBe(true);
	});
});

describe('setupSummary', () => {
	it('says the app still works when nothing is detected', () => {
		const summary = setupSummary(NONE_DETECTED);
		expect(summary).toContain('still link WhatsApp');
		expect(summary).toContain('drafting stays off');
	});

	it('counts detected providers otherwise', () => {
		expect(setupSummary(ALL_DETECTED)).toBe('All three drafting tools found.');
		expect(
			setupSummary(
				snapshot([
					info({ name: 'claude', installed: true, unavailableReason: null }),
					info({ name: 'codex' }),
					info({ name: 'ollama' })
				])
			)
		).toBe('1 of 3 drafting tools found.');
	});
});

describe('panelSetupSummary', () => {
	it('says the panel needs Claude or OpenCode when neither is detected', () => {
		expect(panelSetupSummary(NONE_DETECTED)).toMatch(/Claude Code or OpenCode/);
	});

	it('names which panel harnesses are ready', () => {
		expect(
			panelSetupSummary(
				snapshot([
					info({ name: 'claude', installed: true, unavailableReason: null }),
					info({ name: 'codex' }),
					info({ name: 'ollama', installed: true, unavailableReason: null })
				])
			)
		).toContain('Claude Code');
	});
});
