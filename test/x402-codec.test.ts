import { describe, expect, it } from 'vitest';

import {
	buildPaymentPayloadV1,
	buildPaymentPayloadV2,
	buildPaymentRequiredV2,
	decodeBase64Json,
	detectVersion,
	encodePaymentHeader,
	encodeSettlementHeader,
	extractBlockFromPayload,
	extractPaymentIdFromPayload,
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
import type { AcceptV1, AcceptV2 } from '../utils/x402-codec';
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

	it('canonicalizes numeric amounts without floating point rounding', () => {
		// The wire JSON may deliver amounts as numbers even though the typed
		// AcceptV1 declares strings — exercise the runtime tolerance.
		const numeric = normalizeAcceptV1({
			scheme: 'exact',
			network: 'nano:mainnet',
			maxAmountRequired: 42,
			payTo: BURN_ACCOUNT,
		} as unknown as AcceptV1);
		expect(numeric.amountRaw).toBe('42');
		expect(() =>
			normalizeAcceptV1({
				scheme: 'exact',
				network: 'nano:mainnet',
				maxAmountRequired: 1e30,
				payTo: BURN_ACCOUNT,
			} as unknown as AcceptV1),
		).toThrow();
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

	it('keeps the raw wire accept for the payment echo, including maxTimeoutSeconds', () => {
		const acceptWithTimeout = {
			scheme: 'exact',
			network: 'nano:mainnet',
			amount: AMOUNT_RAW,
			asset: 'XNO',
			payTo: BURN_ACCOUNT,
			maxTimeoutSeconds: 300,
			extra: {},
		};
		const normalized = normalizeAcceptV2(acceptWithTimeout);
		expect(normalized.maxTimeoutSeconds).toBe(300);
		expect(normalized.rawAccept).toEqual(acceptWithTimeout);
	});

	it('echoed rawAccept satisfies the x402 core strict requirement matching', () => {
		// Advertised accept captured from the x402nano.org demo endpoint.
		// @x402/core's paymentRequirementsMatchAccepted deep-equals the
		// advertised accept (minus extra) against the echoed accepted.
		const advertised = {
			scheme: 'exact',
			network: 'nano:mainnet',
			amount: '1000000000000000000000000',
			asset: 'XNO',
			payTo: 'nano_194dqhek3tjcridnq7x76h7n8xrp4gmfpggn4erinqn6nr8anhwggkjj9ree',
			maxTimeoutSeconds: 300,
			extra: {},
		};
		const headerValue = Buffer.from(
			JSON.stringify({ x402Version: 2, accepts: [advertised] }),
		).toString('base64');

		const requirements = parsePaymentRequired({ [HEADER_V2_PAYMENT_REQUIRED]: headerValue }, {});
		const accept = findExactNanoAccept(requirements!.accepts);
		expect(accept).toBeDefined();

		const requiredCore: Record<string, unknown> = { ...advertised };
		delete requiredCore.extra;
		const echoed = { ...(accept!.rawAccept as Record<string, unknown>) };
		delete echoed.extra;
		expect(echoed).toEqual(requiredCore);
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

describe('extractPaymentIdFromPayload', () => {
	it('reads the paymentId from a v1 payload', () => {
		const payload = buildPaymentPayloadV1(SAMPLE_BLOCK, 'quote-123');
		expect(extractPaymentIdFromPayload(payload)).toBe('quote-123');
	});

	it('reads the paymentId from a v2 accepted echo (top-level and extra)', () => {
		// Some servers echo the paymentId at the top of `accepted` even though
		// the typed AcceptV2 declares it under `extra` — exercise both.
		const topLevel = buildPaymentPayloadV2(SAMPLE_BLOCK, {
			scheme: 'exact',
			network: 'nano:mainnet',
			amount: AMOUNT_RAW,
			payTo: BURN_ACCOUNT,
			paymentId: 'quote-456',
		} as unknown as AcceptV2);
		expect(extractPaymentIdFromPayload(topLevel)).toBe('quote-456');

		const inExtra = buildPaymentPayloadV2(SAMPLE_BLOCK, {
			scheme: 'exact',
			network: 'nano:mainnet',
			amount: AMOUNT_RAW,
			payTo: BURN_ACCOUNT,
			extra: { paymentId: 'quote-789' },
		});
		expect(extractPaymentIdFromPayload(inExtra)).toBe('quote-789');
	});

	it('returns undefined when no paymentId is present', () => {
		expect(extractPaymentIdFromPayload(buildPaymentPayloadV1(SAMPLE_BLOCK))).toBeUndefined();
		expect(
			extractPaymentIdFromPayload(
				buildPaymentPayloadV2(SAMPLE_BLOCK, {
					scheme: 'exact',
					network: 'nano:mainnet',
					amount: AMOUNT_RAW,
					payTo: BURN_ACCOUNT,
					extra: {},
				}),
			),
		).toBeUndefined();
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

describe('base64url wire format', () => {
	const payload = { x402Version: 2, accepts: [{ scheme: 'exact' }] };

	it('emits unpadded base64url (no =, + or /)', () => {
		const value = buildPaymentRequiredV2(
			[{ scheme: 'exact', network: 'nano:mainnet', amount: AMOUNT_RAW, payTo: BURN_ACCOUNT }],
		);
		expect(value).not.toMatch(/[=+/]/);
		expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeBase64Json<{ x402Version: number }>(value)?.x402Version).toBe(2);
	});

	it('decodes standard padded, standard unpadded and url-safe padded forms', () => {
		const expected = JSON.stringify(payload);
		const std = Buffer.from(expected).toString('base64'); // padded standard
		const stdNoPad = std.replace(/=+$/, '');
		const urlSafe = Buffer.from(expected).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
		const urlSafePadded = urlSafe + '='.repeat((4 - (urlSafe.length % 4)) % 4);

		for (const form of [std, stdNoPad, urlSafePadded]) {
			expect(decodeBase64Json(form)).toEqual(payload);
		}
	});
});
