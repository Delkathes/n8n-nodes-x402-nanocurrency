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
				path: 'x402/{{$webhookId}}',
			},
		],
		properties: [
			{
				displayName: 'Paywall Flow',
				name: 'paywallNotice',
				type: 'notice',
				default:
					'Every request (body, query and headers) is passed to the workflow. End the workflow with a Respond to Webhook node: for requests without a PAYMENT-SIGNATURE/X-PAYMENT header respond 402 using "Build 402 Payment Required", otherwise verify + settle the payment and respond 200 using "Build Payment Response".',
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
		// The default webhook item ({ headers, params, query, body }) is passed
		// to the workflow. The workflow responds via a Respond to Webhook node
		// (402 + PAYMENT-REQUIRED, or 200 + PAYMENT-RESPONSE).
		return { webhookResponse: 'default' };
	}
}
