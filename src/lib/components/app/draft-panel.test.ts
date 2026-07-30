import { describe, expect, it } from 'vitest';
import type { DraftStatus } from '$lib/client/types.js';
import { isVisibleDraftStatus } from '$lib/client/view.js';
import { draftPanelBranch } from './draft-panel.js';

const VISIBLE: DraftStatus[] = ['drafting', 'ready', 'stale', 'failed'];
const TERMINAL: DraftStatus[] = ['approved', 'sent', 'skipped'];

describe('isVisibleDraftStatus (contract the panel branch depends on)', () => {
	it('accepts in-flight and reviewable statuses only', () => {
		for (const status of VISIBLE) expect(isVisibleDraftStatus(status)).toBe(true);
		for (const status of TERMINAL) expect(isVisibleDraftStatus(status)).toBe(false);
	});
});

describe('draftPanelBranch', () => {
	it('prefers the stale re-confirm gate over every other branch', () => {
		expect(
			draftPanelBranch({
				draft: { status: 'ready' },
				stalePrompt: { draftText: 'old' },
				agentEligible: true
			})
		).toBe('stale');
	});

	it('shows the visible draft card for reviewable statuses', () => {
		for (const status of VISIBLE) {
			expect(
				draftPanelBranch({
					draft: { status },
					stalePrompt: null,
					agentEligible: true
				})
			).toBe('visible');
		}
	});

	it('shows Generate draft when there is no draft row and the agent is eligible', () => {
		expect(
			draftPanelBranch({
				draft: null,
				stalePrompt: null,
				agentEligible: true
			})
		).toBe('generate');
	});

	it('shows Generate draft for terminal draft statuses (sent/skipped/approved)', () => {
		// Regression: requiring `!draft` left this branch dead forever after the
		// owner replied — visibleDraft is null AND a draft row still exists.
		for (const status of TERMINAL) {
			expect(
				draftPanelBranch({
					draft: { status },
					stalePrompt: null,
					agentEligible: true
				})
			).toBe('generate');
		}
	});

	it('ranks an unreviewed text change above the stale prompt', () => {
		// Both prompts can be live at once. The stale branch's own button queues
		// the current draft, so if it rendered first the owner could confirm
		// staleness and ship text they never read — PL-U3's whole subject.
		expect(
			draftPanelBranch({
				draft: { status: 'ready' },
				stalePrompt: { chatJid: 'a', basisMsgId: 'x', latestInboundId: 'y' },
				textConflict: { chatJid: 'a', text: 'agent text', hash: 'h', source: 'agent' },
				agentEligible: true
			})
		).toBe('text-changed');
	});

	it('falls back to the visible draft when nothing is contested', () => {
		expect(
			draftPanelBranch({
				draft: { status: 'ready' },
				stalePrompt: null,
				textConflict: null,
				agentEligible: true
			})
		).toBe('visible');
	});

	it('hides the panel for groups even with a terminal draft', () => {
		expect(
			draftPanelBranch({
				draft: { status: 'sent' },
				stalePrompt: null,
				agentEligible: false
			})
		).toBe('hidden');
	});
});
