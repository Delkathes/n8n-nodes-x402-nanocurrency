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
		],
		properties: [
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: '',
				placeholder: 'x402',
				description:
					'The webhook path to listen to. Leave empty for a unique URL based on the webhook ID. Dynamic values can be specified using \':\', e.g. \'x402/:identifier\'.',
			},
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
		// to the workflow. The webhooks are configured with
		// responseMode: 'responseNode', so the response must be left to a
		// Respond to Webhook node: return noWebhookResponse so n8n waits for it
		// instead of answering immediately with the default response.
		return { noWebhookResponse: true };
	}
}