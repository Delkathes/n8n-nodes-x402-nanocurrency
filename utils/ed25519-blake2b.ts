/**
 * Ed25519 verification for the Nano protocol (zero dependencies).
 *
 * Nano does not use standard Ed25519 (RFC 8032): it uses "ed25519-blake2b",
 * where the BLAKE2b-512 hash replaces SHA-512 when computing the verification
 * challenge. Node's built-in crypto.verify therefore cannot verify Nano
 * signatures, so the curve arithmetic is implemented here on top of the
 * vendored BLAKE2b in ./blake2b.
 *
 * Implementation notes:
 * - Points use extended homogeneous coordinates (X, Y, Z, T).
 * - Addition is add-2008-hwcd-3, doubling is dbl-2008-hwcd (from the EFD).
 * - Verification follows RFC 8032 §5.1.7 with cofactored multiplication
 *   ([8][S]B == [8]R + [8][k]A), which is secure even when R/A are not
 *   known to be in the prime-order subgroup.
 * - Signing follows RFC 8032 §5.1.6 with SHA-512 replaced by BLAKE2b-512.
 *
 * Reference: https://docs.nano.org/protocol-design/signing-hashing-and-key-derivation/
 */

import { blake2b } from './blake2b';

const P = 2n ** 255n - 19n; // field prime
const L = 2n ** 252n + 27742317777372353535851937790883648493n; // group order
const D =
	37095705934669439343138083508754565189542113879843219016388785533085940283555n; // -121665/121666
const SQRT_M1 =
	19681161376707505956807079304988542015446066515923890162744021073123829784752n;

const B_X = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const B_Y = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

interface Point {
	X: bigint;
	Y: bigint;
	Z: bigint;
	T: bigint;
}

const IDENTITY: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n };

const BASE: Point = { X: B_X, Y: B_Y, Z: 1n, T: (B_X * B_Y) % P };

function mod(a: bigint): bigint {
	const r = a % P;
	return r >= 0n ? r : r + P;
}

function powmod(base: bigint, exp: bigint): bigint {
	let result = 1n;
	base = mod(base);
	while (exp > 0n) {
		if (exp & 1n) {
			result = (result * base) % P;
		}
		base = (base * base) % P;
		exp >>= 1n;
	}
	return result;
}

function inv(a: bigint): bigint {
	return powmod(a, P - 2n);
}

/** Unified point addition: add-2008-hwcd-3. */
function pointAdd(p1: Point, p2: Point): Point {
	const a = mod((p1.Y - p1.X) * (p2.Y - p2.X));
	const b = mod((p1.Y + p1.X) * (p2.Y + p2.X));
	const c = mod(p1.T * 2n * D * p2.T);
	const dd = mod(p1.Z * 2n * p2.Z);
	const e = mod(b - a);
	const f = mod(dd - c);
	const g = mod(dd + c);
	const h = mod(b + a);
	return {
		X: mod(e * f),
		Y: mod(g * h),
		T: mod(e * h),
		Z: mod(f * g),
	};
}

/** Point doubling: dbl-2008-hwcd. */
function pointDouble(p: Point): Point {
	const a = mod(p.X * p.X);
	const b = mod(p.Y * p.Y);
	const c = mod(2n * p.Z * p.Z);
	const d = mod(-a);
	const e = mod((p.X + p.Y) * (p.X + p.Y) - a - b);
	const g = mod(d + b);
	const f = mod(g - c);
	const h = mod(d - b);
	return {
		X: mod(e * f),
		Y: mod(g * h),
		T: mod(e * h),
		Z: mod(f * g),
	};
}

function scalarMult(p: Point, scalar: bigint): Point {
	let result = IDENTITY;
	let addend = p;
	let bits = scalar;
	while (bits > 0n) {
		if (bits & 1n) {
			result = pointAdd(result, addend);
		}
		addend = pointDouble(addend);
		bits >>= 1n;
	}
	return result;
}

function isIdentity(p: Point): boolean {
	return p.X === 0n && mod(p.Y) === mod(p.Z);
}

function negate(p: Point): Point {
	return { X: mod(-p.X), Y: p.Y, Z: p.Z, T: mod(-p.T) };
}

function readLittleEndian(bytes: Buffer, start: number, end: number): bigint {
	let result = 0n;
	for (let i = end - 1; i >= start; i--) {
		result = (result << 8n) | BigInt(bytes[i]);
	}
	return result;
}

