import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import type { NanoStateBlock } from '../utils/block';
import { buildSendBlock, signBlock, verifyBlock } from '../utils/block';
import { nanoToRaw, rawToNano } from '../utils/conversions';
import { derivePublicKey } from '../utils/ed25519-blake2b';
import { encodeNanoAddress } from '../utils/nano-address';
import {
	buildPaymentPayloadV2,
	buildPaymentRequiredV2,
	extractBlockFromPayload,
	HEADER_V2_PAYMENT,
	parsePaymentHeader,
} from '../utils/x402-codec';
import { X402Nano } from '../nodes/X402Nano/X402Nano.node';

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

/** A genuine, signed v2 payment header for AMOUNT_RAW -> MERCHANT from PAYER. */
function signedV2Header(): { value: string; block: NanoStateBlock } {
	const built = buildSendBlock({
		account: PAYER,
		previous: FRONTIER,
		representative: PAYER,
		balanceRaw: BALANCE_RAW,
		toAddress: MERCHANT,
		amountRaw: AMOUNT_RAW,
	});
	expect(built).not.toBeNull();
	const block: NanoStateBlock = {
		...built!.block,
		work: '2bf29ef00786a6bc',
		signature: signBlock(TEST_PRIVATE_KEY, built!.hash),
	};
	const payload = buildPaymentPayloadV2(block, {
		scheme: 'exact',
		network: 'nano:mainnet',
		amount: AMOUNT_RAW,
		payTo: MERCHANT,
		asset: 'XNO',
	});
	return { value: Buffer.from(JSON.stringify(payload)).toString('base64'), block };
}

function v2RequiredHeaderValue(): string {
	return buildPaymentRequiredV2(
		[
			{
				scheme: 'exact',
				network: 'nano:mainnet',
				amount: AMOUNT_RAW,
				payTo: MERCHANT,
				asset: 'XNO',
			},
		],
		undefined,
		{ error: 'Payment Required' },
	);
}

type RouteResponses = {
	httpRequest?: (
		options: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown },
	) => Promise<Record<string, unknown>>;
	rpc?: (options: { url?: string; body?: { action?: string } }) => Record<string, unknown> | undefined;
	verify?: Record<string, unknown>;
	settle?: Record<string, unknown>;
};

interface MockContextOptions {
	input?: INodeExecutionData[];
	params?: Record<string, unknown>;
	credential?: Record<string, unknown>;
	routes?: RouteResponses;
}

function mockContext(opts: MockContextOptions = {}): IExecuteFunctions {
	const { params = {}, credential = {}, routes = {} } = opts;
	const input = opts.input ?? [{ json: {} }];

	return {
		getInputData: () => input,
		getNode: () => ({ type: 'n8n-nodes-x402-nanocurrency.x402Nano' }),
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : (fallback ?? ''),
		getCredentials: async () => credential,
		helpers: {
			httpRequest: async (options: {
				method?: string;
				url?: string;
				headers?: Record<string, string>;
				body?: unknown;
			}) => {
				if (routes.httpRequest) {
					return routes.httpRequest(options);
				}
				return { statusCode: 200, headers: {}, body: '{}' };
			},
			httpRequestWithAuthentication: async (
				_credentialType: string,
				options: { url?: string; body?: { action?: string } },
			) => {
				if (options.body?.action) {
					const override = routes.rpc?.(options);
					if (override) return override;
					if (options.body.action === 'account_info')
						return { frontier: FRONTIER, balance: BALANCE_RAW, representative: PAYER };
					if (options.body.action === 'work_generate') return { work: '2bf29ef00786a6bc' };
					if (options.body.action === 'process') return { hash: 'F'.repeat(64) };
					return { error: `unexpected action ${options.body.action}` };
				}
				if (options.url?.includes('/verify')) return routes.verify ?? { isValid: false };
				if (options.url?.includes('/settle')) return routes.settle ?? { success: false };
				return {};
			},
		},
	} as unknown as IExecuteFunctions;
}

