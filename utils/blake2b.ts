/**
 * Pure-JS BLAKE2b implementation with configurable digest length.
 *
 * Vendored instead of using the `blakejs` npm package because n8n community
 * node packages must not declare runtime dependencies (they get bundled into
 * the host n8n installation and can conflict with other nodes).
 *
 * Uses BigInt for 64-bit arithmetic. Only used for short inputs
 * (32-200 byte block hashes), so performance is not a concern.
 *
 * Reference: RFC 7693 (BLAKE2)
 */

const M64 = 0xffffffffffffffffn;
const M32 = 0xffffffffn;

const IV: bigint[] = [
	0x6a09e667f3bcc908n,
	0xbb67ae8584caa73bn,
	0x3c6ef372fe94f82bn,
	0xa54ff53a5f1d36f1n,
	0x510e527fade682d1n,
	0x9b05688c2b3e6c1fn,
	0x1f83d9abfb41bd6bn,
	0x5be0cd19137e2179n,
];

const SIGMA: number[][] = [
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
	[14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
	[11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
	[7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
	[9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
	[2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
	[12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
	[13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
	[6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
	[10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

/** Rotate a 64-bit value right by n bits (n < 32). */
function rotr32(x: bigint, n: number): bigint {
	const lo = x & M32;
	const hi = (x >> 32n) & M32;
	const shiftedLo = ((lo >> BigInt(n)) | (hi << BigInt(32 - n))) & M32;
	const shiftedHi = ((hi >> BigInt(n)) | (lo << BigInt(32 - n))) & M32;
	return (shiftedHi << 32n) | shiftedLo;
}

/** Rotate a 64-bit value left by 1 bit. */
function rotl1(x: bigint): bigint {
	const lo = x & M32;
	const hi = (x >> 32n) & M32;
	const newLo = ((lo << 1n) | (hi >> 31n)) & M32;
	const newHi = ((hi << 1n) | (lo >> 31n)) & M32;
	return (newHi << 32n) | newLo;
}

/** Rotate a 64-bit value right by n bits (any n). */
function rotr(x: bigint, n: number): bigint {
	if (n === 32) {
		const lo = x & M32;
		const hi = (x >> 32n) & M32;
		return (lo << 32n) | hi;
	}
	if (n === 63) {
		return rotl1(x);
	}
	return rotr32(x, n);
}

function g(
	v: bigint[],
	a: number,
	b: number,
	c: number,
	d: number,
	x: bigint,
	y: bigint,
): void {
	v[a] = (v[a] + v[b] + x) & M64;
	v[d] = rotr(v[d] ^ v[a], 32);
	v[c] = (v[c] + v[d]) & M64;
	v[b] = rotr(v[b] ^ v[c], 24);
	v[a] = (v[a] + v[b] + y) & M64;
	v[d] = rotr(v[d] ^ v[a], 16);
	v[c] = (v[c] + v[d]) & M64;
	v[b] = rotr(v[b] ^ v[c], 63);
}

/** Load a 128-byte block as 16 little-endian 64-bit words. */
function loadBlock(data: Buffer, offset: number): bigint[] {
	const words: bigint[] = new Array(16);
	for (let i = 0; i < 16; i++) {
		let word = 0n;
		for (let j = 0; j < 8; j++) {
			word |= BigInt(data[offset + i * 8 + j]) << BigInt(8 * j);
		}
		words[i] = word;
	}
	return words;
}

/** Compress one 128-byte block. */
function compress(
	h: bigint[],
	block: Buffer,
	offset: number,
	counter: bigint,
	isLast: boolean,
): void {
	const v: bigint[] = [...h, ...IV];
	v[12] = (v[12] ^ counter) & M64;
	v[13] = (v[13] ^ (counter >> 64n)) & M64;
	if (isLast) {
		v[14] = (~v[14]) & M64;
	}

	const m = loadBlock(block, offset);

	for (let round = 0; round < 12; round++) {
		const s = SIGMA[round % 10];
		g(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
		g(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
		g(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
		g(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
		g(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
		g(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
		g(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
		g(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
	}

	for (let i = 0; i < 8; i++) {
		h[i] = (h[i] ^ v[i] ^ v[i + 8]) & M64;
	}
}

/**
 * Compute BLAKE2b with an arbitrary output length.
 *
 * @param data input bytes
 * @param outLen digest length in bytes (1-64)
 */
export function blake2b(data: Buffer, outLen: number): Buffer {
	if (outLen < 1 || outLen > 64) {
		throw new Error(`Invalid BLAKE2b output length: ${outLen} (must be 1-64)`);
	}

	const h: bigint[] = [...IV];
	h[0] = (h[0] ^ 0x01010000n ^ BigInt(outLen)) & M64;

	const len = data.length;
	const padded = Buffer.alloc(Math.ceil(len / 128) * 128 || (len === 0 ? 128 : 0));
	if (len > 0) {
		data.copy(padded);
	}

	// BLAKE2b requires the last-block flag on a block that exists. When the
	// message is an exact multiple of 128 bytes, an extra zero block is used.
	let blocks = Math.floor(padded.length / 128);
	if (blocks === 0) {
		blocks = 1;
	}
	const needsExtraBlock = len > 0 && len % 128 === 0;

	for (let i = 0; i < blocks; i++) {
		const isLast = i === blocks - 1 && !needsExtraBlock;
		compress(h, padded, i * 128, BigInt(Math.min(len, (i + 1) * 128)), isLast);
	}
	if (needsExtraBlock) {
		const zeroBlock = Buffer.alloc(128);
		compress(h, zeroBlock, 0, BigInt(len), true);
	}

	const out = Buffer.alloc(outLen);
	const state = Buffer.alloc(64);
	for (let i = 0; i < 8; i++) {
		state.writeBigUInt64LE(h[i] & M64, i * 8);
	}
	state.copy(out, 0, 0, outLen);
	return out;
}

/** BLAKE2b-256 (32-byte digest) — the hash used by the Nano protocol. */
export function blake2b256(data: Buffer): Buffer {
	return blake2b(data, 32);
}

/** BLAKE2b with 5-byte digest — used by Nano address checksums. */
export function blake2b40(data: Buffer): Buffer {
	return blake2b(data, 5);
}
