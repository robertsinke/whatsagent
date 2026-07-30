import { describe, expect, it } from 'vitest';
import { VERIFIED_HARNESS_VERSIONS } from './harness-versions.js';
import {
	claudeInstallCommand,
	harnessInstallPlan,
	opencodeInstallCommand
} from './harness-install.js';

describe('harnessInstallPlan', () => {
	it('embeds the pinned version in Claude and OpenCode commands', () => {
		const claude = harnessInstallPlan('claude');
		expect(claude.kind).toBe('shell');
		if (claude.kind !== 'shell') return;
		expect(claude.command).toBe(claudeInstallCommand());
		expect(claude.command).toContain(VERIFIED_HARNESS_VERSIONS.claude);
		expect(claude.command).toContain('claude.ai/install.sh');

		const opencode = harnessInstallPlan('codex');
		expect(opencode.kind).toBe('shell');
		if (opencode.kind !== 'shell') return;
		expect(opencode.command).toBe(opencodeInstallCommand());
		expect(opencode.command).toContain(`--version ${VERIFIED_HARNESS_VERSIONS.codex}`);
		expect(opencode.command).toContain('opencode.ai/install');
	});

	it('keeps Ollama as a docs link on macOS and explains why', () => {
		const plan = harnessInstallPlan('ollama', 'darwin');
		expect(plan.kind).toBe('link');
		if (plan.kind !== 'link') return;
		expect(plan.url).toBe('https://ollama.com');
		expect(plan.reason.toLowerCase()).toMatch(/macos|linux-only|sudo/);
	});
});
