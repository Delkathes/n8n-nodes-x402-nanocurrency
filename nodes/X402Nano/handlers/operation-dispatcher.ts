 

import type { IDataObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { derivePublicKey } from '../../../utils/ed25519-blake2b';
import { decodeNanoAddress, encodeNanoAddress } from '../../../utils/nano-address';
import { buildSendBlock, signBlock, verifyBlock } from '../../../utils/block';
import type { NanoStateBlock } from '../../../utils/block';
import { isValidNanoAmount, nanoToRaw, rawToNano } from '../../../utils/conversions';
import { X402PaymentError } from '../../../utils/errors';
import {
	getFacilitatorConfig,
	facilitatorGetSupported,
	facilitatorSettle,
	facilitatorVerify,
} from '../../../utils/facilitator-client';
import {
	getNanoRpcConfig,
	getAccountInfo,
	generateWork,
	processBlock,
	signWithWallet,
} from '../../../utils/nano-rpc';
import {
	EXACT_SCHEME,
	NANO_NETWORK,
	buildPaymentPayloadV1,
	buildPaymentPayloadV2,
	buildPaymentRequiredV1,
	buildPaymentRequiredV2,
	detectVersion,
	encodePaymentHeader,
	encodeSettlementHeader,
	extractBlockFromPayload,
	findExactNanoAccept,
	parsePaymentHeader,
	parsePaymentRequired,
	parseSettlementFromHeaders,
} from '../../../utils/x402-codec';
import type {
	AcceptV1,
	AcceptV2,
	NormalizedAccept,
	NormalizedSettlement,
	PaymentPayloadV1,
	PaymentPayloadV2,
	ResourceInfo,
	X402Version,
} from '../../../utils/x402-codec';

// ─────────────────────────────────────────────────────────────────────────────
// Shared request helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RequestSpec {
	url: string;
	method: string;
	headers: Record<string, unknown>;
	bodyType: 'json' | 'raw' | 'none';
	jsonBody: unknown;
	rawBody: string;
	rawContentType: string;
	timeout: number;
}

function readRequestSpec(context: IExecuteFunctions, i: number): RequestSpec {
	const headersRaw = context.getNodeParameter('requestHeaders', i, '{}') as string;
	let headers: Record<string, unknown> = {};
	if (headersRaw && headersRaw.trim().length > 0) {
		try {
			headers = JSON.parse(headersRaw) as Record<string, unknown>;
		} catch {
			throw new NodeOperationError(context.getNode(), 'Headers must be a valid JSON object');
		}
	}

	const bodyType = context.getNodeParameter('bodyType', i, 'json') as string;
	let jsonBody: unknown;
	if (bodyType === 'json') {
		jsonBody = context.getNodeParameter('jsonBody', i, {}) as unknown;
	}

	return {
		url: context.getNodeParameter('url', i) as string,
		method: context.getNodeParameter('method', i, 'POST') as string,
		headers,
		bodyType: bodyType as RequestSpec['bodyType'],
		jsonBody,
		rawBody: context.getNodeParameter('rawBody', i, '') as string,
		rawContentType: context.getNodeParameter('rawContentType', i, 'text/plain') as string,
		timeout: context.getNodeParameter('timeout', i, 30000) as number,
	};
}

function buildHttpOptions(
	spec: RequestSpec,
	extraHeaders?: Record<string, string>,
): IHttpRequestOptions {
	const headers: Record<string, unknown> = { ...spec.headers, ...(extraHeaders ?? {}) };
	const options: Record<string, unknown> = {
		method: spec.method,
		url: spec.url,
		headers,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
		encoding: 'arraybuffer',
		timeout: spec.timeout,
	};

	if (spec.bodyType === 'json' && spec.jsonBody !== undefined) {
		options.body = spec.jsonBody;
		options.json = true;
	} else if (spec.bodyType === 'raw' && spec.rawBody.length > 0) {
		options.body = spec.rawBody;
		options.json = false;
		headers['Content-Type'] = spec.rawContentType || 'text/plain';
	}

	return options as unknown as IHttpRequestOptions;
}

