import { NodeConnectionTypes, type IExecuteFunctions, type INodeType, type INodeTypeDescription } from 'n8n-workflow';

import { executePaywall } from './handlers/paywall-handler';

export class X402NanoPaywall implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'X402 Nano Paywall',
		name: 'x402NanoPaywall',
		icon: {
			light: 'file:x402.svg',
			dark: 'file:x402.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: 'Classify, verify, settle',
		description:
			'Drop-in seller node: classifies a webhook request, answers unpaid requests with a 402, verifies and settles paid ones, and emits ready-to-respond envelopes.',
		defaults: {
			name: 'X402 Nano Paywall',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [
			{ type: NodeConnectionTypes.Main, displayName: 'Payment required' },
			{ type: NodeConnectionTypes.Main, displayName: 'Payment received' },
		],
		credentials: [
			{
				name: 'x402FacilitatorApi',
				required: false,
			},
			{
				name: 'x402NanoApi',
				required: false,
			},
		],
		properties: [
			{
				displayName:
					'Place this node after a Webhook node (required by the Respond to Webhook node). Unpaid requests leave on "Payment required" with a ready 402 envelope; paid requests are verified, settled and leave on "Payment received" with a ready 200 envelope. Answer via a Respond to Webhook node bound to {{ $json.statusCode }}, {{ $json.headers }} and {{ $json.body }}.',
				name: 'paywallNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Pay To Address (Your Receiving Account)',
				name: 'payTo',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'nano_1abc...',
				description: 'Nano account the payment is sent to. Use an expression to pull it from another node.',
			},
			{
				displayName: 'Amount (NANO)',
				name: 'amount',
				type: 'string',
				required: true,
				default: '',
				placeholder: '0.01',
				hint: 'Up to 30 decimal places',
				description: 'Price of the resource in NANO. Use an expression for dynamic pricing.',
			},
			{
				displayName: 'Payment ID',
				name: 'paymentId',
				type: 'string',
				default: '',
				description: 'Opaque payment identifier echoed back in the payment payload (use an expression for per-request IDs)',
			},
			{
				displayName: 'Protocol',
				name: 'protocol',
				type: 'options',
				default: 'both',
				options: [
					{
						name: 'Both (V2 Header + V1 Body)',
						value: 'both',
						description: 'Emit the v2 PAYMENT-REQUIRED header and the v1 accepts body so any client can pay',
					},
					{ name: 'V1', value: 'v1', description: 'X402 v1: accepts array in the JSON body' },
					{ name: 'V2', value: 'v2', description: 'X402 v2: PAYMENT-REQUIRED header' },
				],
				description: 'Which x402 protocol version(s) to advertise in the 402 and settlement responses',
			},
			{
				displayName: 'Service Name',
				name: 'serviceName',
				type: 'string',
				default: '',
				description: 'Human-readable service name shown to paying clients',
			},
			{
				displayName: 'Resource Description',
				name: 'resourceDescription',
				type: 'string',
				default: '',
				description: 'Description of the paid resource',
			},
			{
				displayName: 'Resource URL',
				name: 'resourceUrl',
				type: 'string',
				default: '',
				description: 'URL of the paid resource',
			},
			{
				displayName: 'MIME Type',
				name: 'mimeType',
				type: 'string',
				default: 'application/json',
				description: 'MIME type of the paid resource',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'ai, image, generation',
				description: 'Comma-separated tags describing the paid resource',
			},
			{
				displayName: 'Error Message',
				name: 'errorMessage',
				type: 'string',
				default: '',
				description: 'Error text shown to the client alongside the payment requirements. Defaults to "Payment Required".',
			},
			{
				displayName: 'Max Timeout Seconds',
				name: 'maxTimeoutSeconds',
				type: 'number',
				default: 0,
				typeOptions: {
					minValue: 0,
				},
				description: 'Maximum time (seconds) the payment requirements stay valid. 0 omits the field.',
			},
			{
				displayName: 'Verification Mode',
				name: 'verificationMode',
				type: 'options',
				default: 'facilitator',
				options: [
					{
						name: 'Facilitator',
						value: 'facilitator',
						description: 'Verify through the x402 facilitator',
					},
					{
						name: 'Local (Nano RPC)',
						value: 'local',
						description:
							'Verify locally against your Nano node. Already-on-chain retries are detected and answered idempotently in both modes.',
					},
				],
				description: 'How to verify the incoming payment signature',
			},
			{
				displayName: 'Settle Automatically',
				name: 'autoSettle',
				type: 'boolean',
				default: true,
				description:
					'Whether to settle the received payment automatically. When disabled, "Payment received" carries the verified (unsettled) payment so you can settle it later with the Settle Payment operation.',
			},
			{
				displayName: 'Settle Mode',
				name: 'settleMode',
				type: 'options',
				displayOptions: {
					show: {
						autoSettle: [true],
					},
				},
				default: 'facilitator',
				options: [
					{
						name: 'Facilitator',
						value: 'facilitator',
						description: 'Settle through the x402 facilitator (it processes the block on its node)',
					},
					{
						name: 'Local (Nano RPC)',
						value: 'local',
						description: 'Process the payment block directly on your own Nano node',
					},
				],
				description: 'How to settle the received payment',
			},
		],
		usableAsTool: true,
	};

	async execute(this: IExecuteFunctions) {
		return executePaywall(this);
	}
}
