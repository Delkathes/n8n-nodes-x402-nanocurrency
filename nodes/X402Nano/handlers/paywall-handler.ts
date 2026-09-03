import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
} from 'n8n-workflow';

import { computeStateBlockHash } from '../../../utils/block';
import { isValidNanoAmount, nanoToRaw } from '../../../utils/conversions';
import { classifyPaywallRequest, normalizeHeaderKeys } from '../../../utils/paywall-classifier';
import { extractBlockFromPayload, parsePaymentHeader } from '../../../utils/x402-codec';
import {
	buildPaymentResponseEnvelope,
	buildPaymentRequiredResponse,
	detectOnChainReplay,
	runPaymentSettlement,
	runPaymentVerification,
} from './operation-dispatcher';

/**
 * Drop-in seller node. Given the item produced by a built-in Webhook node
 * (its `json.headers`), each request is handled in one pass:
 *
 *   - no usable payment header        -> output 0 with a 402 envelope
 *   - payment present but not valid   -> output 0 with a fresh 402 envelope,
 *     UNLESS the block is already on-chain and paid exactly these
 *     requirements (a retry of an already-settled request) -> output 1
 *   - valid payment + auto-settle     -> settle, then output 1 with the 200
 *     payment-response envelope (settle failure raises a node error so the
 *     client retries the same signature — never a 402)
 *   - valid payment, no auto-settle   -> output 1 with the verified, unsettled
 *     payment so the merchant can settle later via Settle Payment
 *
 * Output items are ready-to-respond envelopes ({ statusCode, headers, body })
 * for the auto-settled / 402 paths; a Respond to Webhook node bound to
 * {{ $json.statusCode }} / {{ $json.headers }} / {{ $json.body }} answers them.
 */
