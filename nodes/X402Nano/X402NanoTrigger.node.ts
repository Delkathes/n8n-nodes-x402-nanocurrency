import {
	NodeConnectionTypes,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

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
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'responseNode',
				path: 'x402',
			},
		],
		properties: [
			{
				displayName: 'Placeholder',
				name: 'placeholderNotice',
				type: 'notice',
				default:
					'Payment verification and 402 responses are being implemented. End the workflow with a Respond to Webhook node.',
			},
		],
	};

	webhookMethods = {
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
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		// The raw request (headers + body) is passed to the workflow. Respond
		// with a "Respond to Webhook" node (402 + PAYMENT-REQUIRED, or
		// 200 + PAYMENT-RESPONSE).
		return { webhookResponse: 'default' };
	}
}
