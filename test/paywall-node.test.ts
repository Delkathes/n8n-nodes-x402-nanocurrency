import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import type { NanoStateBlock } from '../utils/block';
import { nanoToRaw } from '../utils/conversions';
import { X402NanoPaywall } from '../nodes/X402Nano/X402NanoPaywall.node';

const PAYER = 'nano_3pjfq1datrr1xqs41g5hioxt6nxenuu8ygdxg3mikwduj3zgn5xugazi6f6s';
const MERCHANT = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const AMOUNT_NANO = '0.1';
const AMOUNT_RAW = nanoToRaw(AMOUNT_NANO);

const BLOCK: NanoStateBlock = {
	type: 'state',
	account: PAYER,
	previous: '0'.repeat(64),
	representative: PAYER,
	balance: '200000000000000000000000000000',
	link: '1'.repeat(64),
	link_as_account: MERCHANT,
	work: '2bf29ef00786a6bc',
	signature: 'B'.repeat(128),
};

function encodeV2PaymentHeader(): string {
	const envelope = {
		x402Version: 2,
		scheme: 'nano-exact',
		network: 'nano:mainnet',
		accepted: { scheme: 'exact', network: 'nano:mainnet', amount: AMOUNT_RAW, payTo: MERCHANT, asset: 'XNO' },
		payload: { block: BLOCK },
	};
	return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

type RouteResponses = {
	verify?: Record<string, unknown>;
	settle?: Record<string, unknown>;
	blockInfo?: Record<string, unknown>;
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
		getCredentials: async () => ({}),
		helpers: {
			httpRequestWithAuthentication: async (_credentialType: string, options: { url?: string; body?: { action?: string } }) => {
				if (options.body?.action === 'block_info') return routes.blockInfo ?? { error: 'not found' };
				if (options.url?.includes('/verify')) return routes.verify ?? { isValid: false, invalidReason: 'verify unreachable' };
				if (options.url?.includes('/settle')) return routes.settle ?? { success: false, errorReason: 'settle unreachable' };
				return {};
			},
		},
	} as unknown as IExecuteFunctions;
}

function withHeader(headers: Record<string, string>, body: unknown = {}) {
	return { json: { headers, body } } as INodeExecutionData;
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
		const notABlock = { x402Version: 2, scheme: 'nano-exact', network: 'nano:mainnet', payload: { block: { type: 'receive' } } };
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
			mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader() })], {
				verify: { isValid: true, payer: PAYER },
				settle: { success: true, transaction: 'ABCDEF', network: 'nano:mainnet', payer: PAYER },
			}),
		);
		expect(required).toHaveLength(0);
		expect(received).toHaveLength(1);
		const json = received[0].json as { statusCode: number; headers: Record<string, string>; request: { payment: { hasPayment: boolean } } };
		expect(json.statusCode).toBe(200);
		expect(json.headers['PAYMENT-RESPONSE']).toBeDefined();
		expect(json.request.payment.hasPayment).toBe(true);
	});

	it('emits the verified payment (unsettled) when auto-settle is off', async () => {
		const node = new X402NanoPaywall();
		DEFAULTS.autoSettle = false;
		try {
			const [required, received] = await node.execute.call(
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader() })], {
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
		let settleCalls = 0;
		const context = mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader() })], {
			verify: { isValid: false, invalidReason: 'invalid work' },
			blockInfo: {
				block_account: PAYER,
				amount: AMOUNT_RAW,
				subtype: 'send',
				contents: { link: '1'.repeat(64), link_as_account: MERCHANT },
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
				mockContext([withHeader({ 'payment-signature': encodeV2PaymentHeader() })], {
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
					withHeader({ 'payment-signature': encodeV2PaymentHeader() }),
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
});