export async function executePaywall(context: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = context.getInputData();
	const required: INodeExecutionData[] = [];
	const received: INodeExecutionData[] = [];

	for (let i = 0; i < items.length; i++) {
		const paymentInfo = classifyPaywallRequest(
			(items[i].json as Record<string, unknown> | undefined)?.headers as Record<string, unknown> | undefined,
		);
		const normalizeOutput = () => {
			const raw = (items[i].json ?? {}) as Record<string, unknown>;
			const payment = {
				hasPayment: paymentInfo.hasPayment,
				...(paymentInfo.protocol ? { protocol: paymentInfo.protocol } : {}),
				...(paymentInfo.headerName ? { headerName: paymentInfo.headerName } : {}),
				...(paymentInfo.headerValue && !paymentInfo.headerInvalid ? { headerValue: paymentInfo.headerValue } : {}),
				...(paymentInfo.headerInvalid ? { headerInvalid: true } : {}),
			};
			return { ...raw, headers: normalizeHeaderKeys(raw.headers), payment };
		};

		const amountNano = context.getNodeParameter('amount', i) as string;
		const payTo = context.getNodeParameter('payTo', i) as string;
		if (!isValidNanoAmount(amountNano)) {
			throw new NodeOperationError(
				context.getNode(),
				'Amount must be a positive decimal string with up to 30 decimal places (in NANO)',
				{ itemIndex: i },
			);
		}
		if (!payTo) {
			throw new NodeOperationError(context.getNode(), 'A receiving account (payTo) is required', { itemIndex: i });
		}
		const amountRaw = nanoToRaw(amountNano);
		const protocol = context.getNodeParameter('protocol', i, 'both') as 'v1' | 'v2' | 'both';
		const paymentId = context.getNodeParameter('paymentId', i, '') as string;
		const autoSettle = context.getNodeParameter('autoSettle', i, true) as boolean;

		const build402 = (): IDataObject =>
			buildPaymentRequiredResponse({
				protocol,
				payTo,
				amountNano,
				resource: buildResource(context, i),
				...(paymentId ? { paymentId } : {}),
				...(context.getNodeParameter('errorMessage', i, '') as string)
					? { error: context.getNodeParameter('errorMessage', i, '') as string }
					: {},
				...(Number(context.getNodeParameter('maxTimeoutSeconds', i, 0)) > 0
					? { maxTimeoutSeconds: Number(context.getNodeParameter('maxTimeoutSeconds', i, 0)) }
					: {}),
			});

		const pushRequired = () =>
			required.push({ json: { ...build402(), request: normalizeOutput() }, pairedItem: { item: i } });
		const pushReceived = (envelope: IDataObject) =>
			received.push({ json: { ...envelope, request: normalizeOutput() }, pairedItem: { item: i } });

		// 1. No usable payment header -> answer a fresh 402.
		if (!paymentInfo.hasPayment || paymentInfo.headerInvalid || !paymentInfo.headerValue) {
			pushRequired();
			continue;
		}

		const signatureValue = paymentInfo.headerValue;
		const parsed = parsePaymentHeader(signatureValue);
		const block = parsed ? extractBlockFromPayload(parsed.payload) : undefined;
		if (!parsed || !block) {
			// A value that passed the base64 shape check but is not a real header.
			pushRequired();
			continue;
		}

		// 2. Verify.
		const verificationMode = context.getNodeParameter('verificationMode', i, 'facilitator') as string;
		let verified: IDataObject;
		try {
			verified = await runPaymentVerification(context, {
				signatureValue,
				payTo,
				amountNano,
				mode: verificationMode as 'facilitator' | 'local',
			});
		} catch (error) {
			// Verification infrastructure failed on what could be a legit payment:
			// surface the error (the client retries the same signature) rather than
			// re-answering 402, which would make the client pay twice.
			throw new NodeOperationError(context.getNode(), error as Error, { itemIndex: i });
		}

		if (verified.isValid !== true) {
			// 3. Invalid locally: is it a retry of an already-settled payment?
			const replay = await detectOnChainReplay(context, block, amountRaw, payTo);
			if (replay.replayed && replay.matched) {
				const hash = computeStateBlockHash(block);
				pushReceived({
					...(buildPaymentResponseEnvelope({
						protocol,
						success: true,
						transaction: hash ? hash.toString('hex') : undefined,
						payer: block.account,
						...(paymentId ? { paymentId } : {}),
					}) as IDataObject),
					replayed: true,
				});
				continue;
			}
			pushRequired();
			continue;
		}

		// 4. Verified valid.
		if (!autoSettle) {
			pushReceived({
				statusCode: 200,
				headers: {},
				body: {},
				settled: false,
				verified: true,
				payTo,
				amountNano,
				amountRaw,
			});
			continue;
		}

		const settleMode = context.getNodeParameter('settleMode', i, 'facilitator') as string;
		let settlement: IDataObject;
		try {
			settlement = await runPaymentSettlement(context, {
				signatureValue,
				payTo,
				amountNano,
				mode: settleMode as 'facilitator' | 'local',
			});
		} catch (error) {
			throw new NodeOperationError(context.getNode(), error as Error, {
				itemIndex: i,
				description: 'Settlement failed. The client can safely retry the same payment signature.',
			});
		}

		if (settlement.success !== true) {
			const reason =
				typeof settlement.errorReason === 'string'
					? settlement.errorReason
					: typeof settlement.errorMessage === 'string'
						? settlement.errorMessage
						: 'unknown reason';
			throw new NodeOperationError(
				context.getNode(),
				`Settlement failed: ${reason}`,
				{ itemIndex: i, description: 'The client can safely retry the same payment signature.' },
			);
		}

		pushReceived(
			buildPaymentResponseEnvelope({
				protocol,
				success: true,
				transaction:
					typeof settlement.transaction === 'string' ? settlement.transaction : undefined,
				payer: typeof settlement.payer === 'string' ? settlement.payer : undefined,
				...(paymentId ? { paymentId } : {}),
			}),
		);
	}

	return [required, received];
}

function buildResource(context: IExecuteFunctions, i: number): IDataObject | undefined {
	const serviceName = context.getNodeParameter('serviceName', i, '') as string;
	const resourceDescription = context.getNodeParameter('resourceDescription', i, '') as string;
	const resourceUrl = context.getNodeParameter('resourceUrl', i, '') as string;
	const mimeType = context.getNodeParameter('mimeType', i, 'application/json') as string;
	const tags = context.getNodeParameter('tags', i, '') as string;

	if (!serviceName && !resourceDescription && !resourceUrl) return undefined;

	return {
		...(resourceUrl ? { url: resourceUrl } : {}),
		...(resourceDescription ? { description: resourceDescription } : {}),
		...(mimeType ? { mimeType } : {}),
		...(serviceName ? { serviceName } : {}),
		...(tags
			? { tags: tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0) }
			: {}),
	};
}
