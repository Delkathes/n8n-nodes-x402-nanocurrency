import {
	NodeConnectionTypes,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { classifyPaywallRequest, normalizeHeaderKeys } from '../../utils/paywall-classifier';

/**
 * Classifies x402 paywall requests into two outputs. Place it after a
 * built-in Webhook node (required by the Respond to Webhook node):
 *
 * Output 0 "Unpaid request": no v1/v2 payment header (probe requests, GET
 * setup probes).
 * Output 1 "Paid request": a payment header is present; the item carries
 * `payment: { hasPayment, protocol, headerName, headerValue, headerInvalid }`
 * and normalized lowercase headers. Use headerInvalid to answer a distinct
 * 402 when the client tried to pay but the header is unusable.
 */
export class X402NanoClassify implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'X402 Nano Classify',
		name: 'x402NanoClassify',
		icon: {
			light: 'file:x402.svg',
			dark: 'file:x402.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: 'Classify paywall requests',
		description:
			'Classify x402 paywall requests: requests without a payment header go to the unpaid output, paid requests to the paid output.',
		defaults: {
			name: 'X402 Nano Classify',
		},
		usableAsTool: false,
		inputs: [NodeConnectionTypes.Main],
		outputs: [
			{ type: NodeConnectionTypes.Main, displayName: 'Unpaid request' },
			{ type: NodeConnectionTypes.Main, displayName: 'Paid request' },
		],
		properties: [
			{
				displayName: 'Paywall Flow',
				name: 'paywallNotice',
				type: 'notice',
				default:
					'Place this node after a Webhook node (required by the Respond to Webhook node). Requests are classified: no PAYMENT-SIGNATURE/X-PAYMENT header lands on the "Unpaid request" output, paid requests on the "Paid request" output (with payment.protocol, payment.headerValue and payment.headerInvalid). Answer via a Respond to Webhook node: unpaid -> 402 using "Build 402 Payment Required"; paid -> verify + settle and respond 200 using "Build Payment Response", or a fresh 402 when the payment is invalid.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const unpaid: INodeExecutionData[] = [];
		const paid: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const raw = (item.json ?? {}) as Record<string, unknown>;
			const payment = classifyPaywallRequest(raw.headers);
			const paired = item.pairedItem;
			const entry: INodeExecutionData = {
				json: {
					...raw,
					headers: normalizeHeaderKeys(raw.headers),
					payment,
				},
				pairedItem:
					typeof paired === 'number' || !paired
						? { item: typeof paired === 'number' ? paired : i }
						: Array.isArray(paired)
							? paired
							: paired,
			};
			(payment.hasPayment ? paid : unpaid).push(entry);
		}

		return [unpaid, paid];
	}
}