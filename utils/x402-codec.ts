/**
 * x402 v1/v2 wire-format codec (zero dependencies).
 *
 * The two protocol versions differ in carrier, envelope and field names:
 *
 * v1: 402 JSON body {accepts:[{..., maxAmountRequired, payTo}]};
 *     payment in the "X-PAYMENT" header;
 *     settlement in the "X-PAYMENT-RESPONSE" header.
 *
 * v2: 402 "PAYMENT-REQUIRED" header (base64 JSON, resource hoisted);
 *     payment in the "PAYMENT-SIGNATURE" header;
 *     settlement in the "PAYMENT-RESPONSE" header.
 *
 * The Nano block inside the payload is identical in both versions.
 */

import type { NanoStateBlock } from './block';

export type X402Version = 1 | 2;

export const HEADER_V1_PAYMENT = 'X-PAYMENT';
export const HEADER_V1_PAYMENT_RESPONSE = 'X-PAYMENT-RESPONSE';
export const HEADER_V2_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED';
export const HEADER_V2_PAYMENT = 'PAYMENT-SIGNATURE';
export const HEADER_V2_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE';

export const NANO_NETWORK = 'nano:mainnet';
export const EXACT_SCHEME = 'exact';

export interface ResourceInfo {
	url?: string;
	description?: string;
	mimeType?: string;
	serviceName?: string;
	tags?: string[];
}

/** Raw accept as it appears on the wire (v1).
 * The classic shape uses `maxAmountRequired`; the current NanoGPT API nests
 * accepts under `body.payment.accepted` and uses `amount` + `protocolScheme`
 * (`scheme: "nano-exact"` means the exact scheme).
 */
export interface AcceptV1 {
	scheme: string;
	network: string;
	maxAmountRequired?: string;
	amount?: string;
	payTo: string;
	asset?: string;
	resource?: string;
	description?: string;
	mimeType?: string;
	outputSchema?: unknown;
	maxTimeoutSeconds?: number;
	extra?: Record<string, unknown>;
	protocolScheme?: string;
	paymentId?: string;
	expiresAt?: string;
	statusUrl?: string;
	completeUrl?: string;
	amountUsd?: string;
	amountFormatted?: string;
	requestHash?: string;
}

/** Raw accept as it appears on the wire (v2). */
export interface AcceptV2 {
	scheme: string;
	network: string;
	amount: string;
	payTo: string;
	asset?: string;
	maxTimeoutSeconds?: number;
	extra?: Record<string, unknown>;
}

export interface PaymentRequiredV1 {
	x402Version?: number;
	error?: unknown;
	accepts: AcceptV1[];
}

export interface PaymentRequiredV2 {
	x402Version: 2;
	error?: string;
	resource?: ResourceInfo;
	accepts: AcceptV2[];
}

/** Version-agnostic accept, normalized from either wire format. */
export interface NormalizedAccept {
	scheme: string;
	network: string;
	amountRaw: string;
	payTo: string;
	asset?: string;
	resource?: string;
	description?: string;
	mimeType?: string;
	outputSchema?: unknown;
	maxTimeoutSeconds?: number;
	extra?: Record<string, unknown>;
	paymentId?: string;
	/** The accept exactly as it appeared on the wire, echoed back verbatim in
	 * the payment payload. x402 core resource servers deep-equal the echoed
	 * `accepted` against the advertised requirements, so every advertised
	 * field (e.g. maxTimeoutSeconds) must survive. */
	rawAccept?: Record<string, unknown>;
}

export interface NormalizedPaymentRequired {
	version: X402Version;
	error?: unknown;
	resource?: ResourceInfo;
	accepts: NormalizedAccept[];
}

export interface PaymentPayloadV1 {
	x402Version: 1;
	scheme: string;
	network: string;
	payload: Record<string, unknown>;
}

export interface PaymentPayloadV2 {
	x402Version: 2;
	scheme: string;
	network: string;
	accepted: AcceptV2;
	payload: Record<string, unknown>;
}

