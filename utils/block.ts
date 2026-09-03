/**
 * Nano state block building, hashing and signing (zero dependencies).
 *
 * Uses the vendored BLAKE2b-256 (block hash) and ed25519-blake2b (signature)
 * implementations. Only state blocks are supported — the only block type
 * produced on the Nano network since the V21 epoch.
 *
 * Reference: https://docs.nano.org/protocol-design/blocks/#hashing-a-block
 */

import { decodeNanoAddress } from './nano-address';
import { blake2b256 } from './blake2b';
import { signEd25519Blake2b, verifyEd25519Blake2b } from './ed25519-blake2b';

export const MAX_UINT128 = (1n << 128n) - 1n;

export interface NanoStateBlock {
	type: 'state';
	account: string;
	previous: string;
	representative: string;
	balance: string;
	link: string;
	link_as_account?: string;
	work: string;
	signature: string;
}

export interface SendBlockParams {
	/** Payer account address */
	account: string;
	/** Payer frontier block hash (previous block) */
	previous: string;
	/** Payer representative address */
	representative: string;
	/** Payer confirmed balance in raw */
	balanceRaw: string;
	/** Destination account address */
	toAddress: string;
	/** Amount to send in raw */
	amountRaw: string;
}

function hexToBytes(hex: string): Buffer | null {
	if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
		return null;
	}
	return Buffer.from(hex, 'hex');
}

function toUint128BigEndian(value: bigint): Buffer {
	const out = Buffer.alloc(16);
	let remaining = value;
	for (let i = 15; i >= 0; i--) {
		out[i] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return out;
}

/**
 * Compute the BLAKE2b-256 hash of a state block from its contents.
 * Returns null if any field is malformed.
 */
export function computeStateBlockHash(block: NanoStateBlock): Buffer | null {
	if (block.type !== 'state') {
		return null;
	}

	const accountKey = decodeNanoAddress(block.account);
	if (!accountKey) {
		return null;
	}

	const previous = hexToBytes(block.previous);
	if (!previous || previous.length !== 32) {
		return null;
	}

	const representativeKey = decodeNanoAddress(block.representative);
	if (!representativeKey) {
		return null;
	}

	let balance: bigint;
	try {
		balance = BigInt(block.balance);
	} catch {
		return null;
	}
	if (balance < 0n || balance > MAX_UINT128) {
		return null;
	}

	// The link field is either a 64-hex hash or the public key of the
	// destination account (send blocks, hex form).
	let linkBytes = hexToBytes(block.link);
	if (linkBytes && linkBytes.length !== 32) {
		return null;
	}
	if (!linkBytes) {
		const linkKey = decodeNanoAddress(block.link);
		if (!linkKey) {
			return null;
		}
		linkBytes = linkKey;
	}

	// Preamble: 32 bytes, all zero except the last byte (state block type 6).
	const preamble = Buffer.alloc(32);
	preamble[31] = 6;

	return blake2b256(
		Buffer.concat([
			preamble,
			accountKey,
			previous,
			representativeKey,
			toUint128BigEndian(balance),
			linkBytes,
		]),
	);
}

/**
 * Build an unsigned Nano state send block for an x402 payment.
 * Returns the block (without work/signature) and its hash.
 */
export function buildSendBlock(
	params: SendBlockParams,
): { block: NanoStateBlock; hash: string } | null {
	const toKey = decodeNanoAddress(params.toAddress);
	if (!toKey) {
		return null;
	}

	let balance: bigint;
	let amount: bigint;
	try {
		balance = BigInt(params.balanceRaw);
		amount = BigInt(params.amountRaw);
	} catch {
		return null;
	}
	if (amount <= 0n || amount > balance) {
		return null;
	}

	const block: NanoStateBlock = {
		type: 'state',
		account: params.account,
		previous: params.previous.toUpperCase(),
		representative: params.representative,
		balance: (balance - amount).toString(),
		link: toKey.toString('hex').toUpperCase(),
		link_as_account: params.toAddress,
		work: '',
		signature: '',
	};

	const hash = computeStateBlockHash(block);
	if (!hash) {
		return null;
	}

	return { block, hash: hash.toString('hex') };
}

/**
 * Sign a state block with a 32-byte private key.
 * Returns the 128-hex-character signature.
 */
export function signBlock(privateKey: Buffer, hashHex: string): string {
	const hashBytes = hexToBytes(hashHex);
	if (!hashBytes || hashBytes.length !== 32 || privateKey.length !== 32) {
		throw new Error('Cannot sign block: invalid private key or block hash');
	}
	return signEd25519Blake2b(privateKey, hashBytes).toString('hex');
}

/**
 * Verify a state block signature and that the block contents hash to the
 * reported hash. Used for local (facilitator-free) payment verification.
 */
export function verifyBlock(block: NanoStateBlock, reportedHash?: string): boolean {
	if (!block || block.type !== 'state' || !block.signature) {
		return false;
	}

	const computedHash = computeStateBlockHash(block);
	if (!computedHash) {
		return false;
	}

	if (reportedHash) {
		const expected = hexToBytes(reportedHash);
		if (!expected || expected.length !== 32 || !computedHash.equals(expected)) {
			return false;
		}
	}

	const publicKey = decodeNanoAddress(block.account);
	const signature = hexToBytes(block.signature);
	if (!publicKey || !signature || signature.length !== 64) {
		return false;
	}

	return verifyEd25519Blake2b(signature, computedHash, publicKey);
}
