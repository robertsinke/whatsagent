import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScrollActivity } from './scroll-activity.svelte.js';

describe('createScrollActivity', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('is inactive at rest, active while scrolling, and hides after the idle interval', () => {
		const activity = createScrollActivity(900);
		expect(activity.active).toBe(false);

		activity.poke();
		expect(activity.active).toBe(true);

		vi.advanceTimersByTime(899);
		expect(activity.active).toBe(true);

		vi.advanceTimersByTime(1);
		expect(activity.active).toBe(false);
	});

	it('restarts the idle countdown on continued scrolling', () => {
		const activity = createScrollActivity(900);
		activity.poke();
		vi.advanceTimersByTime(800);
		activity.poke();
		vi.advanceTimersByTime(800);
		expect(activity.active).toBe(true);

		vi.advanceTimersByTime(100);
		expect(activity.active).toBe(false);
	});

	it('drops a pending timer on dispose so it cannot outlive the pane', () => {
		const activity = createScrollActivity(900);
		activity.poke();
		activity.dispose();
		expect(activity.active).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('notifies onChange when activity flips so the action can sync the DOM', () => {
		const seen: boolean[] = [];
		const activity = createScrollActivity(900, (active) => seen.push(active));

		activity.poke();
		expect(seen).toEqual([true]);

		vi.advanceTimersByTime(900);
		expect(seen).toEqual([true, false]);

		activity.dispose();
		expect(seen).toEqual([true, false, false]);
	});
});
