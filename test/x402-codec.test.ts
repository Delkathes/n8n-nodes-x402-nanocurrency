import { describe, expect, it } from 'vitest';

import {
	buildPaymentPayloadV1,
	buildPaymentPayloadV2,
	buildPaymentRequiredV2,
	detectVersion,
	encodePaymentHeader,
	encodeSettlementHeader,
	extractBlockFromPayload,
	findExactNanoAccept,
	HEADER_V1_PAYMENT,
	HEADER_V1_PAYMENT_RESPONSE,
	HEADER_V2_PAYMENT,
	HEADER_V2_PAYMENT_REQUIRED,
	HEADER_V2_PAYMENT_RESPONSE,
	normalizeAcceptV1,
	normalizeAcceptV2,
	parsePaymentHeader,
	parsePaymentRequired,
	parseSettlementFromHeaders,
} from '../utils/x402-codec';
import type { NanoStateBlock } from '../utils/block';

const BURN_ACCOUNT = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const AMOUNT_RAW = '100000000000000000000000000000'; // 0.1 NANO

const SAMPLE_BLOCK: NanoStateBlock = {
	type: 'state',
	account: 'nano_1test',
	previous: 'A'.repeat(64),
	representative: 'nano_1test',
	balance: '900000000000000000000000000000',
	link: 'e89208dd038fbb269987689621d52292ae9c35941a7484756ecced92a65093ba',
	link_as_account: BURN_ACCOUNT,
	work: '2bf29ef00786a6bc',
	signature: 'B'.repeat(128),
};

describe('v1 requirements (body)', () => {
	const body = {
		x402Version: 1,
		accepts: [
			{
				scheme: 'exact',
				network: 'nano:mainnet',
				maxAmountRequired: AMOUNT_RAW,
				payTo: BURN_ACCOUNT,
				asset: 'XNO',
				extra: { paymentId: 'quote-123' },
			},
		],
	};

	it('detects v1 from the body', () => {
		expect(detectVersion({}, body)).toBe(1);
	});

	it('parses and normalizes the accept', () => {
		const requirements = parsePaymentRequired({}, body);
		expect(requirements).not.toBeNull();
		expect(requirements!.version).toBe(1);

		const accept = findExactNanoAccept(requirements!.accepts);
		expect(accept).toBeDefined();
		expect(accept!.amountRaw).toBe(AMOUNT_RAW);
		expect(accept!.payTo).toBe(BURN_ACCOUNT);
		expect(accept!.paymentId).toBe('quote-123');
	});

	it('normalizes maxAmountRequired to amountRaw', () => {
		const normalized = normalizeAcceptV1(body.accepts[0]);
		expect(normalized.amountRaw).toBe(AMOUNT_RAW);
	});
});

describe('v2 requirements (header)', () => {
	const required = {
		x402Version: 2,
		resource: { serviceName: 'Nano-GPT', description: 'chat' },
		accepts: [
			{
				scheme: 'exact',
				network: 'nano:mainnet',
				amount: AMOUNT_RAW,
				payTo: BURN_ACCOUNT,
				asset: 'XNO',
				extra: { paymentId: 'quote-456' },
			},
		],
	};
	const headerValue = Buffer.from(JSON.stringify(required)).toString('base64');

	it('detects v2 from the PAYMENT-REQUIRED header', () => {
		expect(detectVersion({ [HEADER_V2_PAYMENT_REQUIRED]: headerValue }, {})).toBe(2);
	});

	it('parses and normalizes the accept', () => {
		const requirements = parsePaymentRequired(
			{ [HEADER_V2_PAYMENT_REQUIRED]: headerValue },
			{},
		);
		expect(requirements).not.toBeNull();
		expect(requirements!.version).toBe(2);
		expect(requirements!.resource?.serviceName).toBe('Nano-GPT');

		const accept = findExactNanoAccept(requirements!.accepts);
		expect(accept).toBeDefined();
		expect(accept!.amountRaw).toBe(AMOUNT_RAW);
		expect(accept!.paymentId).toBe('quote-456');
	});

	it('normalizes amount to amountRaw', () => {
		const normalized = normalizeAcceptV2(required.accepts[0]);
		expect(normalized.amountRaw).toBe(AMOUNT_RAW);
	});

	it('builds a v2 PAYMENT-REQUIRED header', () => {
		const encoded = buildPaymentRequiredV2(required.accepts, required.resource);
		const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString());
		expect(decoded.x402Version).toBe(2);
		expect(decoded.accepts[0].amount).toBe(AMOUNT_RAW);
	});
});

