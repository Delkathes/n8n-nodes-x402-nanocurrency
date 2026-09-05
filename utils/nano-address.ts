/**
 * Nano account address decoding (zero dependencies).
 *
 * A Nano address is: "nano_" (or "xrb_") + 52 base32 chars encoding the
 * 32-byte public key + 8 base32 chars encoding the 5-byte checksum.
 *
 * Nano uses a custom base32 alphabet ('13456789abcdefghijkmnopqrstuwxyz',
 * standard RFC4648 alphabet with 0 and 2 removed). A quirk of the encoding is
 * that the first character only encodes a single bit of the key, which is why
 * all account addresses start with 'nano_1' or 'nano_3'.
 *
 * The checksum is the 5-byte BLAKE2b hash of the public key, in reverse order.
 * Reference: https://docs.nano.org/protocol-design/accounts/
 */

import { blake2b40 } from './blake2b';

const NANO_ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';

const ADDRESS_REGEX = /^(nano|xrb)_[13][13-9a-km-uw-z]{59}$/;

/** Base32 value of a Nano alphabet character, or -1 if invalid. */
function base32Value(char: string): number {
	const value = NANO_ALPHABET.indexOf(char);
	return value === -1 ? -1 : value;
}

/** Decode 8 Nano base32 characters into 5 bytes (big-endian bit packing). */
function decodeChecksum(chars: string): Buffer | null {
	let bits = 0n;
	for (let i = 0; i < chars.length; i++) {
		const value = base32Value(chars[i]);
		if (value < 0) {
			return null;
		}
		bits = (bits << 5n) | BigInt(value);
	}
	const bytes = Buffer.alloc(5);
	let remaining = bits;
	for (let i = 4; i >= 0; i--) {
		bytes[i] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	if (remaining !== 0n) {
		return null;
	}
	return bytes;
}

/**
 * Decode a Nano address into its 32-byte public key.
 * Returns null if the address is malformed or its checksum does not match.
 */
export function decodeNanoAddress(address: string): Buffer | null {
	if (typeof address !== 'string' || !ADDRESS_REGEX.test(address)) {
		return null;
	}

	const payload = address.slice(address.startsWith('xrb_') ? 4 : 5); // strip "nano_"(5) / "xrb_"(4)
	const keyChars = payload.slice(0, 52);
	const checksumChars = payload.slice(52, 60);

	// First character encodes a single bit; the remaining 51 encode 255 bits.
	const firstBit = base32Value(keyChars[0]);
	if (firstBit !== 0 && firstBit !== 1) {
		return null;
	}

	let bits = BigInt(firstBit);
	for (let i = 1; i < 52; i++) {
		const value = base32Value(keyChars[i]);
		if (value < 0) {
			return null;
		}
		bits = (bits << 5n) | BigInt(value);
	}

	const publicKey = Buffer.alloc(32);
	let remaining = bits;
	for (let i = 31; i >= 0; i--) {
		publicKey[i] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	if (remaining !== 0n) {
		return null;
	}

	const expectedChecksum = Buffer.from(blake2b40(publicKey)).reverse();
	const actualChecksum = decodeChecksum(checksumChars);
	if (!actualChecksum || !expectedChecksum.equals(actualChecksum)) {
		return null;
	}

	return publicKey;
}

/**
 * Encode a 32-byte public key as a Nano account address.
 * Returns null for invalid key lengths.
 */
export function encodeNanoAddress(publicKey: Buffer, prefix: 'nano' | 'xrb' = 'nano'): string | null {
	if (publicKey.length !== 32) {
		return null;
	}

	// The key is 256 bits: the first character encodes the top bit, the
	// remaining 51 characters encode groups of 5 bits.
	let bits = 0n;
	for (const byte of publicKey) {
		bits = (bits << 8n) | BigInt(byte);
	}

	let keyChars = NANO_ALPHABET[Number((bits >> 255n) & 1n)];
	for (let i = 0; i < 51; i++) {
		const shift = 250 - i * 5;
		keyChars += NANO_ALPHABET[Number((bits >> BigInt(shift)) & 31n)];
	}

	// Checksum: reversed BLAKE2b-40 hash of the public key (5 bytes → 8 chars).
	const checksum = Buffer.from(blake2b40(publicKey)).reverse();
	let checksumBits = 0n;
	for (const byte of checksum) {
		checksumBits = (checksumBits << 8n) | BigInt(byte);
	}
	let checksumChars = '';
	for (let i = 0; i < 8; i++) {
		const shift = 35 - i * 5;
		checksumChars += NANO_ALPHABET[Number((checksumBits >> BigInt(shift)) & 31n)];
	}

	return `${prefix}_${keyChars}${checksumChars}`;
}
