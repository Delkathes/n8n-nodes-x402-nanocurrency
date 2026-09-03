import {
	NodeConnectionTypes,
	type IDataObject,
	type IHookFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { classifyPaywallRequest, normalizeHeaderKeys } from '../../utils/paywall-classifier';

/**
 * Shared webhook entries: POST (default) + GET (setup) on the same
 * parameterized path, answered by a Respond to Webhook node.
 */
function paywallWebhooks(): NonNullable<INodeTypeDescription['webhooks']> {
	return [
		{
			name: 'default',
			httpMethod: 'POST',
			responseMode: 'responseNode',
			isFullPath: true,
			path: '={{$parameter.path}}',
		},
		{
			name: 'setup',
			httpMethod: 'GET',
			responseMode: 'responseNode',
			isFullPath: true,
			path: '={{$parameter.path}}',
		},
	];
}

/**
 * No-op external registration: the webhooks are served by n8n itself, so
 * checkExists/create/delete report success without side effects. Both webhook
 * names must have a symmetric entry.
 */
function paywallWebhookMethods(): INodeType['webhookMethods'] {
	return {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
		setup: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};
}

function pathParameter(): INodeTypeDescription['properties'] extends Array<infer T> ? T : never {
	return {
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '',
		placeholder: 'x402',
		description:
			'The webhook path to listen to. Leave empty for a unique URL based on the webhook ID. Dynamic values can be specified using \':\', e.g. \'x402/:identifier\'.',
	};
}

function buildWebhookItem(this: IWebhookFunctions, normalize: boolean): INodeExecutionData {
	const req = this.getRequestObject();
	const item: IDataObject = {
		headers: normalize ? normalizeHeaderKeys(req.headers) : req.headers,
		params: req.params,
		query: req.query,
		body: req.body,
	};
	if (normalize) {
		item.payment = classifyPaywallRequest(req.headers);
	}
	return { json: item };
}

/**
 * Version 1 — passthrough paywall webhook. Every request (headers, params,
 * query, body) is passed to the workflow on a single output; the workflow
 * decides how to answer (402 + PAYMENT-REQUIRED or 200 + PAYMENT-RESPONSE)
 * via a Respond to Webhook node.
 */
export class X402NanoTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'X402 Nano Trigger',
		name: 'x402NanoTrigger',
		icon: {
			light: 'file:x402.svg',
			dark: 'file:x402.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle: 'Paywall webhook',
		description:
			'Expose an HTTP endpoint protected by x402 payments in Nano. Probe requests get a 402 with payment requirements, paid requests flow through the workflow.',
		defaults: {
			name: 'X402 Nano Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'x402NanoApi',
				required: false,
			},
			{
				name: 'x402FacilitatorApi',
				required: false,
			},
		],
		webhooks: paywallWebhooks(),
		properties: [
			pathParameter(),
			{
				displayName: 'Paywall Flow',
				name: 'paywallNotice',
				type: 'notice',
				default:
					'Every request (body, query and headers) is passed to the workflow. End the workflow with a Respond to Webhook node: for requests without a PAYMENT-SIGNATURE/X-PAYMENT header respond 402 using "Build 402 Payment Required", otherwise verify + settle the payment and respond 200 using "Build Payment Response".',
			},
		],
	};

	webhookMethods = paywallWebhookMethods();

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return {
			noWebhookResponse: true,
			workflowData: [[buildWebhookItem.call(this, false)]],
		};
	}
}

/**
 * Version 2 — classified paywall webhook with two outputs.
 *
 * Output 0 "Unpaid request": no v1/v2 payment header (probe requests, GET
 * setup probes).
 * Output 1 "Paid request": a payment header is present; the item carries
 * `payment: { hasPayment, protocol, headerName, headerValue, headerInvalid }`
 * and normalized lowercase headers. Use headerInvalid to answer a distinct
 * 402 when the client tried to pay but the header is unusable.
 */
export class X402NanoTriggerV2 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'X402 Nano Trigger',
		name: 'x402NanoTrigger',
		icon: {
			light: 'file:x402.svg',
			dark: 'file:x402.dark.svg',
		},
		group: ['trigger'],
		version: 2,
		subtitle: 'Paywall webhook',
		description:
			'Expose an HTTP endpoint protected by x402 payments in Nano. Requests without a payment header go to the unpaid output, paid requests to the paid output.',
		defaults: {
			name: 'X402 Nano Trigger',
		},
		inputs: [],
		outputs: [
			{ type: NodeConnectionTypes.Main, displayName: 'Unpaid request' },
			{ type: NodeConnectionTypes.Main, displayName: 'Paid request' },
		],
		credentials: [
			{
				name: 'x402NanoApi',
				required: false,
			},
			{
				name: 'x402FacilitatorApi',
				required: false,
			},
		],
		webhooks: paywallWebhooks(),
		properties: [
			pathParameter(),
			{
				displayName: 'Paywall Flow',
				name: 'paywallNotice',
				type: 'notice',
				default:
					'Requests are classified: no PAYMENT-SIGNATURE/X-PAYMENT header lands on the "Unpaid request" output, paid requests on the "Paid request" output (with payment.protocol, payment.headerValue and payment.headerInvalid). Answer via a Respond to Webhook node: unpaid -> 402 using "Build 402 Payment Required"; paid -> verify + settle and respond 200 using "Build Payment Response", or a fresh 402 when the payment is invalid.',
			},
		],
	};

	webhookMethods = paywallWebhookMethods();

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const item = buildWebhookItem.call(this, true);
		const payment = (item.json.payment as { hasPayment: boolean }) ?? { hasPayment: false };
		const outputs: INodeExecutionData[][] = [[], []];
		outputs[payment.hasPayment ? 1 : 0] = [item];
		return { noWebhookResponse: true, workflowData: outputs };
	}
}