describe('payment payloads', () => {
	it('encodes/parses a v1 X-PAYMENT payload with the block', () => {
		const payload = buildPaymentPayloadV1(SAMPLE_BLOCK, 'quote-123');
		const header = encodePaymentHeader(1, payload);
		expect(header.name).toBe(HEADER_V1_PAYMENT);

		const parsed = parsePaymentHeader(header.value);
		expect(parsed).not.toBeNull();
		expect(parsed!.version).toBe(1);
		expect(extractBlockFromPayload(parsed!.payload)?.signature).toBe(SAMPLE_BLOCK.signature);
	});

	it('encodes/parses a v2 PAYMENT-SIGNATURE payload with the accepted echo', () => {
		const accepted = {
			scheme: 'exact',
			network: 'nano:mainnet',
			amount: AMOUNT_RAW,
			payTo: BURN_ACCOUNT,
			extra: {},
		};
		const payload = buildPaymentPayloadV2(SAMPLE_BLOCK, accepted);
		const header = encodePaymentHeader(2, payload);
		expect(header.name).toBe(HEADER_V2_PAYMENT);

		const parsed = parsePaymentHeader(header.value);
		expect(parsed).not.toBeNull();
		expect(parsed!.version).toBe(2);
		const parsedPayload = parsed!.payload as typeof payload;
		expect(parsedPayload.accepted.amount).toBe(AMOUNT_RAW);
		expect(extractBlockFromPayload(parsed!.payload)?.work).toBe(SAMPLE_BLOCK.work);
	});

	it('rejects garbage header values', () => {
		expect(parsePaymentHeader('not-a-header')).toBeNull();
		expect(parsePaymentHeader(Buffer.from('{"nope": true}').toString('base64'))).toBeNull();
	});
});

describe('current NanoGPT v1 shape (nested payment.accepted)', () => {
	// Captured from a live probe of api.nano-gpt.com/v1/chat/completions
	// with the "x-x402: true" header (September 2026).
	const body = {
		error: {
			message: 'Insufficient balance. Payment required.',
			type: 'insufficient_quota',
			code: 'insufficient_quota',
		},
		payment: {
			version: 1,
			paymentId: 'pay_322ca44d0ffb9a83559798327960bb72',
			requestHash: 'sha256:cf659d7cfa048c8e0e32f4a3b8a84fb1e5fdfcd544066a933c121912ed76bc61',
			expiresAt: '2026-09-01T22:16:03.000Z',
			amountUsd: '0.00720984',
			statusUrl: 'https://beta.nano-gpt.com/api/x402/status/pay_322ca44d0ffb9a83559798327960bb72',
			completeUrl: 'https://beta.nano-gpt.com/api/x402/complete/pay_322ca44d0ffb9a83559798327960bb72',
			accepted: [
				{
					scheme: 'nano',
					protocolScheme: 'nano',
					network: 'nano-mainnet',
					amount: '18660030000000000000000000000',
					payTo: 'nano_17tuue5q97cunzj3pkjd9to661kzds9h7p35smfxcqfx7uaa4jgsqdcf7m8f',
					paymentId: 'pay_322ca44d0ffb9a83559798327960bb72',
				},
				{
					scheme: 'nano-exact',
					protocolScheme: 'exact',
					network: 'nano:mainnet',
					amount: '18660030000000000000000000000',
					amountFormatted: '0.01866003 XNO',
					payTo: 'nano_17tuue5q97cunzj3pkjd9to661kzds9h7p35smfxcqfx7uaa4jgsqdcf7m8f',
					paymentId: 'pay_322ca44d0ffb9a83559798327960bb72',
				},
			],
		},
	};

	it('detects v1 from the nested payment.accepted body', () => {
		expect(detectVersion({}, body)).toBe(1);
	});

	it('parses the nested requirements and picks the exact nano option', () => {
		const requirements = parsePaymentRequired({}, body);
		expect(requirements).not.toBeNull();
		expect(requirements!.version).toBe(1);
		expect(requirements!.accepts).toHaveLength(2);

		const accept = findExactNanoAccept(requirements!.accepts);
		expect(accept).toBeDefined();
		expect(accept!.scheme).toBe('exact');
		expect(accept!.network).toBe('nano:mainnet');
		expect(accept!.amountRaw).toBe('18660030000000000000000000000');
		expect(accept!.paymentId).toBe('pay_322ca44d0ffb9a83559798327960bb72');
	});

	it('does not pick the non-exact nano-mainnet option', () => {
		const requirements = parsePaymentRequired({}, body)!;
		const nonExact = requirements.accepts.find((accept) => accept.scheme === 'nano');
		expect(nonExact).toBeDefined();
		expect(findExactNanoAccept([nonExact!])).toBeUndefined();
	});
});

describe('settlement', () => {
	it('parses v1 and v2 settlement headers', () => {
		const settlement = {
			success: true,
			transaction: 'C'.repeat(64),
			network: 'nano:mainnet',
			payer: 'nano_1payer',
		};

		for (const version of [1, 2] as const) {
			const header = encodeSettlementHeader(version, settlement);
			const parsed = parseSettlementFromHeaders(
				{ [header.name]: header.value },
				version,
			);
			expect(parsed).not.toBeNull();
			expect(parsed!.success).toBe(true);
			expect(parsed!.transaction).toBe(settlement.transaction);
			expect(parsed!.payer).toBe('nano_1payer');
		}
	});

	it('uses the correct header names per version', () => {
		expect(encodeSettlementHeader(1, { success: true }).name).toBe(
			HEADER_V1_PAYMENT_RESPONSE,
		);
		expect(encodeSettlementHeader(2, { success: true }).name).toBe(
			HEADER_V2_PAYMENT_RESPONSE,
		);
	});

	it('returns null when the settlement header is absent', () => {
		expect(parseSettlementFromHeaders({}, 2)).toBeNull();
	});
});
