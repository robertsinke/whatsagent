/**
 * PL-U3 Half B: the hash that binds an owner's approval to the exact text the
 * owner read.
 *
 * Both sides need the identical function — the client hashes what it rendered,
 * the server hashes what it stored — so this lives in `shared/` and stays
 * dependency-free (no `node:crypto`, which the browser bundle cannot take).
 *
 * SHA-256 is hand-rolled here rather than delegated to `crypto.subtle` for two
 * reasons: `subtle` is async (an approval check wants to be a plain comparison
 * inside a synchronous `run`) and it is absent outside a secure context, which
 * would silently break approval the moment the app is reached over a LAN IP
 * instead of `localhost`. It is also a real digest rather than a cheap
 * checksum on purpose: the mutation this guards against is written by an agent
 * that may be steered by attacker-controlled message text, and a 32- or 64-bit
 * checksum is collidable by construction.
 *
 * Text is trimmed before hashing because every send path trims before it
 * enqueues (`approve-draft`, `send`), so trailing whitespace is not a
 * difference the owner could have seen.
 */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
	0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
	0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
	0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
	0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
	0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
	0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2
]);

function rotr(x: number, n: number): number {
	return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(text: string): string {
	const data = new TextEncoder().encode(text);
	const blocks = ((data.length + 9 + 63) >> 6) << 6;
	const padded = new Uint8Array(blocks);
	padded.set(data);
	padded[data.length] = 0x80;

	const view = new DataView(padded.buffer);
	const bitLength = data.length * 8;
	view.setUint32(blocks - 8, Math.floor(bitLength / 2 ** 32));
	view.setUint32(blocks - 4, bitLength >>> 0);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
		0x5be0cd19
	]);
	const w = new Uint32Array(64);

	for (let offset = 0; offset < blocks; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i += 1) {
			const x = w[i - 15] as number;
			const y = w[i - 2] as number;
			const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
			const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
			w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
		}

		let a = h[0] as number;
		let b = h[1] as number;
		let c = h[2] as number;
		let d = h[3] as number;
		let e = h[4] as number;
		let f = h[5] as number;
		let g = h[6] as number;
		let hh = h[7] as number;

		for (let i = 0; i < 64; i += 1) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;

			hh = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		h[0] = (h[0] + a) >>> 0;
		h[1] = (h[1] + b) >>> 0;
		h[2] = (h[2] + c) >>> 0;
		h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0;
		h[5] = (h[5] + f) >>> 0;
		h[6] = (h[6] + g) >>> 0;
		h[7] = (h[7] + hh) >>> 0;
	}

	let hex = '';
	for (let i = 0; i < 8; i += 1) hex += (h[i] as number).toString(16).padStart(8, '0');
	return hex;
}

/**
 * The approval hash for a payload: SHA-256 of the trimmed text.
 *
 * Compare with {@link approvalHashMatches} rather than `===` so callers cannot
 * accidentally treat a missing hash as a match.
 */
export function hashApprovalText(text: string): string {
	return sha256Hex(text.trim());
}

/**
 * True only when the caller supplied a hash and it matches the stored text.
 *
 * A caller that supplies nothing gets `false` here; whether that is a refusal
 * or an accepted legacy path is the action's decision, not this helper's.
 */
export function approvalHashMatches(text: string, hash: string | undefined): boolean {
	if (typeof hash !== 'string' || hash.length === 0) return false;
	return hashApprovalText(text) === hash.toLowerCase();
}

/**
 * Discriminator on the 409 body. `approve-draft` can now refuse for two
 * different reasons and the client must not confuse them: a stale basis wants
 * "re-read the thread", a changed payload wants "this is not what you read".
 */
export const CONFLICT_TEXT_CHANGED = 'text-changed';
export const CONFLICT_STALE_INBOUND = 'stale-inbound';

/** Who last wrote `drafts.text` — drives the re-confirmation copy. */
export type DraftTextSource = 'owner' | 'agent' | 'system';

export function describeTextSource(source: string | null | undefined): string {
	switch (source) {
		case 'agent':
			return 'The agent rewrote this draft after you read it.';
		case 'owner':
			return 'This draft was edited after you read it.';
		default:
			return 'This draft was regenerated after you read it.';
	}
}
