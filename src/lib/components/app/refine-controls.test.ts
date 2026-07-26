import { describe, expect, it } from 'vitest';
import type { Draft } from '$lib/client/types.js';
import { REFINE_INTENTS, intentForClick, refineControlsState } from './refine-controls.js';

function draft(overrides: Partial<Draft> = {}): Draft {
	return {
		chat_jid: 'maya@s.whatsapp.net',
		text: 'Yes, seven works for me.',
		status: 'ready',
		generated_at: 201,
		provider: 'fake',
		basis_msg_id: 'a1',
		original_text: 'Yes, seven works for me.',
		...overrides
	};
}

describe('refine-controls intents', () => {
	it('mirrors the server canonical wire values exactly, in display order', () => {
		// These must match server/providers/provider.ts refinementIntents — the
		// server rejects anything outside this set before invoking the provider.
		expect(REFINE_INTENTS).toEqual([
			'regenerate',
			'shorter',
			'longer',
			'more_formal',
			'less_formal'
		]);
	});

	it('passes the clicked intent through to the server contract unchanged', () => {
		for (const intent of REFINE_INTENTS) {
			expect(intentForClick(intent)).toBe(intent);
		}
	});
});

describe('refineControlsState', () => {
	it('renders controls for a ready draft and uses the saved preview when the editor is closed', () => {
		const state = refineControlsState({
			draft: draft(),
			editing: false,
			editedText: '',
			refining: false,
			approving: false
		});
		expect(state.visible).toBe(true);
		expect(state.disabled).toBe(false);
		expect(state.previewText).toBe('Yes, seven works for me.');
	});

	it('uses unsaved editor text when edit mode is open', () => {
		const state = refineControlsState({
			draft: draft(),
			editing: true,
			editedText: '  Edited in the textarea  ',
			refining: false,
			approving: false
		});
		// Trimmed — the server receives a clean preview.
		expect(state.previewText).toBe('Edited in the textarea');
	});

	it('hides controls for drafting, failed, approved, skipped, and sent drafts', () => {
		for (const status of ['drafting', 'failed', 'approved', 'skipped', 'sent'] as const) {
			const state = refineControlsState({
				draft: draft({ status }),
				editing: false,
				editedText: '',
				refining: false,
				approving: false
			});
			expect(state.visible).toBe(false);
		}
	});

	it('shows controls for a stale draft so the owner can refine before re-confirming', () => {
		const state = refineControlsState({
			draft: draft({ status: 'stale' }),
			editing: false,
			editedText: '',
			refining: false,
			approving: false
		});
		expect(state.visible).toBe(true);
	});

	it('disables every control while a refinement request is in flight', () => {
		const state = refineControlsState({
			draft: draft(),
			editing: false,
			editedText: '',
			refining: true,
			approving: false
		});
		expect(state.disabled).toBe(true);
		// The visible preview is still derived so the owner keeps seeing their text.
		expect(state.visible).toBe(true);
		expect(state.previewText).toBe('Yes, seven works for me.');
	});

	it('disables controls while an approval is pending so refinement cannot race', () => {
		const state = refineControlsState({
			draft: draft(),
			editing: true,
			editedText: 'Edited',
			refining: false,
			approving: true
		});
		expect(state.disabled).toBe(true);
	});

	it('yields no preview text when the editor is empty', () => {
		const state = refineControlsState({
			draft: draft(),
			editing: true,
			editedText: '   ',
			refining: false,
			approving: false
		});
		expect(state.previewText).toBeNull();
	});

	it('yields no preview text when the draft itself is empty', () => {
		const state = refineControlsState({
			draft: draft({ text: '' }),
			editing: false,
			editedText: '',
			refining: false,
			approving: false
		});
		// A refinable status with no text is a degenerate case the UI should not
		// send to the provider; the server would reject it as invalid_preview.
		expect(state.previewText).toBeNull();
	});
});