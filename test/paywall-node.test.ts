import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import type { NanoStateBlock } from '../utils/block';
import { buildSendBlock, signBlock } from '../utils/block';
import { nanoToRaw } from '../utils/conversions';
import { derivePublicKey } from '../utils/ed25519-blake2b';
import { encodeNanoAddress } from '../utils/nano-address';
import { X402NanoPaywall } from '../nodes/X402Nano/X402NanoPaywall.node';

const MERCHANT = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const AMOUNT_NANO = '0.1';
const AMOUNT_RAW = nanoToRaw(AMOUNT_NANO);

const TEST_PRIVATE_KEY = Buffer.from(
	'9f0e444c69f77a49bd0be89db92c38fe713e0963165cca12faf5712d7657120f',
	'hex',
);
const PAYER = encodeNanoAddress(derivePublicKey(TEST_PRIVATE_KEY)) as string;

const FRONTIER = 'A'.repeat(64);
const BALANCE_RAW = '1000000000000000000000000000000'; // 1 NANO

function makeSignedSendBlock(amountRaw: string): NanoStateBlock {
	const built = buildSendBlock({
		account: PAYER,
		previous: FRONTIER,
		representative: PAYER,
		balanceRaw: BALANCE_RAW,
		toAddress: MERCHANT,
		amountRaw,
	});
	expect(built).not.toBeNull();
	return {
		...built!.block,
		work: '2bf29ef00786a6bc',
		signature: signBlock(TEST_PRIVATE_KEY, built!.hash),
	};
}