export interface NormalizedSettlement {
	success: boolean;
	transaction?: string;
	network?: string;
	payer?: string;
	paymentId?: string;
	errorReason?: string;
	errorMessage?: string;
	raw?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function encodeBase64Json(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64');
}

export function decodeBase64Json<T = unknown>(value: string): T | null {
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf-8'));
		return parsed as T;
	} catch {
		return null;
	}
}

export function tryParseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function getHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) {
		return undefined;
	}
	const exact = headers[name];
	if (typeof exact === 'string') {
		return exact;
	}
	const lower = headers[name.toLowerCase()];
	if (typeof lower === 'string') {
		return lower;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') {
			return value;
		}
	}
	return undefined;
}

/** Normalize a raw v1 accept into the version-agnostic shape. */
export function normalizeAcceptV1(accept: AcceptV1): NormalizedAccept {
	const extra: Record<string, unknown> = isRecord(accept.extra) ? { ...accept.extra } : {};
	for (const key of ['expiresAt', 'statusUrl', 'completeUrl', 'amountUsd', 'amountFormatted', 'requestHash'] as const) {
		if (typeof accept[key] === 'string') {
			extra[key] = accept[key];
		}
	}

	const scheme = accept.protocolScheme ?? (accept.scheme === 'nano-exact' ? 'exact' : accept.scheme);
	const amountRaw = accept.maxAmountRequired ?? accept.amount ?? '0';
	const paymentId =
		typeof accept.paymentId === 'string'
			? accept.paymentId
			: typeof extra.paymentId === 'string'
				? extra.paymentId
				: undefined;

	return {
		scheme,
		network: accept.network,
		amountRaw,
		payTo: accept.payTo,
		asset: accept.asset ?? 'XNO',
		resource: accept.resource,
		description: accept.description,
		mimeType: accept.mimeType,
		outputSchema: accept.outputSchema,
		maxTimeoutSeconds: accept.maxTimeoutSeconds,
		extra,
		...(paymentId ? { paymentId } : {}),
		rawAccept: { ...accept },
	};
}

/** Normalize a raw v2 accept into the version-agnostic shape. */
export function normalizeAcceptV2(accept: AcceptV2): NormalizedAccept {
	const extra = isRecord(accept.extra) ? accept.extra : {};
	return {
		scheme: accept.scheme,
		network: accept.network,
		amountRaw: accept.amount,
		payTo: accept.payTo,
		asset: accept.asset,
		maxTimeoutSeconds: accept.maxTimeoutSeconds,
		extra,
		...(typeof extra.paymentId === 'string' ? { paymentId: extra.paymentId } : {}),
		rawAccept: { ...accept },
	};
}

export function normalizeAccept(accept: unknown, version: X402Version): NormalizedAccept | null {
	if (!isRecord(accept)) {
		return null;
	}
	if (version === 2) {
		return normalizeAcceptV2(accept as unknown as AcceptV2);
	}
	return normalizeAcceptV1(accept as unknown as AcceptV1);
}

/** Find the exact + nano:mainnet accept option, if offered. */
export function findExactNanoAccept(accepts: NormalizedAccept[]): NormalizedAccept | undefined {
	return accepts.find((accept) => accept.scheme === EXACT_SCHEME && accept.network === NANO_NETWORK);
}

/**
 * Detect the x402 version of a 402 response from its headers and body.
 * Returns null when the response does not look like an x402 payment request.
 */
export function detectVersion(
	headers: Record<string, unknown> | undefined,
	body: unknown,
): X402Version | null {
	const v2Header = getHeader(headers, HEADER_V2_PAYMENT_REQUIRED);
	if (v2Header) {
		const decoded = decodeBase64Json<PaymentRequiredV2>(v2Header);
		if (decoded && decoded.x402Version === 2 && Array.isArray(decoded.accepts)) {
			return 2;
		}
	}

	if (isRecord(body)) {
		const accepts = body.accepts;
		if (Array.isArray(accepts) && accepts.length > 0) {
			return body.x402Version === 2 ? 2 : 1;
		}
		const payment = body.payment;
		if (isRecord(payment) && Array.isArray(payment.accepted) && payment.accepted.length > 0) {
			return payment.version === 2 ? 2 : 1;
		}
	}

	return null;
}

