import { HEADER_V1_PAYMENT, HEADER_V2_PAYMENT } from './x402-codec';

/**
 * Classification of an incoming paywall request, computed by the X402 Nano
 * Trigger (v2) before the workflow runs. Classification only: header presence
 * and a light base64 shape check. Payment content is verified later by the
 * Verify Payment operation.
 */
export interface PaywallClassification {
	/** Whether a v1 (X-PAYMENT) or v2 (PAYMENT-SIGNATURE) payment header is present. */
	hasPayment: boolean;
	/** Detected protocol version: 'v2', 'v1' or '' when no payment header is present. */
	protocol: 'v2' | 'v1' | '';
	/** Canonical name of the detected header (PAYMENT-SIGNATURE / X-PAYMENT). */
	headerName: string;
	/** Trimmed raw header value (base64 JSON), or '' when absent. */
	headerValue: string;
	/**
	 * True when a payment header is present but its value is empty or does not
	 * look like base64. The client tried to pay but the header is unusable —
	 * route to a distinct 402 instead of offering a fresh (re)charge.
	 */
	headerInvalid: boolean;
}

/** Lowercase header keys and keep only string values. */
export function normalizeHeaderKeys(headers: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
		return result;
	}
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (typeof value === 'string') {
			result[key.toLowerCase()] = value;
		}
	}
	return result;
}

// Light base64 shape check (standard + url-safe alphabets). Deliberately does
// NOT decode: payload parsing and verification belong to Verify Payment.
const BASE64_SHAPE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function classifyPaywallRequest(headers: unknown): PaywallClassification {
	const normalized = normalizeHeaderKeys(headers);
	const v2 = normalized[HEADER_V2_PAYMENT.toLowerCase()];
	const v1 = normalized[HEADER_V1_PAYMENT.toLowerCase()];

	const hasPayment = v2 !== undefined || v1 !== undefined;
	const headerValue = (v2 ?? v1 ?? '').trim();
	const protocol = v2 !== undefined ? 'v2' : v1 !== undefined ? 'v1' : '';
	const headerName = v2 !== undefined ? HEADER_V2_PAYMENT : v1 !== undefined ? HEADER_V1_PAYMENT : '';
	const headerInvalid =
		hasPayment && (headerValue.length === 0 || !BASE64_SHAPE.test(headerValue));

	return { hasPayment, protocol, headerName, headerValue, headerInvalid };
}