function encodeV2PaymentHeader(block: NanoStateBlock, paymentId?: string): string {
	const envelope = {
		x402Version: 2,
		scheme: 'nano-exact',
		network: 'nano:mainnet',
		accepted: {
			scheme: 'exact',
			network: 'nano:mainnet',
			amount: AMOUNT_RAW,
			payTo: MERCHANT,
			asset: 'XNO',
			...(paymentId ? { extra: { paymentId } } : {}),
		},
		payload: { block },
	};
	return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

function encodeV1PaymentHeader(block: NanoStateBlock, paymentId?: string): string {
	const envelope = {
		x402Version: 1,
		scheme: 'nano-exact',
		network: 'nano:mainnet',
		payload: {
			...(paymentId ? { paymentId } : {}),
			block,
		},
	};
	return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

type RouteResponses = {
	verify?: Record<string, unknown>;
	settle?: Record<string, unknown>;
	blockInfo?: Record<string, unknown>;
	accountInfo?: Record<string, unknown>;
	workValidate?: Record<string, unknown>;
	process?: Record<string, unknown>;
};

const DEFAULTS: Record<string, unknown> = {
	payTo: MERCHANT,
	amount: AMOUNT_NANO,
	paymentId: '',
	protocol: 'both',
	serviceName: '',
	resourceDescription: '',
	resourceUrl: '',
	mimeType: 'application/json',
	tags: '',
	errorMessage: '',
	maxTimeoutSeconds: 0,
	verificationMode: 'facilitator',
	autoSettle: true,
	settleMode: 'facilitator',
};

function mockContext(input: INodeExecutionData[], routes: RouteResponses): IExecuteFunctions {
	return {
		getInputData: () => input,
		getNode: () => ({ type: 'n8n-nodes-x402-nanocurrency.x402NanoPaywall' }),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in DEFAULTS ? DEFAULTS[name] : (fallback ?? ''),
		getCredentials: async () => ({
			rpcUrl: 'https://rpc.nano.to',
			facilitatorUrl: 'https://x402nano.org/facilitator',
		}),
		helpers: {
			httpRequestWithAuthentication: async (
				_credentialType: string,
				options: { url?: string; body?: { action?: string } },
			) => {
				if (options.body?.action === 'block_info')
					return routes.blockInfo ?? { error: 'Block not found' };
				if (options.body?.action === 'account_info')
					return routes.accountInfo ?? { error: 'Account not found' };
				if (options.body?.action === 'work_validate')
					return routes.workValidate ?? { valid_all: '1' };
				if (options.body?.action === 'process') return routes.process ?? { hash: 'F'.repeat(64) };
				if (options.url?.includes('/verify'))
					return routes.verify ?? { isValid: false, invalidReason: 'verify unreachable' };
				if (options.url?.includes('/settle'))
					return routes.settle ?? { success: false, errorReason: 'settle unreachable' };
				return {};
			},
		},
	} as unknown as IExecuteFunctions;
}

function withHeader(headers: Record<string, string>, body: unknown = {}) {
	return { json: { headers, body } } as INodeExecutionData;
}

function accountInfoFixture() {
	return {
		frontier: FRONTIER,
		balance: BALANCE_RAW,
		representative: PAYER,
		confirmed_frontier: FRONTIER,
	};
}

describe('X402 Nano Paywall', () => {
	it('describes two labeled outputs', () => {
		const node = new X402NanoPaywall();
		expect(node.description.name).toBe('x402NanoPaywall');
		const outputs = node.description.outputs as Array<{ displayName?: string }>;
		expect(outputs.map((output) => output.displayName)).toEqual(['Payment required', 'Payment received']);
	});

	it('answers a 402 envelope for a request without a payment header', async () => {
		const node = new X402NanoPaywall();
		const [required, received] = await node.execute.call(
			mockContext([withHeader({ 'content-type': 'application/json' })], {}),
		);
		expect(required).toHaveLength(1);
		expect(received).toHaveLength(0);
		const json = required[0].json as { statusCode: number; headers: Record<string, string> };
		expect(json.statusCode).toBe(402);
		expect(json.headers['PAYMENT-REQUIRED']).toBeDefined();
	});

	it('answers a 402 envelope for a garbage payment header', async () => {
		const node = new X402NanoPaywall();
		const [required, received] = await node.execute.call(
			mockContext([withHeader({ 'payment-signature': 'garbage!!' })], {}),
		);
		expect(required).toHaveLength(1);
		expect(received).toHaveLength(0);
		expect((required[0].json as { statusCode: number }).statusCode).toBe(402);
	});

	it('answers a 402 envelope for a well-shaped header with no state block', async () => {
		const node = new X402NanoPaywall();
		const notABlock = {
			x402Version: 2,
			scheme: 'nano-exact',
			network: 'nano:mainnet',
			payload: { block: { type: 'receive' } },
		};
		const value = Buffer.from(JSON.stringify(notABlock)).toString('base64');
		const [required, received] = await node.execute.call(
			mockContext([withHeader({ 'payment-signature': value })], { verify: { isValid: false } }),
		);
		expect(required).toHaveLength(1);
		expect(received).toHaveLength(0);
	});

	it('settles a valid payment and emits the 200 envelope', async () => {
		const node = new X402NanoPaywall();
		const [required, received] = await node.execute.call(
			mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW)) })], {
				verify: { isValid: true, payer: PAYER },
				settle: { success: true, transaction: 'ABCDEF', network: 'nano:mainnet', payer: PAYER },
			}),
		);
		expect(required).toHaveLength(0);
		expect(received).toHaveLength(1);
		const json = received[0].json as {
			statusCode: number;
			headers: Record<string, string>;
			request: { payment: { hasPayment: boolean } };
		};
		expect(json.statusCode).toBe(200);
		expect(json.headers['PAYMENT-RESPONSE']).toBeDefined();
		expect(json.request.payment.hasPayment).toBe(true);
	});

	it('emits the verified payment (unsettled) when auto-settle is off', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.autoSettle = false;
		try {
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW)) })], {
					verify: { isValid: true, payer: PAYER },
				}),
			);
			expect(required).toHaveLength(0);
			expect(received).toHaveLength(1);
			const json = received[0].json as { settled: boolean; verified: boolean; payTo: string };
			expect(json.settled).toBe(false);
			expect(json.verified).toBe(true);
			expect(json.payTo).toBe(MERCHANT);
		} finally {
			DEFAULTS.autoSettle = true;
		}
	});

	it('treats an already-on-chain retry as received without settling again', async () => {
		const node = new X402NanoPaywall();
		const block = makeSignedSendBlock(AMOUNT_RAW);
		let settleCalls = 0;
		const context = mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(block) })], {
			verify: { isValid: false, invalidReason: 'already processed' },
			blockInfo: {
				block_account: PAYER,
				amount: AMOUNT_RAW,
				subtype: 'send',
				contents: { link: block.link, link_as_account: MERCHANT },
			},
		});
		// Count settle calls by wrapping the route response.
		const orig = (context.helpers as { httpRequestWithAuthentication: unknown }).httpRequestWithAuthentication;
		(context.helpers as { httpRequestWithAuthentication: unknown }).httpRequestWithAuthentication = async (
			_credentialType: string,
			options: { url?: string; body?: { action?: string } },
		) => {
			if (options.url?.includes('/settle')) {
				settleCalls += 1;
				return { success: false, errorReason: 'should not be called' };
			}
			return orig.call(context, _credentialType, options);
		};

		const [required, received] = await node.execute.call(context);
		expect(settleCalls).toBe(0);
		expect(required).toHaveLength(0);
		expect(received).toHaveLength(1);
		const json = received[0].json as { statusCode: number; replayed: boolean; headers: Record<string, string> };
		expect(json.statusCode).toBe(200);
		expect(json.replayed).toBe(true);
		expect(json.headers['PAYMENT-RESPONSE']).toBeDefined();
	});

	it('throws (never a 402) when settlement of a valid payment fails', async () => {
		const node = new X402NanoPaywall();
		await expect(
			node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW)) })], {
					verify: { isValid: true, payer: PAYER },
					settle: { success: false, errorReason: 'node busy' },
				}),
			),
		).rejects.toThrow('Settlement failed: node busy');
	});

	it('splits mixed requests across the two outputs', async () => {
		const node = new X402NanoPaywall();
		const [required, received] = await node.execute.call(
			mockContext(
				[
					withHeader({ 'content-type': 'application/json' }),
					withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW)) }),
					withHeader({ 'x-payment': 'broken' }),
				],
				{
					verify: { isValid: true, payer: PAYER },
					settle: { success: true, transaction: 'ABCDEF', network: 'nano:mainnet', payer: PAYER },
				},
			),
		);
		expect(required).toHaveLength(2);
		expect(received).toHaveLength(1);
	});

	it('rejects an underpayment (1 raw) in local verification mode', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.verificationMode = 'local';
		try {
			const block = makeSignedSendBlock('1');
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(block) })], {
					accountInfo: accountInfoFixture(),
				}),
			);
			expect(required).toHaveLength(1);
			expect(received).toHaveLength(0);
			expect((required[0].json as { statusCode: number }).statusCode).toBe(402);
		} finally {
			DEFAULTS.verificationMode = 'facilitator';
		}
	});

	it('accepts and settles an exact-amount payment in local mode end to end', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.verificationMode = 'local';
		DEFAULTS.settleMode = 'local';
		try {
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW)) })], {
					accountInfo: accountInfoFixture(),
				}),
			);
			expect(required).toHaveLength(0);
			expect(received).toHaveLength(1);
			const json = received[0].json as { statusCode: number; headers: Record<string, string> };
			expect(json.statusCode).toBe(200);
			expect(json.headers['PAYMENT-RESPONSE']).toBeDefined();
		} finally {
			DEFAULTS.verificationMode = 'facilitator';
			DEFAULTS.settleMode = 'facilitator';
		}
	});

	it('surfaces an error instead of a 402 when replay detection cannot run', async () => {
		const node = new X402NanoPaywall();
		const context = mockContext(
			[withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW)) })],
			{ verify: { isValid: false, invalidReason: 'already processed' } },
		);
		(context as { getCredentials: unknown }).getCredentials = async (name?: string) => {
			if (name === 'x402NanoApi') {
				throw new Error('no x402NanoApi credential');
			}
			return { rpcUrl: 'https://rpc.nano.to', facilitatorUrl: 'https://x402nano.org/facilitator' };
		};
		await expect(node.execute.call(context)).rejects.toThrow(/Replay detection failed/);
	});

	it('answers a forged (unverifiable) block with 402 without touching the RPC', async () => {
		const node = new X402NanoPaywall();
		const forged: NanoStateBlock = {
			type: 'state',
			account: PAYER,
			previous: FRONTIER,
			representative: PAYER,
			balance: '999999999999999999999999999999',
			link: '1'.repeat(64),
			link_as_account: MERCHANT,
			work: '2bf29ef00786a6bc',
			signature: 'B'.repeat(128),
		};
		let blockInfoCalls = 0;
		const context = mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(forged) })], {
			verify: { isValid: false, invalidReason: 'invalid signature' },
		});
		const orig = (context.helpers as { httpRequestWithAuthentication: unknown }).httpRequestWithAuthentication;
		(context.helpers as { httpRequestWithAuthentication: unknown }).httpRequestWithAuthentication = async (
			_credentialType: string,
			options: { url?: string; body?: { action?: string } },
		) => {
			if (options.body?.action === 'block_info') {
				blockInfoCalls += 1;
				return { error: 'Block not found' };
			}
			return orig.call(context, _credentialType, options);
		};
		const [required, received] = await node.execute.call(context);
		expect(required).toHaveLength(1);
		expect(received).toHaveLength(0);
		expect(blockInfoCalls).toBe(0);
	});

	it('rejects a v2 payment whose paymentId does not match the request', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.paymentId = 'req-123';
		try {
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW), 'req-999') })], {
					verify: { isValid: true, payer: PAYER },
				}),
			);
			expect(required).toHaveLength(1);
			expect(received).toHaveLength(0);
			expect((required[0].json as { statusCode: number }).statusCode).toBe(402);
		} finally {
			DEFAULTS.paymentId = '';
		}
	});

	it('accepts a v2 payment whose paymentId matches the request', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.paymentId = 'req-123';
		try {
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(makeSignedSendBlock(AMOUNT_RAW), 'req-123') })], {
					verify: { isValid: true, payer: PAYER },
					settle: { success: true, transaction: 'ABCDEF', network: 'nano:mainnet', payer: PAYER },
				}),
			);
			expect(required).toHaveLength(0);
			expect(received).toHaveLength(1);
		} finally {
			DEFAULTS.paymentId = '';
		}
	});

	it('rejects a v1 payment whose payload paymentId does not match the request', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.paymentId = 'req-123';
		try {
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'x-payment': encodeV1PaymentHeader(makeSignedSendBlock(AMOUNT_RAW), 'req-999') })], {
					verify: { isValid: true, payer: PAYER },
				}),
			);
			expect(required).toHaveLength(1);
			expect(received).toHaveLength(0);
		} finally {
			DEFAULTS.paymentId = '';
		}
	});

	it('emits an unsettled replayed envelope (no settlement headers) when auto-settle is off', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.autoSettle = false;
		try {
			const block = makeSignedSendBlock(AMOUNT_RAW);
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader(block) })], {
					verify: { isValid: false, invalidReason: 'already processed' },
					blockInfo: {
						block_account: PAYER,
						amount: AMOUNT_RAW,
						subtype: 'send',
						contents: { link: block.link, link_as_account: MERCHANT },
					},
				}),
			);
			expect(required).toHaveLength(0);
			expect(received).toHaveLength(1);
			const json = received[0].json as {
				statusCode: number;
				replayed: boolean;
				settled: boolean;
				verified: boolean;
				headers: Record<string, string>;
			};
			expect(json.statusCode).toBe(200);
			expect(json.replayed).toBe(true);
			expect(json.settled).toBe(false);
			expect(json.verified).toBe(true);
			expect(json.headers).toEqual({});
		} finally {
			DEFAULTS.autoSettle = true;
		}
	});
});