/**
 * Parse the payment requirements from a 402 response.
 * v2: PAYMENT-REQUIRED header (base64 JSON). v1: JSON body {accepts}.
 * Returns null when the response does not carry recognizable requirements.
 */
export function parsePaymentRequired(
	headers: Record<string, unknown> | undefined,
	body: unknown,
): NormalizedPaymentRequired | null {
	const v2Header = getHeader(headers, HEADER_V2_PAYMENT_REQUIRED);
	if (v2Header) {
		const decoded = decodeBase64Json<PaymentRequiredV2>(v2Header);
		if (decoded && decoded.x402Version === 2 && Array.isArray(decoded.accepts)) {
			return {
				version: 2,
				error: decoded.error,
				resource: decoded.resource,
				accepts: decoded.accepts
					.map((accept) => normalizeAccept(accept, 2))
					.filter((accept): accept is NormalizedAccept => accept !== null),
			};
		}
	}

	if (isRecord(body) && Array.isArray(body.accepts) && body.accepts.length > 0) {
		const version: X402Version = body.x402Version === 2 ? 2 : 1;
		return {
			version,
			error: body.error,
			accepts: body.accepts
				.map((accept) => normalizeAccept(accept, version))
				.filter((accept): accept is NormalizedAccept => accept !== null),
		};
	}

	// Current NanoGPT v1 shape: requirements nested under body.payment.accepted.
	if (isRecord(body) && isRecord(body.payment)) {
		const payment = body.payment;
		const accepted = payment.accepted;
		if (Array.isArray(accepted) && accepted.length > 0) {
			const version: X402Version = payment.version === 2 ? 2 : 1;
			const parentPaymentId = typeof payment.paymentId === 'string' ? payment.paymentId : undefined;
			return {
				version,
				error: isRecord(body.error) ? body.error : undefined,
				accepts: (accepted as unknown[])
					.map((accept) => {
						const normalized = normalizeAccept(accept, version);
						if (normalized && parentPaymentId && !normalized.paymentId) {
							normalized.paymentId = parentPaymentId;
						}
						return normalized;
					})
					.filter((accept): accept is NormalizedAccept => accept !== null),
			};
		}
	}

	return null;
}

/** Encode the v1 PAYMENT-REQUIRED body (JSON). */
export function buildPaymentRequiredV1(
	accepts: AcceptV1[],
	options: { error?: string } = {},
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		x402Version: 1,
		accepts,
	};
	if (options.error) {
		body.error = options.error;
	}
	return body;
}

/** Encode the v2 PAYMENT-REQUIRED header value (base64 JSON). */
export function buildPaymentRequiredV2(
	accepts: AcceptV2[],
	resource?: ResourceInfo,
	options: { error?: string } = {},
): string {
	const required: PaymentRequiredV2 = {
		x402Version: 2,
		accepts,
	};
	if (resource) {
		required.resource = resource;
	}
	if (options.error) {
		required.error = options.error;
	}
	return encodeBase64Json(required);
}

/** Build a v1 payment payload from a signed block. */
export function buildPaymentPayloadV1(
	block: NanoStateBlock,
	paymentId?: string,
): PaymentPayloadV1 {
	return {
		x402Version: 1,
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		payload: {
			...(paymentId ? { paymentId } : {}),
			block,
		},
	};
}

/** Build a v2 payment payload from a signed block and the accepted offer. */
export function buildPaymentPayloadV2(block: NanoStateBlock, accepted: AcceptV2): PaymentPayloadV2 {
	return {
		x402Version: 2,
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		accepted,
		payload: {
			block,
		},
	};
}

/** Encode a payment payload for the given version into its header value. */
export function encodePaymentHeader(
	version: X402Version,
	payload: PaymentPayloadV1 | PaymentPayloadV2,
): { name: string; value: string } {
	if (version === 2) {
		return { name: HEADER_V2_PAYMENT, value: encodeBase64Json(payload) };
	}
	return { name: HEADER_V1_PAYMENT, value: encodeBase64Json(payload) };
}

