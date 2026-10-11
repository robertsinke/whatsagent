import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * There is no Svelte DOM harness in this repo, so the guarantee that a new
 * chat does not inherit the previous composer's text is visible only in
 * `startChatFromList`. This fails if that clear is removed or moved to after
 * the composer is focused.
 */
function startChatFromListBody(): string {
	const source = readFileSync(
		fileURLToPath(new URL('../../routes/+page.svelte', import.meta.url)),
		'utf8'
	);
	const start = source.indexOf('async function startChatFromList');
	if (start < 0) throw new Error('startChatFromList is missing from +page.svelte');
	const end = source.indexOf('\n\t}', start);
	return source.slice(start, end);
}

describe('startChatFromList', () => {
	it('clears the composer before focusing it', () => {
		const body = startChatFromListBody();
		const clearAt = body.indexOf("composerValue = ''");
		const focusAt = body.indexOf('composerFocusNonce');
		expect(clearAt).toBeGreaterThan(-1);
		expect(focusAt).toBeGreaterThan(clearAt);
	});
});