interface RawHttpResponse {
	statusCode: number;
	headers: Record<string, unknown>;
	body: Buffer;
}

async function httpRaw(
	context: IExecuteFunctions,
	options: IHttpRequestOptions,
): Promise<RawHttpResponse> {
	const response = (await context.helpers.httpRequest(options)) as {
		statusCode: number;
		headers: Record<string, unknown>;
		body: Buffer | string;
	};
	return {
		statusCode: response.statusCode,
		headers: response.headers,
		body: Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? ''),
	};
}

function decodeResponseBody(response: RawHttpResponse): unknown {
	const contentType = String(response.headers['content-type'] ?? response.headers['Content-Type'] ?? '');
	const text = response.body.toString('utf-8');
	if (contentType.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

function normalizeHttpResponse(response: RawHttpResponse): IDataObject {
	const contentType = String(response.headers['content-type'] ?? response.headers['Content-Type'] ?? '');
	const isJson = contentType.includes('application/json');
	const body = decodeResponseBody(response);

	return {
		statusCode: response.statusCode,
		headers: response.headers,
		...(isJson || typeof body === 'object'
			? { json: body }
			: {
					body: response.body.toString('base64'),
					contentType: contentType || 'application/octet-stream',
				}),
	} as IDataObject;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment creation
// ─────────────────────────────────────────────────────────────────────────────

interface ExecutedPayment {
	headerName: string;
	headerValue: string;
	block: NanoStateBlock;
	account: string;
}

async function executePayment(
	context: IExecuteFunctions,
	i: number,
	accept: NormalizedAccept,
	version: X402Version,
): Promise<ExecutedPayment> {
	const credentials = await context.getCredentials('x402NanoApi');
	const config = getNanoRpcConfig(credentials);
	const privateKeyHex = ((credentials.privateKey as string) ?? '').trim();
	const walletId = ((credentials.walletId as string) ?? '').trim();
	const workOverride = context.getNodeParameter('work', i, '') as string;

	let account: string;
	if (privateKeyHex) {
		if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
			throw new NodeOperationError(
				context.getNode(),
				'The private key in the credentials must be a 64-character hex string',
			);
		}
		const publicKey = derivePublicKey(Buffer.from(privateKeyHex, 'hex'));
		account = encodeNanoAddress(publicKey) as string;
	} else {
		account = ((context.getNodeParameter('sourceAccount', i, '') as string) ||
			(credentials.sourceAccount as string) || '').trim();
		if (!account) {
			throw new NodeOperationError(
				context.getNode(),
				'Either a private key or a wallet ID + source account are required to pay. Configure the x402 Nano API credential.',
			);
		}
		if (!walletId) {
			throw new NodeOperationError(
				context.getNode(),
				'No wallet ID configured in the x402 Nano API credential and no private key provided',
			);
		}
	}

	const info = await getAccountInfo(context, config, account);

	const built = buildSendBlock({
		account,
		previous: info.frontier,
		representative: info.representative,
		balanceRaw: info.balance,
		toAddress: accept.payTo,
		amountRaw: accept.amountRaw,
	});
	if (!built) {
		throw new NodeOperationError(
			context.getNode(),
			`Cannot build the payment block: the ${account} balance (${info.balance} raw) may be below the required ${accept.amountRaw} raw, or an address is invalid`,
		);
	}

	const work = workOverride.trim() || (await generateWork(context, config, info.frontier));
	const signature = privateKeyHex
		? signBlock(Buffer.from(privateKeyHex, 'hex'), built.hash)
		: await signWithWallet(context, config, walletId, account, built.hash);

	const block: NanoStateBlock = { ...built.block, work, signature };

	const acceptV2: AcceptV2 = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		amount: accept.amountRaw,
		payTo: accept.payTo,
		...(accept.asset ? { asset: accept.asset } : {}),
		...(accept.extra ? { extra: accept.extra } : {}),
	};

	const payload: PaymentPayloadV1 | PaymentPayloadV2 =
		version === 2
			? buildPaymentPayloadV2(block, acceptV2)
			: buildPaymentPayloadV1(block, accept.paymentId);

	const header = encodePaymentHeader(version, payload);

	return { headerName: header.name, headerValue: header.value, block, account };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

async function handlePay(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const spec = readRequestSpec(context, i);
	const autoPay = context.getNodeParameter('autoPay', i, true) as boolean;
	const protocolVersion = context.getNodeParameter('protocolVersion', i, 'auto') as string;

	const first = await httpRaw(context, buildHttpOptions(spec));

	if (first.statusCode !== 402) {
		return normalizeHttpResponse(first);
	}

	const version =
		detectVersion(first.headers, decodeResponseBody(first)) ??
		(protocolVersion === 'v1' ? 1 : protocolVersion === 'v2' ? 2 : null);

	if (!version) {
		return { ...normalizeHttpResponse(first), payment: null };
	}

	const requirements = parsePaymentRequired(first.headers, decodeResponseBody(first));
	const accept = requirements ? findExactNanoAccept(requirements.accepts) : undefined;

	if (!requirements || !accept) {
		throw new NodeOperationError(
			context.getNode(),
			`The server responded with 402 but no exact nano:mainnet payment option${
				requirements
					? ` (offered: ${requirements.accepts.map((a) => `${a.scheme}/${a.network}`).join(', ')})`
					: ''
			}`,
		);
	}

	if (!autoPay) {
		return {
			...normalizeHttpResponse(first),
			statusCode: 402,
			paymentRequired: requirements,
			selectedAccept: {
				...accept,
				amountNano: rawToNano(accept.amountRaw),
			},
		};
	}

	const payment = await executePayment(context, i, accept, version);
	const paid = await httpRaw(
		context,
		buildHttpOptions(spec, { [payment.headerName]: payment.headerValue }),
	);

	const settlement = parseSettlementFromHeaders(paid.headers, version);
	const result = normalizeHttpResponse(paid);

	return {
		...result,
		payment: {
			protocolVersion: version,
			success: settlement ? settlement.success : (paid.statusCode ?? 0) < 400,
			...(settlement?.transaction ? { transaction: settlement.transaction } : {}),
			network: settlement?.network ?? accept.network,
			...(settlement?.payer ? { payer: settlement.payer } : { payer: payment.account }),
			amountRaw: accept.amountRaw,
			amountNano: rawToNano(accept.amountRaw),
			...(accept.paymentId ? { paymentId: accept.paymentId } : {}),
			...(settlement?.errorReason ? { errorReason: settlement.errorReason } : {}),
			...(settlement ? { settlement } : {}),
		},
	};
}

async function handleProbe(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const spec = readRequestSpec(context, i);
	const response = await httpRaw(context, buildHttpOptions(spec));
	const body = decodeResponseBody(response);
	const result = normalizeHttpResponse(response);

	if (response.statusCode !== 402) {
		return result;
	}

	const requirements = parsePaymentRequired(response.headers, body);
	if (!requirements) {
		return { ...result, isPaymentRequired: false };
	}

	return {
		...result,
		statusCode: 402,
		isPaymentRequired: true,
		protocolVersion: requirements.version,
		resource: requirements.resource,
		accepts: requirements.accepts.map((accept) => ({
			...accept,
			amountNano: rawToNano(accept.amountRaw),
		})),
	};
}

async function handleProbeUpstreamPrice(
	context: IExecuteFunctions,
	i: number,
): Promise<IDataObject> {
	const spec = readRequestSpec(context, i);
	const markupPercent = context.getNodeParameter('markupPercent', i, 0) as number;

	const response = await httpRaw(context, buildHttpOptions(spec));
	const body = decodeResponseBody(response);
	const result = normalizeHttpResponse(response);

	if (response.statusCode !== 402) {
		return { ...result, isPaymentRequired: false };
	}

	const requirements = parsePaymentRequired(response.headers, body);
	if (!requirements) {
		return { ...result, isPaymentRequired: false };
	}

	const markupMultiplier = BigInt(Math.max(0, Math.floor(markupPercent * 100)));
	const applyMarkup = (amountRaw: string): string =>
		((BigInt(amountRaw) * (10000n + markupMultiplier) + 9999n) / 10000n).toString();

	const accepts = requirements.accepts.map((accept) => {
		const markedUpRaw = applyMarkup(accept.amountRaw);
		return {
			...accept,
			amountRaw: markedUpRaw,
			amountNano: rawToNano(markedUpRaw),
		};
	});

	return {
		...result,
		statusCode: 402,
		isPaymentRequired: true,
		protocolVersion: requirements.version,
		resource: requirements.resource,
		markupPercent,
		accepts,
	};
}

async function handleBuildPaymentSignature(
	context: IExecuteFunctions,
	i: number,
): Promise<IDataObject> {
	const mode = context.getNodeParameter('signatureRequirementsMode', i, 'manual') as string;

	let payTo: string;
	let amountNano: string;
	let paymentId: string | undefined;
	let version: X402Version;

	if (mode === 'header') {
		const headerValue = context.getNodeParameter('paymentRequiredHeader', i) as string;
		if (!headerValue || headerValue.trim().length === 0) {
			throw new NodeOperationError(context.getNode(), 'PAYMENT-REQUIRED header value is required');
		}
		const requirements = parsePaymentRequired(
			{ [headerValue.startsWith('{') ? 'body' : 'PAYMENT-REQUIRED']: headerValue },
			undefined,
		);
		// Fall back to direct v2 header parsing when the value is the raw header.
		const direct = parseV2PaymentRequiredValue(headerValue);
		const accept = requirements
			? findExactNanoAccept(requirements.accepts)
			: direct
				? findExactNanoAccept(direct.accepts)
				: undefined;

		if (!accept || !requirements || !direct) {
			throw new NodeOperationError(
				context.getNode(),
				'The header does not contain a parseable x402 payment requirement with an exact nano:mainnet option',
			);
		}
		version = 2;
		payTo = accept.payTo;
		amountNano = rawToNano(accept.amountRaw);
		paymentId = accept.paymentId;
	} else {
		payTo = context.getNodeParameter('payTo', i) as string;
		amountNano = context.getNodeParameter('amount', i) as string;
		version =
			(context.getNodeParameter('signatureProtocolVersion', i, 'v2') as string) === 'v1' ? 1 : 2;
	}

	if (!isValidNanoAmount(amountNano)) {
		throw new NodeOperationError(
			context.getNode(),
			'Amount must be a positive decimal string with up to 30 decimal places (in NANO)',
		);
	}
	if (!/^(nano|xrb)_/.test(payTo)) {
		throw new NodeOperationError(context.getNode(), `Invalid payTo address: ${payTo}`);
	}

	const amountRaw = nanoToRaw(amountNano);
	const accept: NormalizedAccept = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		amountRaw,
		payTo,
		...(paymentId ? { paymentId } : {}),
	};

	const payment = await executePayment(context, i, accept, version);
	const parsedPayload = parsePaymentHeader(payment.headerValue);

	return {
		protocolVersion: version,
		headerName: payment.headerName,
		headerValue: payment.headerValue,
		payload: parsedPayload?.payload,
		block: payment.block,
		account: payment.account,
		payTo,
		amountRaw,
		amountNano: rawToNano(amountRaw),
	};
}

function parseV2PaymentRequiredValue(value: string): ReturnType<typeof parsePaymentRequired> {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{')) {
		return parsePaymentRequired({ 'PAYMENT-REQUIRED': trimmed }, undefined);
	}
	return null;
}

async function handleVerifyPayment(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const signatureValue = context.getNodeParameter('paymentSignature', i) as string;
	const payTo = context.getNodeParameter('payTo', i) as string;
	const amountNano = context.getNodeParameter('amount', i) as string;
	const mode = context.getNodeParameter('verificationMode', i, 'facilitator') as string;

	if (!isValidNanoAmount(amountNano)) {
		throw new NodeOperationError(
			context.getNode(),
			'Amount must be a positive decimal string with up to 30 decimal places (in NANO)',
		);
	}

	const parsed = parsePaymentHeader(signatureValue);
	if (!parsed) {
		throw new NodeOperationError(
			context.getNode(),
			'Invalid payment signature header: expected base64 JSON (PAYMENT-SIGNATURE or X-PAYMENT)',
		);
	}

	const block = extractBlockFromPayload(parsed.payload);
	if (!block) {
		throw new NodeOperationError(
			context.getNode(),
			'The payment payload does not contain a Nano state block',
		);
	}

	const amountRaw = nanoToRaw(amountNano);
	const requirements = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		amount: amountRaw,
		payTo,
	};

	if (mode === 'facilitator') {
		const credentials = await context.getCredentials('x402FacilitatorApi');
		const config = getFacilitatorConfig(credentials);
		const result = await facilitatorVerify(
			context,
			config,
			parsed.payload as unknown as Record<string, unknown>,
			requirements,
		);
		return {
			...result,
			protocolVersion: parsed.version,
			amountRaw,
			amountNano: rawToNano(amountRaw),
		} as IDataObject;
	}

	const nanoCredentials = await context.getCredentials('x402NanoApi');
	const nanoConfig = getNanoRpcConfig(nanoCredentials);

	const payToMatches = (block.link_as_account === payTo) || (block.link.toLowerCase() === (decodePayToHex(payTo) ?? '').toLowerCase());
	const signatureValid = verifyBlock(block);
	let balanceSufficient = false;
	try {
		const info = await getAccountInfo(context, nanoConfig, block.account);
		balanceSufficient = BigInt(info.balance) >= BigInt(amountRaw);
	} catch {
		balanceSufficient = false;
	}

	const isValid = payToMatches && signatureValid && balanceSufficient;
	const invalidReason = !isValid
		? [
				!payToMatches ? 'payTo does not match the block link' : '',
				!signatureValid ? 'block signature is invalid' : '',
				!balanceSufficient ? 'payer balance is insufficient' : '',
			]
				.filter(Boolean)
				.join(', ')
		: undefined;

	return {
		isValid,
		...(invalidReason ? { invalidReason } : {}),
		payer: block.account,
		protocolVersion: parsed.version,
		amountRaw,
		amountNano: rawToNano(amountRaw),
		checks: {
			payToMatches,
			signatureValid,
			balanceSufficient,
		},
	};
}

