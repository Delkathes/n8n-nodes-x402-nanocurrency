 

import type { IDataObject, ICredentialDataDecryptedObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { derivePublicKey } from '../../../utils/ed25519-blake2b';
import { decodeNanoAddress, encodeNanoAddress } from '../../../utils/nano-address';
import {
	buildSendBlock,
	buildReceiveBlock,
	computeStateBlockHash,
	resolveReceiveWorkRoot,
	signBlock,
	verifyBlock,
} from '../../../utils/block';
import type { NanoStateBlock } from '../../../utils/block';
import { isValidNanoAmount, nanoToRaw, rawToNano } from '../../../utils/conversions';
import { X402PaymentError } from '../../../utils/errors';
import { coerceJsonBody, normalizeRequestHeaders } from '../../../utils/request-headers';
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
	getPendingBlocks,
	validateWork,
	getBlockInfo,
	RECEIVE_WORK_DIFFICULTY,
} from '../../../utils/nano-rpc';
import {
	EXACT_SCHEME,
	NANO_NETWORK,
	HEADER_V1_PAYMENT,
	HEADER_V2_PAYMENT_REQUIRED,
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

/**
 * Resolve a credential with an actionable message. Optional credential types
 * otherwise surface n8n's generic "no credentials found" error, which does not
 * tell the user which credential the node needs and why.
 */
async function requireCredentials(
	context: IExecuteFunctions,
	credentialName: 'x402NanoApi' | 'x402FacilitatorApi',
	usage: string,
): Promise<ICredentialDataDecryptedObject> {
	try {
		return await context.getCredentials(credentialName);
	} catch {
		const label =
			credentialName === 'x402NanoApi' ? 'X402 Nano API (Nano RPC)' : 'X402 Facilitator API';
		throw new NodeOperationError(
			context.getNode(),
			`The ${label} credential is required for ${usage}. Assign it on the node and make sure its URL field is set.`,
		);
	}
}

/** Parse a raw-unit string into BigInt, or null when it is not a digit string. */
function parseRawBigInt(value: unknown): bigint | null {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) {
		return null;
	}
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function readRequestSpec(context: IExecuteFunctions, i: number): RequestSpec {
	const headersParam = context.getNodeParameter('requestHeaders', i, '{}') as unknown;
	const normalized = normalizeRequestHeaders(headersParam);
	if (normalized.error) {
		throw new NodeOperationError(context.getNode(), normalized.error.message);
	}
	const headers = normalized.headers;

	const bodyType = context.getNodeParameter('bodyType', i, 'json') as string;
	let jsonBody: unknown;
	if (bodyType === 'json') {
		const coerced = coerceJsonBody(context.getNodeParameter('jsonBody', i, {}) as unknown);
		if (coerced.error) {
			throw new NodeOperationError(context.getNode(), coerced.error.message);
		}
		jsonBody = coerced.value;
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
		body: unknown;
	};
	return {
		statusCode: response.statusCode,
		headers: response.headers,
		body: toBufferBody(response.body),
	};
}

function toBufferBody(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) {
		return body;
	}
	if (typeof body === 'string') {
		return Buffer.from(body, 'utf-8');
	}
	if (body !== undefined && body !== null) {
		// The HTTP layer already parsed a JSON body (some n8n/Node versions
		// auto-parse despite `encoding: arraybuffer`): reserialize it so the
		// response decoder below sees the original text.
		return Buffer.from(JSON.stringify(body), 'utf-8');
	}
	return Buffer.alloc(0);
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
	const credentials = await requireCredentials(context, 'x402NanoApi', 'signing and sending payments');
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

	const block: NanoStateBlock = {
		...built.block,
		work: work.toUpperCase(),
		signature: signature.toUpperCase(),
	};

	// Echo the wire accept verbatim when available: x402 core resource servers
	// deep-equal the echoed `accepted` against their advertised requirements,
	// so every advertised field (scheme, network, amount, asset, payTo,
	// maxTimeoutSeconds, extra, …) must survive into the payment payload.
	// Reconstructing a reduced copy (dropping e.g. maxTimeoutSeconds) makes the
	// server answer 402 "No matching payment requirements".
	const acceptV2: AcceptV2 = accept.rawAccept
		? (accept.rawAccept as unknown as AcceptV2)
		: {
				scheme: EXACT_SCHEME,
				network: NANO_NETWORK,
				amount: accept.amountRaw,
				payTo: accept.payTo,
				...(accept.asset ? { asset: accept.asset } : {}),
				...(accept.maxTimeoutSeconds !== undefined
					? { maxTimeoutSeconds: accept.maxTimeoutSeconds }
					: {}),
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

	try {
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
	} catch (error) {
		// The payment was already sent and settled on the ledger; never turn a
		// response-mapping failure into a node error here, or a manual re-run
		// would pay a second time. Surface the paid response with a warning.
		return {
			...result,
			payment: {
				protocolVersion: version,
				success: true,
				amountRaw: accept.amountRaw,
				warning: `Payment was sent, but the response could not be parsed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			},
		};
	}
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

/**
 * Send a request with an existing payment header (built by the
 * Build Payment Signature operation) and return the paid response.
 * Completes the manual payment flow: probe -> build signature ->
 * send with payment header -> settle (optionally) -> content.
 */
async function handleSendWithPayment(
	context: IExecuteFunctions,
	i: number,
): Promise<IDataObject> {
	const spec = readRequestSpec(context, i);
	const headerName = context.getNodeParameter('paymentHeaderName', i, 'PAYMENT-SIGNATURE') as string;
	const headerValue = context.getNodeParameter('paymentHeaderValue', i) as string;
	if (!headerValue || headerValue.trim().length === 0) {
		throw new NodeOperationError(
			context.getNode(),
			'Payment header value is required (use Build Payment Signature to create it)',
		);
	}

	const version: X402Version = headerName === HEADER_V1_PAYMENT ? 1 : 2;
	const response = await httpRaw(context, buildHttpOptions(spec, { [headerName]: headerValue }));
	const settlement = parseSettlementFromHeaders(response.headers, version);
	const result = normalizeHttpResponse(response);

	return {
		...result,
		payment: {
			protocolVersion: version,
			success: settlement ? settlement.success : (response.statusCode ?? 0) < 400,
			...(settlement?.transaction ? { transaction: settlement.transaction } : {}),
			...(settlement?.network ? { network: settlement.network } : {}),
			...(settlement?.payer ? { payer: settlement.payer } : {}),
			...(settlement?.errorReason ? { errorReason: settlement.errorReason } : {}),
			...(settlement ? { settlement } : {}),
		},
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

	let parsedAccept: NormalizedAccept | undefined;

	if (mode === 'header') {
		const headerValue = context.getNodeParameter('paymentRequiredHeader', i) as string;
		if (!headerValue || headerValue.trim().length === 0) {
			throw new NodeOperationError(context.getNode(), 'PAYMENT-REQUIRED header value is required');
		}
		const trimmed = headerValue.trim();
		const isJsonBody = trimmed.startsWith('{');
		const requirements = parsePaymentRequired(
			isJsonBody ? undefined : { [HEADER_V2_PAYMENT_REQUIRED]: trimmed },
			isJsonBody ? trimmed : undefined,
		);
		if (!requirements) {
			throw new NodeOperationError(
				context.getNode(),
				'The header does not contain a parseable x402 payment requirement (expected a PAYMENT-REQUIRED header value or a requirements JSON object)',
			);
		}
		parsedAccept = findExactNanoAccept(requirements.accepts);
		if (!parsedAccept) {
			throw new NodeOperationError(
				context.getNode(),
				'The payment requirements do not contain an exact nano:mainnet option',
			);
		}
		version = requirements.version;
		payTo = parsedAccept.payTo;
		amountNano = rawToNano(parsedAccept.amountRaw);
		paymentId = parsedAccept.paymentId;
	} else {
		payTo = String(context.getNodeParameter('payTo', i));
		amountNano = String(context.getNodeParameter('amount', i));
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

	// Header mode: keep the parsed wire accept (including rawAccept) so the
	// payment payload echoes the requirements verbatim. x402 core resource
	// servers deep-equal `accepted` against their advertised requirements and
	// answer 402 "No matching payment requirements" when fields such as asset,
	// maxTimeoutSeconds or extra are dropped by a reduced reconstruction.
	const amountRaw = parsedAccept ? parsedAccept.amountRaw : nanoToRaw(amountNano);
	const accept: NormalizedAccept =
		parsedAccept ??
		{
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

export interface VerifyPaymentInput {
	signatureValue: string;
	payTo: string;
	amountNano: string;
	mode: 'facilitator' | 'local';
}

export async function runPaymentVerification(
	context: IExecuteFunctions,
	input: VerifyPaymentInput,
): Promise<IDataObject> {
	const { signatureValue, payTo, amountNano, mode } = input;

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
		const credentials = await requireCredentials(context, 'x402FacilitatorApi', 'verifying payments');
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

	const nanoCredentials = await requireCredentials(context, 'x402NanoApi', 'verifying payments locally');
	const nanoConfig = getNanoRpcConfig(nanoCredentials);

	const payToMatches =
		block.link_as_account === payTo ||
		block.link.toLowerCase() === (decodePayToHex(payTo) ?? '').toLowerCase();
	const computedHash = computeStateBlockHash(block);
	const signatureValid = computedHash
		? verifyBlock(block, computedHash.toString('hex'))
		: false;

	let balanceSufficient = false;
	let frontierMatches = false;
	let confirmedFrontierMatches = false;
	let debitMatches = false;
	let debitInvalid = false;
	try {
		const info = await getAccountInfo(context, nanoConfig, block.account, {
			includeConfirmed: true,
		});
		balanceSufficient = BigInt(info.balance) >= BigInt(amountRaw);
		frontierMatches = info.frontier.toLowerCase() === block.previous.toLowerCase();
		if (info.confirmedFrontier) {
			confirmedFrontierMatches =
				info.confirmedFrontier.toLowerCase() === block.previous.toLowerCase();
		}
		// Authoritative amount check: the signed block must debit exactly the
		// required amount from the payer's current (frontier) balance.
		const balanceBefore = parseRawBigInt(info.balance);
		const balanceAfter = parseRawBigInt(block.balance);
		if (balanceBefore !== null && balanceAfter !== null) {
			debitInvalid = balanceAfter > balanceBefore;
			debitMatches = !debitInvalid && balanceBefore - balanceAfter === BigInt(amountRaw);
		}
	} catch (error) {
		if (error instanceof X402PaymentError) {
			// The RPC answered (e.g. "Account not found"): the payment cannot be
			// validated against the payer state -> genuinely invalid, not infra.
			balanceSufficient = false;
		} else {
			// Network/timeout/transport failure: surface it so a transient outage
			// cannot masquerade as "payment invalid" (which would 402 a valid
			// payment and make the client pay again).
			throw new NodeOperationError(
				context.getNode(),
				error instanceof Error ? error : new Error(String(error)),
				{
					description:
						'The Nano RPC could not be reached while verifying the payment. The payment was not rejected — retry the same signature.',
				},
			);
		}
	}

	let workValid = false;
	try {
		workValid = await validateWork(context, nanoConfig, block.previous, block.work);
	} catch (error) {
		if (error instanceof X402PaymentError) {
			workValid = false;
		} else {
			throw new NodeOperationError(
				context.getNode(),
				error instanceof Error ? error : new Error(String(error)),
				{
					description:
						'The Nano RPC could not be reached while validating the block proof of work. The payment was not rejected — retry the same signature.',
				},
			);
		}
	}

	// Replay detection + idempotent replay matching. When the payment block is
	// already on-chain, re-running the strict checks fails (the payer frontier
	// has moved on). Instead of rejecting the request — which would make the
	// client pay AGAIN with a fresh block — treat the replayed payment as valid
	// when it demonstrably paid for these exact requirements.
	const replay = await detectOnChainReplay(context, block, amountRaw, payTo);
	const replayed = replay.replayed;
	const replayMatched = replay.matched;

	const isValid = replayed
		? replayMatched
		: payToMatches &&
			signatureValid &&
			balanceSufficient &&
			debitMatches &&
			workValid &&
			frontierMatches &&
			confirmedFrontierMatches;
	const invalidReason = !isValid
		? replayed
			? ['payment block was already processed and does not match these requirements (replay)']
			: [
					!payToMatches ? 'payTo does not match the block link' : '',
					!signatureValid ? 'block signature is invalid' : '',
					!balanceSufficient ? 'payer balance is insufficient' : '',
					!debitMatches
						? debitInvalid
							? 'block balance exceeds the payer balance (invalid debit)'
							: 'block does not debit the required amount'
						: '',
					!workValid ? 'block proof of work is invalid' : '',
					!frontierMatches ? 'block previous does not match the payer frontier' : '',
					!confirmedFrontierMatches ? 'payer frontier is not confirmed' : '',
				].filter(Boolean).join(', ')
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
			debitMatches,
			debitInvalid,
			workValid,
			frontierMatches,
			confirmedFrontierMatches,
			replayed,
			replayMatched,
		},
	};
}

async function handleVerifyPayment(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const signatureValue = String(context.getNodeParameter('paymentSignature', i));
	const payTo = String(context.getNodeParameter('payTo', i));
	const amountNano = String(context.getNodeParameter('amount', i));
	const mode = context.getNodeParameter('verificationMode', i, 'facilitator') as string;

	return runPaymentVerification(context, {
		signatureValue,
		payTo,
		amountNano,
		mode: mode as 'facilitator' | 'local',
	});
}

function decodePayToHex(address: string): string | null {
	const key = decodeNanoAddress(address);
	return key ? key.toString('hex') : null;
}

/**
 * Check whether the payment's send block is already on-chain (i.e. it was
 * settled by an earlier attempt). Returns `matched: true` only when the
 * on-chain block demonstrably paid for these exact requirements (payer,
 * amount, subtype send, link == payTo). Used to make client retries
 * idempotent in every verification mode, including facilitator mode, whose
 * verify has no built-in replay tolerance.
 */
export async function detectOnChainReplay(
	context: IExecuteFunctions,
	block: NanoStateBlock,
	amountRaw: string,
	payTo: string,
): Promise<{ replayed: boolean; matched: boolean }> {
	const computedHash = computeStateBlockHash(block);
	if (!computedHash) return { replayed: false, matched: false };
	const nanoCredentials = await requireCredentials(context, 'x402NanoApi', 'replay detection');
	const nanoConfig = getNanoRpcConfig(nanoCredentials);
	const blockInfo = await getBlockInfo(context, nanoConfig, computedHash.toString('hex'));
	// A block that is not on the ledger is not a replay (yet) — the payment may
	// simply not have been broadcast. Infra failures (missing credential,
	// unreachable RPC, other RPC errors) propagate as errors: silently treating
	// them as "not replayed" would re-answer 402 and double-charge retries.
	if (!blockInfo) return { replayed: false, matched: false };

	const replayPayerMatches = blockInfo.account === block.account;
	const replayAmountMatches = blockInfo.amount === amountRaw;
	const replaySubtypeMatches = blockInfo.subtype === 'send';
	const replayLinkMatches =
		Boolean(blockInfo.linkAsAccount && blockInfo.linkAsAccount === payTo) ||
		Boolean(
			blockInfo.link &&
				blockInfo.link.toLowerCase() === (decodePayToHex(payTo) ?? '').toLowerCase(),
		);

	return {
		replayed: true,
		matched:
			replayPayerMatches &&
			replayAmountMatches &&
			replaySubtypeMatches &&
			replayLinkMatches,
	};
}

/**
 * Optional belt-and-braces guard for facilitator-mode settlement: when a Nano
 * RPC credential is reachable, check that the block that is about to be
 * settled is on-chain with exactly the required amount. This closes the gap
 * where a facilitator verifies a payment but the ledger shows a different
 * amount (a broken or malicious facilitator underselling the merchant).
 *
 * Returns:
 *   true  - the block is on-chain and debits exactly `amountRaw`
 *   false - the block is on-chain but debits a different amount (refuse to settle)
 *   null  - the guard cannot run (no credential / block not visible / RPC
 *           unreachable) — deliberately permissive, never blocks settlement
 */
async function checkOnChainAmount(
	context: IExecuteFunctions,
	block: NanoStateBlock,
	amountRaw: string,
): Promise<boolean | null> {
	try {
		const computedHash = computeStateBlockHash(block);
		if (!computedHash) return null;
		const nanoCredentials = await context.getCredentials('x402NanoApi');
		const nanoConfig = getNanoRpcConfig(nanoCredentials);
		const blockInfo = await getBlockInfo(context, nanoConfig, computedHash.toString('hex'));
		if (!blockInfo) return null;
		return blockInfo.amount === amountRaw;
	} catch {
		return null;
	}
}

export interface SettlePaymentInput {
	signatureValue: string;
	payTo: string;
	amountNano: string;
	mode: 'facilitator' | 'local';
}

export async function runPaymentSettlement(
	context: IExecuteFunctions,
	input: SettlePaymentInput,
): Promise<IDataObject> {
	const { signatureValue, payTo, amountNano, mode } = input;

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
		// Optional belt-and-braces: if a Nano RPC is reachable and the block is
		// already on-chain with a different amount than required, refuse to
		// settle (a broken or malicious facilitator must not undersell the
		// merchant). Best-effort: null (no credential / block not visible / RPC
		// unreachable) proceeds to settle.
		const onChainAmount = await checkOnChainAmount(context, block, amountRaw);
		if (onChainAmount === false) {
			throw new NodeOperationError(
				context.getNode(),
				'The payment block is already on-chain but does not debit the required amount; refusing to settle.',
				{
					description:
						'This can indicate a mismatched or tampered payment. Do not serve the content.',
				},
			);
		}

		const credentials = await requireCredentials(context, 'x402FacilitatorApi', 'settling payments');
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

	const nanoCredentials = await requireCredentials(context, 'x402NanoApi', 'settling payments locally');
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

async function handleSettlePayment(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const signatureValue = String(context.getNodeParameter('paymentSignature', i));
	const payTo = String(context.getNodeParameter('payTo', i));
	const amountNano = String(context.getNodeParameter('amount', i));
	const mode = context.getNodeParameter('settleMode', i, 'facilitator') as string;

	return runPaymentSettlement(context, {
		signatureValue,
		payTo,
		amountNano,
		mode: mode as 'facilitator' | 'local',
	});
}

async function handleReceivePending(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const credentials = await requireCredentials(context, 'x402NanoApi', 'receiving pending sends');
	const config = getNanoRpcConfig(credentials);
	const privateKeyHex = ((credentials.privateKey as string) ?? '').trim();
	const walletId = ((credentials.walletId as string) ?? '').trim();
	const accountParam = context.getNodeParameter('sourceAccount', i, '') as string;

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
		account = (accountParam || (credentials.sourceAccount as string) || '').trim();
		if (!account) {
			throw new NodeOperationError(
				context.getNode(),
				'Either a private key or a wallet ID + source account are required to receive. Configure the x402 Nano API credential.',
			);
		}
		if (!walletId) {
			throw new NodeOperationError(
				context.getNode(),
				'No wallet ID configured in the x402 Nano API credential and no private key provided',
			);
		}
	}

	const pendings = await getPendingBlocks(context, config, account);
	if (pendings.length === 0) {
		return { account, count: 0, received: [] };
	}

	const representativeOverride = (context.getNodeParameter('representative', i, '') as string).trim();
	let info: { frontier: string; balance: string; representative: string };
	try {
		info = await getAccountInfo(context, config, account);
	} catch {
		info = { frontier: '', balance: '0', representative: representativeOverride || account };
	}

	const received: Array<Record<string, unknown>> = [];
	for (const pending of pendings) {
		const built = buildReceiveBlock({
			account,
			previous: info.frontier,
			representative: info.representative,
			balanceRaw: info.balance,
			sourceHash: pending.hash,
			amountRaw: pending.amount,
			...(pending.source ? { sourceAccount: pending.source } : {}),
		});
		if (!built) {
			throw new NodeOperationError(
				context.getNode(),
				`Cannot build a receive block for pending ${pending.hash}: invalid account state or amount`,
			);
		}

		// Open blocks need their proof of work generated over the account
		// public key, not over the 64-zero previous hash.
		const workRoot = resolveReceiveWorkRoot(account, info.frontier);
		if (!workRoot) {
			throw new NodeOperationError(
				context.getNode(),
				`Cannot resolve the work root for account ${account}: invalid account address or frontier`,
			);
		}
		const work = await generateWork(context, config, workRoot, {
			difficulty: RECEIVE_WORK_DIFFICULTY,
		});
		const signature = privateKeyHex
			? signBlock(Buffer.from(privateKeyHex, 'hex'), built.hash)
			: await signWithWallet(context, config, walletId, account, built.hash);

		const block: NanoStateBlock = {
			...built.block,
			work: work.toUpperCase(),
			signature: signature.toUpperCase(),
		};
		const hash = await processBlock(context, config, block as unknown as Record<string, unknown>);

		info = {
			frontier: hash,
			balance: built.block.balance,
			representative: built.block.representative,
		};
		received.push({
			hash,
			account,
			amountRaw: pending.amount,
			amountNano: rawToNano(pending.amount),
			...(pending.source ? { source: pending.source } : {}),
		});
	}

	return { account, count: received.length, received };
}

async function handleSupported(context: IExecuteFunctions): Promise<IDataObject> {
	const credentials = await requireCredentials(context, 'x402FacilitatorApi', 'listing supported kinds');
	const config = getFacilitatorConfig(credentials);
	const result = await facilitatorGetSupported(context, config);
	return { ...(result as IDataObject), facilitatorUrl: config.baseUrl };
}

async function handleBuild402Response(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const protocol = context.getNodeParameter('protocol', i, 'both') as string;
	const payTo = String(context.getNodeParameter('payTo', i));
	const amountNano = String(context.getNodeParameter('amount', i));
	const paymentId = context.getNodeParameter('paymentId', i, '') as string;
	const serviceName = context.getNodeParameter('serviceName', i, '') as string;
	const resourceDescription = context.getNodeParameter('resourceDescription', i, '') as string;
	const resourceUrl = context.getNodeParameter('resourceUrl', i, '') as string;
	const mimeType = context.getNodeParameter('mimeType', i, 'application/json') as string;
	const tags = context.getNodeParameter('tags', i, '') as string;
	const errorMessage = context.getNodeParameter('errorMessage', i, '') as string;
	const maxTimeoutSeconds = context.getNodeParameter('maxTimeoutSeconds', i, 0) as number;

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
		...(maxTimeoutSeconds && maxTimeoutSeconds > 0 ? { maxTimeoutSeconds } : {}),
	});
}

export interface PaymentResponseEnvelopeParams {
	protocol: 'v1' | 'v2' | 'both';
	success: boolean;
	transaction?: string;
	payer?: string;
	paymentId?: string;
}

export function buildPaymentResponseEnvelope(
	params: PaymentResponseEnvelopeParams,
): IDataObject {
	const settlement: NormalizedSettlement = {
		success: params.success,
		...(params.transaction ? { transaction: params.transaction } : {}),
		network: NANO_NETWORK,
		...(params.payer ? { payer: params.payer } : {}),
		...(params.paymentId ? { paymentId: params.paymentId } : {}),
	};

	const headers: Record<string, string> = {};
	if (params.protocol === 'v2' || params.protocol === 'both') {
		const header = encodeSettlementHeader(2, settlement);
		headers[header.name] = header.value;
	}
	if (params.protocol === 'v1' || params.protocol === 'both') {
		const header = encodeSettlementHeader(1, settlement);
		headers[header.name] = header.value;
	}

	return {
		statusCode: 200,
		headers,
		body: {},
	};
}

async function handleBuildPaymentResponse(context: IExecuteFunctions, i: number): Promise<IDataObject> {
	const protocol = context.getNodeParameter('responseProtocol', i, 'both') as string;
	const success = context.getNodeParameter('responseSuccess', i, true) as boolean;
	const transaction = context.getNodeParameter('responseTransaction', i, '') as string;
	const payer = context.getNodeParameter('responsePayer', i, '') as string;
	const paymentId = context.getNodeParameter('responsePaymentId', i, '') as string;

	return buildPaymentResponseEnvelope({
		protocol: protocol as 'v1' | 'v2' | 'both',
		success,
		transaction,
		payer,
		paymentId,
	});
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
			if (operation === 'sendWithPayment') {
				return await handleSendWithPayment(context, i);
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
			case 'receivePending':
				return await handleReceivePending(context, i);
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
	maxTimeoutSeconds?: number;
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
		...(params.maxTimeoutSeconds !== undefined && params.maxTimeoutSeconds > 0
			? { maxTimeoutSeconds: params.maxTimeoutSeconds }
			: {}),
	};

	const acceptV2: AcceptV2 = {
		scheme: EXACT_SCHEME,
		network: NANO_NETWORK,
		amount: amountRaw,
		payTo: params.payTo,
		asset: 'XNO',
		extra,
		...(params.maxTimeoutSeconds !== undefined && params.maxTimeoutSeconds > 0
			? { maxTimeoutSeconds: params.maxTimeoutSeconds }
			: {}),
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