async function runNode(
	params: Record<string, unknown>,
	opts: Omit<MockContextOptions, 'params'> = {},
): Promise<INodeExecutionData[]> {
	const node = new X402Nano();
	const outputs = await node.execute.call(mockContext({ params, ...opts }));
	return outputs[0];
}

const RPC_CRED = { rpcUrl: 'https://rpc.nano.to', privateKey: TEST_PRIVATE_KEY.toString('hex') };
const FACIL_CRED = { facilitatorUrl: 'https://x402nano.org/facilitator' };
const FACIL_AND_RPC_CRED = { ...FACIL_CRED, ...RPC_CRED };

describe('X402 Nano client operations', () => {
	it('builds a signed v2 payment header (manual mode)', async () => {
		const [item] = await runNode(
			{
				resource: 'payment',
				operation: 'buildPaymentSignature',
				signatureRequirementsMode: 'manual',
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				signatureProtocolVersion: 'v2',
				work: '',
			},
			{ credential: RPC_CRED },
		);
		const json = item.json as {
			headerName: string;
			headerValue: string;
			block: NanoStateBlock;
			payTo: string;
			amountRaw: string;
			amountNano: string;
		};
		expect(json.headerName).toBe(HEADER_V2_PAYMENT);
		expect(json.payTo).toBe(MERCHANT);
		expect(json.amountRaw).toBe(AMOUNT_RAW);
		expect(json.amountNano).toBe(rawToNano(AMOUNT_RAW));
		expect(verifyBlock(json.block)).toBe(true);
		expect(json.block.link_as_account).toBe(MERCHANT);

		const parsed = parsePaymentHeader(json.headerValue);
		expect(parsed).not.toBeNull();
		expect(parsed!.version).toBe(2);
		expect(extractBlockFromPayload(parsed!.payload)?.account).toBe(PAYER);
	});

	it('builds a signed v1 payment header (manual mode)', async () => {
		const [item] = await runNode(
			{
				resource: 'payment',
				operation: 'buildPaymentSignature',
				signatureRequirementsMode: 'manual',
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				signatureProtocolVersion: 'v1',
				work: '',
			},
			{ credential: RPC_CRED },
		);
		const json = item.json as { headerName: string; block: NanoStateBlock };
		expect(json.headerName).toBe('X-PAYMENT');
		expect(verifyBlock(json.block)).toBe(true);
	});

	it('verifies a payment through the facilitator', async () => {
		const { value } = signedV2Header();
		const [item] = await runNode(
			{
				resource: 'payment',
				operation: 'verifyPayment',
				paymentSignature: value,
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				verificationMode: 'facilitator',
			},
			{
				credential: FACIL_CRED,
				routes: { verify: { isValid: true, payer: PAYER } },
			},
		);
		const json = item.json as { isValid: boolean; payer: string; amountRaw: string };
		expect(json.isValid).toBe(true);
		expect(json.payer).toBe(PAYER);
		expect(json.amountRaw).toBe(AMOUNT_RAW);
	});

	it('settles a payment through the facilitator', async () => {
		const { value } = signedV2Header();
		const [item] = await runNode(
			{
				resource: 'payment',
				operation: 'settlePayment',
				paymentSignature: value,
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				settleMode: 'facilitator',
			},
			{
				credential: FACIL_CRED,
				routes: {
					settle: { success: true, transaction: 'ABCDEF', network: 'nano:mainnet', payer: PAYER },
				},
			},
		);
		const json = item.json as { success: boolean; transaction: string; payer: string };
		expect(json.success).toBe(true);
		expect(json.transaction).toBe('ABCDEF');
		expect(json.payer).toBe(PAYER);
	});

	it('runs the full pay flow: probe -> 402 -> pay -> 200 + settlement', async () => {
		const required = v2RequiredHeaderValue();
		let call = 0;
		let sentPaymentHeader: string | undefined;
		const httpRequest = async (options: { method?: string; url?: string; headers?: Record<string, string> }) => {
			call += 1;
			expect(options.url).toBe('https://api.example.com/v1/resource');
			if (call === 1) {
				return {
					statusCode: 402,
					headers: { 'PAYMENT-REQUIRED': required },
					body: JSON.stringify({ error: 'Payment Required' }),
				};
			}
			sentPaymentHeader = options.headers?.[HEADER_V2_PAYMENT];
			return {
				statusCode: 200,
				headers: {
					'PAYMENT-RESPONSE': Buffer.from(
						JSON.stringify({
							success: true,
							transaction: 'F'.repeat(64),
							network: 'nano:mainnet',
							payer: PAYER,
						}),
					).toString('base64'),
				},
				body: JSON.stringify({ ok: true }),
			};
		};

		const [item] = await runNode(
			{
				resource: 'request',
				operation: 'pay',
				url: 'https://api.example.com/v1/resource',
				method: 'POST',
				bodyType: 'json',
				jsonBody: { prompt: 'hello' },
				requestHeaders: '{}',
				autoPay: true,
				protocolVersion: 'auto',
				timeout: 30000,
				work: '',
				sourceAccount: '',
			},
			{ credential: RPC_CRED, routes: { httpRequest } },
		);
		const json = item.json as { statusCode: number; payment: { success: boolean; transaction: string; amountRaw: string } };
		expect(call).toBe(2);
		expect(sentPaymentHeader).toBeDefined();
		expect(json.statusCode).toBe(200);
		expect(json.payment.success).toBe(true);
		expect(json.payment.transaction).toBe('F'.repeat(64));
		expect(json.payment.amountRaw).toBe(AMOUNT_RAW);
	});

	it('sends a literal JSON string body as a parsed object (jsonBody fix)', async () => {
		let sentBody: unknown;
		const httpRequest = async (options: { url?: string; body?: unknown }) => {
			sentBody = options.body;
			return { statusCode: 200, headers: {}, body: JSON.stringify({ ok: true }) };
		};
		await runNode(
			{
				resource: 'request',
				operation: 'probe',
				url: 'https://api.example.com/v1/resource',
				method: 'POST',
				bodyType: 'json',
				jsonBody: '{"prompt":"hello"}',
				requestHeaders: '{}',
				timeout: 30000,
			},
			{ credential: RPC_CRED, routes: { httpRequest } },
		);
		expect(sentBody).toEqual({ prompt: 'hello' });
	});

	it('probes and reports payment requirements (autoPay off keeps 402 info)', async () => {
		const required = v2RequiredHeaderValue();
		const [item] = await runNode(
			{
				resource: 'request',
				operation: 'pay',
				url: 'https://api.example.com/v1/resource',
				method: 'POST',
				bodyType: 'none',
				requestHeaders: '{}',
				autoPay: false,
				protocolVersion: 'auto',
				timeout: 30000,
			},
			{
				credential: RPC_CRED,
				routes: {
					httpRequest: async () => ({
						statusCode: 402,
						headers: { 'PAYMENT-REQUIRED': required },
						body: JSON.stringify({ error: 'Payment Required' }),
					}),
				},
			},
		);
		const json = item.json as { statusCode: number; paymentRequired?: { accepts?: Array<{ payTo: string }> } };
		expect(json.statusCode).toBe(402);
		expect(json.paymentRequired?.accepts?.[0]?.payTo).toBe(MERCHANT);
	});

	it('builds a dual-mode 402 response (both header + body)', async () => {
		const [item] = await runNode({
			resource: 'response',
			operation: 'build402Response',
			protocol: 'both',
			payTo: MERCHANT,
			amount: AMOUNT_NANO,
			paymentId: '',
			serviceName: 'demo',
			resourceDescription: '',
			resourceUrl: '',
			mimeType: 'application/json',
			tags: '',
			errorMessage: 'Payment Required',
			maxTimeoutSeconds: 0,
		});
		const json = item.json as {
			statusCode: number;
			headers: Record<string, string>;
			body: { error: string; accepts?: unknown[] };
		};
		expect(json.statusCode).toBe(402);
		expect(json.headers['PAYMENT-REQUIRED']).toBeDefined();
		expect(json.body.error).toBe('Payment Required');
		expect(Array.isArray(json.body.accepts)).toBe(true);
	});

	it('builds a settlement response envelope', async () => {
		const [item] = await runNode({
			resource: 'response',
			operation: 'buildPaymentResponse',
			responseProtocol: 'both',
			responseSuccess: true,
			responseTransaction: 'C'.repeat(64),
			responsePayer: PAYER,
			responsePaymentId: 'pay_1',
		});
		const json = item.json as { statusCode: number; headers: Record<string, string>; body: unknown };
		expect(json.statusCode).toBe(200);
		expect(json.headers['PAYMENT-RESPONSE']).toBeDefined();
		expect(json.headers['X-PAYMENT-RESPONSE']).toBeDefined();
	});

	it('surfaces an actionable error when the nano credential is missing', async () => {
		const node = new X402Nano();
		const context = mockContext({
			params: {
				resource: 'payment',
				operation: 'buildPaymentSignature',
				signatureRequirementsMode: 'manual',
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				signatureProtocolVersion: 'v2',
				work: '',
			},
			credential: {},
		});
		(context as { getCredentials: unknown }).getCredentials = async () => {
			throw new Error('credentials-not-found');
		};
		await expect(node.execute.call(context)).rejects.toThrow(/X402 Nano API/);
	});

	it('handles a settlement response that reports its hash (not transaction)', async () => {
		const { value } = signedV2Header();
		const [item] = await runNode(
			{
				resource: 'payment',
				operation: 'settlePayment',
				paymentSignature: value,
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				settleMode: 'facilitator',
			},
			{
				credential: FACIL_CRED,
				routes: { settle: { success: true, hash: 'F'.repeat(64) } },
			},
		);
		const json = item.json as { success: boolean; transaction?: string };
		expect(json.success).toBe(true);
		expect(json.transaction).toBe('F'.repeat(64));
	});

	it('refuses a facilitator settle when the on-chain block debits a different amount', async () => {
		const { value } = signedV2Header();
		const node = new X402Nano();
		const context = mockContext({
			params: {
				resource: 'payment',
				operation: 'settlePayment',
				paymentSignature: value,
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				settleMode: 'facilitator',
			},
			credential: FACIL_AND_RPC_CRED,
			routes: {
				rpc: (options) => {
					if (options.body?.action === 'block_info') {
						return {
							block_account: PAYER,
							amount: '1',
							subtype: 'send',
							contents: { link: 'x'.repeat(64), link_as_account: MERCHANT },
						};
					}
					return undefined;
				},
				settle: { success: true, transaction: 'F'.repeat(64) },
			},
		});
		let settleCalls = 0;
		const helpers = context.helpers as { httpRequestWithAuthentication: (...args: unknown[]) => Promise<unknown> };
		const orig = helpers.httpRequestWithAuthentication;
		helpers.httpRequestWithAuthentication = async (...args: unknown[]) => {
			const options = args[1] as { url?: string };
			if (options.url?.includes('/settle')) {
				settleCalls += 1;
				return { success: false, errorReason: 'should not be reached' };
			}
			return orig.call(context, ...args);
		};
		await expect(node.execute.call(context)).rejects.toThrow(/does not debit the required amount/);
		expect(settleCalls).toBe(0);
	});

	it('still settles through the facilitator when the on-chain guard is unreachable', async () => {
		const { value } = signedV2Header();
		const [item] = await runNode(
			{
				resource: 'payment',
				operation: 'settlePayment',
				paymentSignature: value,
				payTo: MERCHANT,
				amount: AMOUNT_NANO,
				settleMode: 'facilitator',
			},
			{
				credential: FACIL_AND_RPC_CRED,
				routes: {
					rpc: () => {
						throw new Error('network down');
					},
					settle: { success: true, transaction: 'ABCDEF', network: 'nano:mainnet', payer: PAYER },
				},
			},
		);
		const json = item.json as { success: boolean; transaction: string };
		expect(json.success).toBe(true);
		expect(json.transaction).toBe('ABCDEF');
	});
});