import { describe, expect, it } from 'vitest';

import { blake2b, blake2b256, blake2b40 } from '../utils/blake2b';
import {
	derivePublicKey,
	signEd25519Blake2b,
	verifyEd25519Blake2b,
} from '../utils/ed25519-blake2b';
import { decodeNanoAddress, encodeNanoAddress } from '../utils/nano-address';
import { buildSendBlock, signBlock, verifyBlock } from '../utils/block';
import type { NanoStateBlock } from '../utils/block';

// Real mainnet fixtures (fetched from a public Nano RPC node).
const BURN_ACCOUNT = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const BURN_ACCOUNT_PUBLIC_HEX = 'e89208dd038fbb269987689621d52292ae9c35941a7484756ecced92a65093ba';

const REGULAR_BLOCK: NanoStateBlock = {
	type: 'state',
	account: BURN_ACCOUNT,
	previous: 'ECCB8CB65CD3106EDA8CE9AA893FEAD497A91BCA903890CBD7A5C59F06AB9113',
	representative: BURN_ACCOUNT,
	balance: '325586539664609129644855132177',
	link: '65706F636820763120626C6F636B000000000000000000000000000000000000',
	link_as_account: 'nano_1sdifxjpia5p86i86u5hefoi1111111111111111111111111111g7jhnpfy',
	signature:
		'57BFE93F4675FC16DF0CCFC7EE4F78CC68047B5C14E2E2EED243F17348D8BAB3CCA04F8CBC2D291B4DDEC5F7A74C1BE1E872DF78D560C46365EB15270A1D1201',
	work: '0f78168d5b30191d',
};
const REGULAR_BLOCK_HASH = '6875C0DBFE5C44D8F8CFF431BC69ED5587C68F89F0663F2BC1FBBFCB46DC5989';

// A fixed test private key (32 bytes).
const TEST_PRIVATE_KEY = Buffer.from(
	'9f0e444c69f77a49bd0be89db92c38fe713e0963165cca12faf5712d7657120f',
	'hex',
);

describe('blake2b', () => {
	it('matches the RFC 7693 BLAKE2b-256 vector for "abc"', () => {
		expect(blake2b256(Buffer.from('abc')).toString('hex')).toBe(
			'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
		);
	});

	it('matches the RFC 7693 BLAKE2b-512 vector for "abc"', () => {
		expect(blake2b(Buffer.from('abc'), 64).toString('hex')).toBe(
			'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
		);
	});

	it('supports the 5-byte digest used by address checksums', () => {
		expect(blake2b40(Buffer.alloc(32, 1))).toHaveLength(5);
	});
});

describe('ed25519-blake2b', () => {
	it('verifies a real mainnet signature', () => {
		const signature = Buffer.from(REGULAR_BLOCK.signature, 'hex');
		const message = Buffer.from(REGULAR_BLOCK_HASH, 'hex');
		const publicKey = Buffer.from(BURN_ACCOUNT_PUBLIC_HEX, 'hex');
		expect(verifyEd25519Blake2b(signature, message, publicKey)).toBe(true);
	});

	it('derives the public key and signs/verifies roundtrip', () => {
		const publicKey = derivePublicKey(TEST_PRIVATE_KEY);
		expect(publicKey).toHaveLength(32);

		const message = Buffer.from('payment for x402', 'utf-8');
		const signature = signEd25519Blake2b(TEST_PRIVATE_KEY, message);
		expect(signature).toHaveLength(64);
		expect(verifyEd25519Blake2b(signature, message, publicKey)).toBe(true);
	});

	it('rejects a tampered message', () => {
		const publicKey = derivePublicKey(TEST_PRIVATE_KEY);
		const message = Buffer.from('payment for x402', 'utf-8');
		const signature = signEd25519Blake2b(TEST_PRIVATE_KEY, message);
		const tampered = Buffer.from('payment for x403', 'utf-8');
		expect(verifyEd25519Blake2b(signature, tampered, publicKey)).toBe(false);
	});
});

describe('nano addresses', () => {
	it('decodes the burn account with a valid checksum', () => {
		const publicKey = decodeNanoAddress(BURN_ACCOUNT);
		expect(publicKey).not.toBeNull();
		expect(publicKey!.toString('hex')).toBe(BURN_ACCOUNT_PUBLIC_HEX);
	});

	it('encode/decode roundtrip', () => {
		const publicKey = derivePublicKey(TEST_PRIVATE_KEY);
		const address = encodeNanoAddress(publicKey);
		expect(address).not.toBeNull();
		expect(address!.startsWith('nano_')).toBe(true);
		const decoded = decodeNanoAddress(address!);
		expect(decoded!.equals(publicKey)).toBe(true);
	});

	it('rejects corrupted checksums', () => {
		const corrupted = BURN_ACCOUNT.slice(0, -1) + (BURN_ACCOUNT.endsWith('r') ? 'a' : 'r');
		expect(decodeNanoAddress(corrupted)).toBeNull();
	});
});

describe('send blocks', () => {
	it('builds, signs and verifies a send block', () => {
		const payerPublicKey = derivePublicKey(TEST_PRIVATE_KEY);
		const payer = encodeNanoAddress(payerPublicKey) as string;

		const built = buildSendBlock({
			account: payer,
			previous: 'A'.repeat(64),
			representative: payer,
			balanceRaw: '1000000000000000000000000000000', // 1 NANO
			toAddress: BURN_ACCOUNT,
			amountRaw: '100000000000000000000000000000', // 0.1 NANO
		});
		expect(built).not.toBeNull();

		const signature = signBlock(TEST_PRIVATE_KEY, built!.hash);
		const signed: NanoStateBlock = {
			...built!.block,
			work: '2bf29ef00786a6bc',
			signature,
		};

		expect(signed.balance).toBe('900000000000000000000000000000');
		expect(signed.link_as_account).toBe(BURN_ACCOUNT);
		expect(verifyBlock(signed, built!.hash)).toBe(true);
	});

	it('rejects a block signed by the wrong key', () => {
		const payerPublicKey = derivePublicKey(TEST_PRIVATE_KEY);
		const payer = encodeNanoAddress(payerPublicKey) as string;

		const built = buildSendBlock({
			account: payer,
			previous: 'B'.repeat(64),
			representative: payer,
			balanceRaw: '1000000000000000000000000000000',
			toAddress: BURN_ACCOUNT,
			amountRaw: '100000000000000000000000000000',
		})!;

		const otherKey = Buffer.alloc(32, 7);
		const signature = signBlock(otherKey, built.hash);
		const signed: NanoStateBlock = { ...built.block, work: '2bf29ef00786a6bc', signature };
		expect(verifyBlock(signed, built.hash)).toBe(false);
	});

	it('rejects amounts above the balance', () => {
		const payerPublicKey = derivePublicKey(TEST_PRIVATE_KEY);
		const payer = encodeNanoAddress(payerPublicKey) as string;

		expect(
			buildSendBlock({
				account: payer,
				previous: 'C'.repeat(64),
				representative: payer,
				balanceRaw: '100',
				toAddress: BURN_ACCOUNT,
				amountRaw: '101',
			}),
		).toBeNull();
	});
});
