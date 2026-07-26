import { describe, expect, it } from 'vitest';
import { isAtBottom, preservedScrollTop } from './scroll-anchor.js';

describe('isAtBottom', () => {
	it('is true within the epsilon of the bottom', () => {
		expect(isAtBottom({ scrollTop: 1970, scrollHeight: 4000, clientHeight: 2000 })).toBe(true);
	});

	it('is false while the reader is scrolled up', () => {
		expect(isAtBottom({ scrollTop: 600, scrollHeight: 4000, clientHeight: 2000 })).toBe(false);
	});

	it('is true for a thread shorter than the viewport', () => {
		expect(isAtBottom({ scrollTop: 0, scrollHeight: 500, clientHeight: 900 })).toBe(true);
	});
});

describe('preservedScrollTop', () => {
	it('keeps the top bubble visually still after older messages are prepended', () => {
		// Reader parked 800px down a 4000px thread; a prepend adds 2500px above.
		const before = { scrollTop: 800, scrollHeight: 4000, clientHeight: 900 };
		expect(preservedScrollTop(before, 6500)).toBe(3300);
		// Distance from the bottom — hence every visible bubble — is unchanged.
		expect(6500 - 3300).toBe(before.scrollHeight - before.scrollTop);
	});

	it('stays pinned to the bottom when the thread was shorter than the viewport', () => {
		const before = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };
		expect(preservedScrollTop(before, 1800)).toBe(1400);
	});

	it('never returns a negative offset when content shrinks', () => {
		const before = { scrollTop: 100, scrollHeight: 4000, clientHeight: 900 };
		expect(preservedScrollTop(before, 500)).toBe(0);
	});
});