function decodePayToHex(address: string): string | null {
	const key = decodeNanoAddress(address);
	return key ? key.toString('hex') : null;
}

async function handleSettlePayment(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const signatureValue = context.getNodeParameter('paymentSignature', i) as string;
	const payTo = context.getNodeParameter('payTo', i) as string;
	const amountNano = context.getNodeParameter('amount', i) as string;
	const mode = context.getNodeParameter('settleMode', i, 'facilitator') as string;

	if (!isValidNanoAmount(amountNano)) {
		throw new NodeOperationError(
			context.getNode(),
			'Amount must be a positive decimal string with up to 30 decimal places (in NANO)',
		);
	}

	const parsed = parsePaymentHeader(signatureValue);
	if (!parsed) {
		throw new NodeOperationError(
			context.getNode(),
			'Invalid payment signature header: expected base64 JSON (PAYMENT-SIGNATURE or X-PAYMENT)',
		);
	}

	const block = extractBlockFromPayload(parsed.payload);
	if (!block) {
		throw new NodeOperationError(
			context.getNode(),
			'The payment payload does not contain a Nano state block',
		);
	}

	const amountRaw = nanoToRaw(amountNano);
	const requirements = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		amount: amountRaw,
		payTo,
	};

	if (mode === 'facilitator') {
		const credentials = await context.getCredentials('x402FacilitatorApi');
		const config = getFacilitatorConfig(credentials);
		const result = await facilitatorSettle(
			context,
			config,
			parsed.payload as unknown as Record<string, unknown>,
			requirements,
		);
		return {
			...result,
			protocolVersion: parsed.version,
			amountRaw,
			amountNano: rawToNano(amountRaw),
		} as IDataObject;
	}

	const nanoCredentials = await context.getCredentials('x402NanoApi');
	const nanoConfig = getNanoRpcConfig(nanoCredentials);
	const transaction = await processBlock(context, nanoConfig, block as unknown as Record<string, unknown>);

	return {
		success: true,
		transaction,
		network: NANO_NETWORK,
		payer: block.account,
		protocolVersion: parsed.version,
		amountRaw,
		amountNano: rawToNano(amountRaw),
	};
}

