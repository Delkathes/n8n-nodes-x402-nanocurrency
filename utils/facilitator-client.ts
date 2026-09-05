/**
 * x402 facilitator client (zero dependencies).
 * Talks to the /supported, /verify and /settle endpoints exposed by
 * x402-nano-facilitator-compatible services. Auth goes through the
 * "x402 Facilitator API" credential.
 */

import type { IExecuteFunctions, ICredentialDataDecryptedObject } from 'n8n-workflow';

import { X402PaymentError } from './errors';
import type { NormalizedSettlement } from './x402-codec';

export interface FacilitatorConfig {
	baseUrl: string;
	timeoutMs: number;
}

export function getFacilitatorConfig(credentials: ICredentialDataDecryptedObject): FacilitatorConfig {
	const raw = typeof credentials.facilitatorUrl === 'string' ? credentials.facilitatorUrl.trim() : '';
	if (!raw) {
		throw new X402PaymentError(
			'The X402 Facilitator API credential has no URL configured. Set the "Facilitator URL" field on the credential.',
		);
	}
	const baseUrl = raw.replace(/\/+$/, '');
	return { baseUrl, timeoutMs: 30000 };
}

export async function facilitatorGetSupported(
	context: IExecuteFunctions,
	config: FacilitatorConfig,
): Promise<Record<string, unknown>> {
	return (await context.helpers.httpRequestWithAuthentication.call(
		context,
		'x402FacilitatorApi',
		{
			method: 'GET',
			url: `${config.baseUrl}/supported`,
			json: true,
			timeout: config.timeoutMs,
		},
	)) as Record<string, unknown>;
}

export interface FacilitatorVerifyResponse {
	isValid: boolean;
	invalidReason?: string;
	payer?: string;
	[key: string]: unknown;
}

export async function facilitatorVerify(
	context: IExecuteFunctions,
	config: FacilitatorConfig,
	paymentPayload: Record<string, unknown>,
	paymentRequirements: Record<string, unknown>,
): Promise<FacilitatorVerifyResponse> {
	return (await context.helpers.httpRequestWithAuthentication.call(
		context,
		'x402FacilitatorApi',
		{
			method: 'POST',
			url: `${config.baseUrl}/verify`,
			body: { paymentPayload, paymentRequirements },
			json: true,
			timeout: config.timeoutMs,
		},
	)) as FacilitatorVerifyResponse;
}

export async function facilitatorSettle(
	context: IExecuteFunctions,
	config: FacilitatorConfig,
	paymentPayload: Record<string, unknown>,
	paymentRequirements: Record<string, unknown>,
): Promise<NormalizedSettlement> {
	const response = (await context.helpers.httpRequestWithAuthentication.call(
		context,
		'x402FacilitatorApi',
		{
			method: 'POST',
			url: `${config.baseUrl}/settle`,
			body: { paymentPayload, paymentRequirements },
			json: true,
			timeout: config.timeoutMs,
		},
	)) as Record<string, unknown>;

	return {
		success: response.success === true,
		...(typeof response.transaction === 'string'
			? { transaction: response.transaction }
			: typeof response.hash === 'string'
				? { transaction: response.hash }
				: {}),
		...(typeof response.network === 'string' ? { network: response.network } : {}),
		...(typeof response.payer === 'string' ? { payer: response.payer } : {}),
		...(typeof response.errorReason === 'string' ? { errorReason: response.errorReason } : {}),
		...(typeof response.errorMessage === 'string' ? { errorMessage: response.errorMessage } : {}),
	};
}