function writeLittleEndian(value: bigint, length: number): Buffer {
	const out = Buffer.alloc(length);
	let remaining = value;
	for (let i = 0; i < length; i++) {
		out[i] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return out;
}

/** Encode a point as 32 bytes (little-endian y with the x parity in the top bit). */
function encodePoint(p: Point): Buffer {
	const zInv = inv(p.Z);
	const x = mod(p.X * zInv);
	const y = mod(p.Y * zInv);
	const out = writeLittleEndian(y, 32);
	if (x & 1n) {
		out[31] |= 0x80;
	}
	return out;
}

/** Clamp a private key per RFC 8032 §5.1.5. */
function clampScalar(keyBytes: Buffer): bigint {
	const clamped = Buffer.from(keyBytes);
	clamped[0] &= 248;
	clamped[31] &= 63;
	clamped[31] |= 64;
	return readLittleEndian(clamped, 0, 32);
}

/** Decompress a 32-byte point encoding (little-endian y with x sign bit). */
function decompressPoint(bytes: Buffer): Point | null {
	if (bytes.length !== 32) {
		return null;
	}
	const sign = (bytes[31] & 0x80) !== 0 ? 1n : 0n;
	const yBytes = Buffer.from(bytes);
	yBytes[31] &= 0x7f;
	const y = readLittleEndian(yBytes, 0, 32);
	if (y >= P) {
		return null;
	}

	const y2 = mod(y * y);
	const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
	let x = powmod(x2, (P + 3n) / 8n);
	if (mod(x * x) !== x2) {
		x = mod(x * SQRT_M1);
	}
	if (mod(x * x) !== x2) {
		return null;
	}
	if ((x & 1n) !== sign) {
		x = mod(-x);
	}

	return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

/**
 * Verify an ed25519-blake2b signature (as used by Nano).
 *
 * @param signature 64-byte signature (R || S, little-endian)
 * @param message message bytes
 * @param publicKey 32-byte public key
 */
export function verifyEd25519Blake2b(
	signature: Buffer,
	message: Buffer,
	publicKey: Buffer,
): boolean {
	if (signature.length !== 64 || publicKey.length !== 32) {
		return false;
	}

	const A = decompressPoint(publicKey);
	if (!A) {
		return false;
	}

	const R = decompressPoint(signature.subarray(0, 32));
	if (!R) {
		return false;
	}

	const S = readLittleEndian(signature, 32, 64);
	if (S >= L) {
		return false;
	}

	// k = BLAKE2b-512(R || A || M) mod L  (BLAKE2b replaces SHA-512 here)
	const challenge = blake2b(
		Buffer.concat([signature.subarray(0, 32), publicKey, message]),
		64,
	);
	const k = readLittleEndian(challenge, 0, 64) % L;

	// Check [8][S]B == [8]R + [8][k]A, i.e. [8](S·B - R - k·A) is the identity.
	let check = pointAdd(scalarMult(BASE, S), negate(R));
	check = pointAdd(check, negate(scalarMult(A, k)));
	check = scalarMult(check, 8n);

	return isIdentity(check);
}

/**
 * Derive the 32-byte public key from a 32-byte private key
 * (ed25519-blake2b: BLAKE2b-512 replaces SHA-512 in the expansion).
 */
export function derivePublicKey(privateKey: Buffer): Buffer {
	if (privateKey.length !== 32) {
		throw new Error(`Private key must be 32 bytes, got ${privateKey.length}`);
	}
	const expanded = blake2b(privateKey, 64);
	const scalar = clampScalar(expanded.subarray(0, 32));
	return encodePoint(scalarMult(BASE, scalar));
}

/**
 * Sign a message with a 32-byte private key (ed25519-blake2b, RFC 8032 §5.1.6
 * with SHA-512 replaced by BLAKE2b-512).
 * Returns the 64-byte signature (R || S, little-endian).
 */
export function signEd25519Blake2b(privateKey: Buffer, message: Buffer): Buffer {
	if (privateKey.length !== 32) {
		throw new Error(`Private key must be 32 bytes, got ${privateKey.length}`);
	}

	const expanded = blake2b(privateKey, 64);
	const scalar = clampScalar(expanded.subarray(0, 32));
	const prefix = expanded.subarray(32, 64);

	const r = readLittleEndian(blake2b(Buffer.concat([prefix, message]), 64), 0, 64) % L;
	const R = encodePoint(scalarMult(BASE, r));

	const publicKey = encodePoint(scalarMult(BASE, scalar));
	const k =
		readLittleEndian(blake2b(Buffer.concat([R, publicKey, message]), 64), 0, 64) % L;
	const S = (r + k * scalar) % L;

	return Buffer.concat([R, writeLittleEndian(S, 32)]);
}