async function handleSupported(context: IExecuteFunctions): Promise<IDataObject> {
	const credentials = await context.getCredentials('x402FacilitatorApi');
	const config = getFacilitatorConfig(credentials);
	const result = await facilitatorGetSupported(context, config);
	return { ...(result as IDataObject), facilitatorUrl: config.baseUrl };
}

async function handleBuild402Response(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const protocol = context.getNodeParameter('protocol', i, 'both') as string;
	const payTo = context.getNodeParameter('payTo', i) as string;
	const amountNano = context.getNodeParameter('amount', i) as string;
	const paymentId = context.getNodeParameter('paymentId', i, '') as string;
	const serviceName = context.getNodeParameter('serviceName', i, '') as string;
	const resourceDescription = context.getNodeParameter('resourceDescription', i, '') as string;
	const resourceUrl = context.getNodeParameter('resourceUrl', i, '') as string;
	const mimeType = context.getNodeParameter('mimeType', i, 'application/json') as string;
	const tags = context.getNodeParameter('tags', i, '') as string;
	const errorMessage = context.getNodeParameter('errorMessage', i, '') as string;

	if (!isValidNanoAmount(amountNano)) {
		throw new NodeOperationError(
			context.getNode(),
			'Amount must be a positive decimal string with up to 30 decimal places (in NANO)',
		);
	}

	const resource: ResourceInfo | undefined =
		serviceName || resourceDescription || resourceUrl
			? {
					...(resourceUrl ? { url: resourceUrl } : {}),
					...(resourceDescription ? { description: resourceDescription } : {}),
					...(mimeType ? { mimeType } : {}),
					...(serviceName ? { serviceName } : {}),
					...(tags
						? { tags: tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0) }
						: {}),
				}
			: undefined;

	return buildPaymentRequiredResponse({
		protocol: protocol as 'v1' | 'v2' | 'both',
		payTo,
		amountNano,
		resource,
		...(paymentId ? { paymentId } : {}),
		...(errorMessage ? { error: errorMessage } : {}),
	});
}