/** Parse a payment header value (X-PAYMENT or PAYMENT-SIGNATURE) into a payload. */
export function parsePaymentHeader(
	value: string,
): { version: X402Version; payload: PaymentPayloadV1 | PaymentPayloadV2 } | null {
	const decoded = decodeBase64Json(value);
	if (!isRecord(decoded)) {
		const plain = tryParseJson(value);
		if (!isRecord(plain)) {
			return null;
		}
		return parsePaymentHeaderObject(plain);
	}
	return parsePaymentHeaderObject(decoded);
}

function parsePaymentHeaderObject(
	decoded: Record<string, unknown>,
): { version: X402Version; payload: PaymentPayloadV1 | PaymentPayloadV2 } | null {
	if (decoded.x402Version === 2) {
		return { version: 2, payload: decoded as unknown as PaymentPayloadV2 };
	}
	if (decoded.x402Version === 1) {
		return { version: 1, payload: decoded as unknown as PaymentPayloadV1 };
	}
	return null;
}

/** Extract the Nano block from a payment payload of either version. */
export function extractBlockFromPayload(
	payload: PaymentPayloadV1 | PaymentPayloadV2,
): NanoStateBlock | null {
	const inner = payload.payload as Record<string, unknown>;
	if (!isRecord(inner)) {
		return null;
	}
	const block = inner.block;
	if (!isRecord(block) || block.type !== 'state') {
		return null;
	}
	return block as unknown as NanoStateBlock;
}

/** Parse a settlement header (X-PAYMENT-RESPONSE or PAYMENT-RESPONSE). */
export function parseSettlementHeader(value: string): NormalizedSettlement | null {
	const decoded = decodeBase64Json<unknown>(value) ?? tryParseJson(value);
	if (!isRecord(decoded)) {
		return null;
	}
	return {
		success: decoded.success === true,
		...(typeof decoded.transaction === 'string' ? { transaction: decoded.transaction } : {}),
		...(typeof decoded.hash === 'string' ? { transaction: decoded.hash } : {}),
		...(typeof decoded.network === 'string' ? { network: decoded.network } : {}),
		...(typeof decoded.payer === 'string' ? { payer: decoded.payer } : {}),
		...(typeof decoded.paymentId === 'string' ? { paymentId: decoded.paymentId } : {}),
		...(typeof decoded.errorReason === 'string' ? { errorReason: decoded.errorReason } : {}),
		...(typeof decoded.errorMessage === 'string' ? { errorMessage: decoded.errorMessage } : {}),
		raw: decoded,
	};
}

/** Read the settlement from a paid response's headers for the given version. */
export function parseSettlementFromHeaders(
	headers: Record<string, unknown> | undefined,
	version: X402Version,
): NormalizedSettlement | null {
	const headerName = version === 2 ? HEADER_V2_PAYMENT_RESPONSE : HEADER_V1_PAYMENT_RESPONSE;
	const value = getHeader(headers, headerName);
	if (!value) {
		return null;
	}
	return parseSettlementHeader(value);
}

/** Encode a settlement for the given version into a response header value. */
export function encodeSettlementHeader(version: X402Version, settlement: NormalizedSettlement): { name: string; value: string } {
	const value = encodeBase64Json({
		success: settlement.success,
		...(settlement.transaction ? { transaction: settlement.transaction } : {}),
		...(settlement.network ? { network: settlement.network } : {}),
		...(settlement.payer ? { payer: settlement.payer } : {}),
		...(settlement.paymentId ? { paymentId: settlement.paymentId } : {}),
		...(settlement.errorReason ? { errorReason: settlement.errorReason } : {}),
		...(settlement.errorMessage ? { errorMessage: settlement.errorMessage } : {}),
	});
	return {
		name: version === 2 ? HEADER_V2_PAYMENT_RESPONSE : HEADER_V1_PAYMENT_RESPONSE,
		value,
	};
}