async function handleBuildPaymentResponse(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const protocol = context.getNodeParameter('responseProtocol', i, 'both') as string;
	const success = context.getNodeParameter('responseSuccess', i, true) as boolean;
	const transaction = context.getNodeParameter('responseTransaction', i, '') as string;
	const payer = context.getNodeParameter('responsePayer', i, '') as string;
	const paymentId = context.getNodeParameter('responsePaymentId', i, '') as string;

	const settlement: NormalizedSettlement = {
		success,
		...(transaction ? { transaction } : {}),
		network: NANO_NETWORK,
		...(payer ? { payer } : {}),
		...(paymentId ? { paymentId } : {}),
	};

	const headers: Record<string, string> = {};
	if (protocol === 'v2' || protocol === 'both') {
		const header = encodeSettlementHeader(2, settlement);
		headers[header.name] = header.value;
	}
	if (protocol === 'v1' || protocol === 'both') {
		const header = encodeSettlementHeader(1, settlement);
		headers[header.name] = header.value;
	}

	return {
		statusCode: 200,
		headers,
		body: {},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 402 / settlement response builders (used by the trigger workflow)
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchX402Operation(params: {
	executeFunctions: IExecuteFunctions;
	resource: string;
	operation: string;
	itemIndex: number;
}): Promise<IDataObject> {
	const { executeFunctions: context, resource, operation, itemIndex: i } = params;

	try {
		if (resource === 'request') {
			if (operation === 'pay') {
				return await handlePay(context, i);
			}
			return await handleProbe(context, i);
		}

		if (resource === 'response') {
			if (operation === 'build402Response') {
				return await handleBuild402Response(context, i);
			}
			return await handleBuildPaymentResponse(context, i);
		}

		switch (operation) {
			case 'buildPaymentSignature':
				return await handleBuildPaymentSignature(context, i);
			case 'verifyPayment':
				return await handleVerifyPayment(context, i);
			case 'settlePayment':
				return await handleSettlePayment(context, i);
			case 'supported':
				return await handleSupported(context);
			case 'probeUpstreamPrice':
				return await handleProbeUpstreamPrice(context, i);
			default:
				throw new NodeOperationError(context.getNode(), `Unknown operation: ${operation}`);
		}
	} catch (error) {
		if (error instanceof X402PaymentError) {
			throw new NodeOperationError(context.getNode(), error.message, {
				itemIndex: i,
				...(error.statusCode ? { description: `HTTP ${error.statusCode}` } : {}),
			});
		}
		if (error instanceof NodeOperationError) {
			throw new NodeOperationError(context.getNode(), error, { itemIndex: i });
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new NodeOperationError(context.getNode(), `x402 operation failed: ${message}`, {
			itemIndex: i,
		});
	}
}

/**
 * Build a 402 response description for a Respond to Webhook node:
 * statusCode 402, PAYMENT-REQUIRED header (v2) and/or v1 accepts body,
 * depending on the requested protocol mode.
 */
export function buildPaymentRequiredResponse(params: {
	protocol: 'v1' | 'v2' | 'both';
	payTo: string;
	amountNano: string;
	resource?: ResourceInfo;
	paymentId?: string;
	error?: string;
}): IDataObject {
	const amountRaw = nanoToRaw(params.amountNano);
	const extra: Record<string, unknown> = params.paymentId ? { paymentId: params.paymentId } : {};

	const acceptV1: AcceptV1 = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		maxAmountRequired: amountRaw,
		payTo: params.payTo,
		asset: 'XNO',
		extra,
	};

	const acceptV2: AcceptV2 = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		amount: amountRaw,
		payTo: params.payTo,
		asset: 'XNO',
		extra,
	};

	const response: IDataObject = {
		statusCode: 402,
		body: params.protocol === 'v2' ? { error: params.error ?? 'Payment Required' } : undefined,
		headers: {},
	};

	if (params.protocol === 'v2' || params.protocol === 'both') {
		(response.headers as Record<string, string>)['PAYMENT-REQUIRED'] = buildPaymentRequiredV2(
			[acceptV2],
			params.resource,
			{ error: params.error },
		);
		response.body = { error: params.error ?? 'Payment Required' };
	}
	if (params.protocol === 'v1' || params.protocol === 'both') {
		response.body = {
			...(typeof response.body === 'object' ? response.body : {}),
			...buildPaymentRequiredV1([acceptV1], { error: params.error }),
		};
	}

	return response;
}
