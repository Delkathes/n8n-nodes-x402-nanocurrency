import {
	NodeConnectionTypes,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { dispatchX402Operation } from './handlers/operation-dispatcher';

export class X402Nano implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'X402 Nano',
		name: 'x402Nano',
		icon: {
			light: 'file:x402.svg',
			dark: 'file:x402.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: 'Pay for HTTP resources with Nano',
		description:
			'x402 payment protocol client: pay for AI APIs and other HTTP resources with Nano (XNO)',
		defaults: {
			name: 'X402 Nano',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
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
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Request',
						value: 'request',
						description: 'Send an HTTP request with x402 payment handling',
					},
					{
						name: 'Payment',
						value: 'payment',
						description: 'Build, verify and settle x402 payments',
					},
					{
						name: 'Response',
						value: 'response',
						description: 'Build 402 payment requirements and settlement responses for a paywall webhook',
					},
				],
				default: 'request',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['request'],
					},
				},
				options: [
					{
						name: 'Pay',
						value: 'pay',
						description: 'Send a request, pay a 402 challenge with Nano and retry',
						action: 'Pay request with nano',
					},
					{
						name: 'Probe',
						value: 'probe',
						description: 'Send a request without paying to discover the payment requirements',
						action: 'Probe payment requirements',
					},
				],
				default: 'pay',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['payment'],
					},
				},
				options: [
					{
						name: 'Build Payment Signature',
						value: 'buildPaymentSignature',
						description: 'Create an x402 payment header for an amount to an address',
						action: 'Build payment signature',
					},
					{
						name: 'Get Supported',
						value: 'supported',
						description: 'List the facilitator supported payment kinds',
						action: 'Get supported payment kinds',
					},
					{
						name: 'Probe Upstream Price',
						value: 'probeUpstreamPrice',
						description: 'Fetch payment requirements from a paywalled upstream URL with an optional markup',
						action: 'Probe upstream price',
					},
					{
						name: 'Settle Payment',
						value: 'settlePayment',
						description: 'Settle a verified payment block and get the transaction hash',
						action: 'Settle payment',
					},
					{
						name: 'Verify Payment',
						value: 'verifyPayment',
						description: 'Verify a payment payload against the expected requirements',
						action: 'Verify payment',
					},
				],
				default: 'buildPaymentSignature',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['response'],
					},
				},
				options: [
					{
						name: 'Build 402 Payment Required',
						value: 'build402Response',
						description: 'Build the 402 response (headers + body) for a paywall webhook',
						action: 'Build payment required response',
					},
					{
						name: 'Build Payment Response',
						value: 'buildPaymentResponse',
						description: 'Build the settlement response headers for a paid webhook request',
						action: 'Build payment response',
					},
				],
				default: 'build402Response',
			},

			// ── Request parameters ────────────────────────────────────────────────
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['request'],
						operation: ['pay', 'probe'],
					},
				},
				default: '',
				placeholder: 'https://api.example.com/v1/generate',
				description: 'URL of the x402-protected resource to request',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['probeUpstreamPrice'],
					},
				},
				default: '',
				placeholder: 'https://api.nanogpt.com/v1/generate',
				description: 'URL of the paywalled upstream resource to probe',
			},
			{
				displayName: 'Method',
				name: 'method',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
					},
				},
				options: [
					{ name: 'DELETE', value: 'DELETE' },
					{ name: 'GET', value: 'GET' },
					{ name: 'PATCH', value: 'PATCH' },
					{ name: 'POST', value: 'POST' },
					{ name: 'PUT', value: 'PUT' },
				],
				default: 'POST',
				description: 'HTTP method to use for the request',
			},
			{
				displayName: 'Protocol Version',
				name: 'protocolVersion',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['request'],
						operation: ['pay'],
					},
				},
				options: [
					{
						name: 'Auto-Detect',
						value: 'auto',
						description: 'Detect v1 (body) or v2 (PAYMENT-REQUIRED header) from the 402 response',
					},
					{ name: 'V1', value: 'v1', description: 'X402 v1: X-PAYMENT header, body accepts' },
					{ name: 'V2', value: 'v2', description: 'X402 v2: PAYMENT-SIGNATURE header' },
				],
				default: 'auto',
				description: 'Which x402 protocol version to use when paying',
			},
			{
				displayName: 'Request Headers',
				name: 'requestHeaders',
				type: 'json',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
					},
				},
				default: '{}',
				placeholder: '{"Authorization": "Bearer sk-..."}',
				description: 'Headers to send with the request as a JSON object',
			},
			{
				displayName: 'Body Type',
				name: 'bodyType',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
					},
				},
				options: [
					{ name: 'JSON', value: 'json' },
					{ name: 'Raw', value: 'raw' },
					{ name: 'None', value: 'none' },
				],
				default: 'json',
				description: 'How to encode the request body',
			},
			{
				displayName: 'JSON Body',
				name: 'jsonBody',
				type: 'json',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
						bodyType: ['json'],
					},
				},
				default: '{}',
				description: 'Request body as a JSON object',
			},
			{
				displayName: 'Raw Body',
				name: 'rawBody',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
						bodyType: ['raw'],
					},
				},
				default: '',
				description: 'Raw request body string',
			},
			{
				displayName: 'Raw Content Type',
				name: 'rawContentType',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
						bodyType: ['raw'],
					},
				},
				default: 'text/plain',
				description: 'Content-Type header for the raw body',
			},
			{
				displayName: 'Timeout',
				name: 'timeout',
				type: 'number',
				displayOptions: {
					show: {
						operation: ['pay', 'probe', 'probeUpstreamPrice'],
					},
				},
				default: 30000,
				typeOptions: {
					minValue: 1,
				},
				description: 'Request timeout in milliseconds',
			},
			{
				displayName: 'Pay Automatically',
				name: 'autoPay',
				type: 'boolean',
				displayOptions: {
					show: {
						resource: ['request'],
						operation: ['pay'],
					},
				},
				default: true,
				description: 'Whether to build and send a Nano payment when the server responds with 402. When disabled, the payment requirements are returned instead.',
			},
			{
				displayName: 'Source Account',
				name: 'sourceAccount',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['pay', 'buildPaymentSignature'],
					},
				},
				default: '',
				placeholder: 'nano_1abc...',
				description:
					'Paying account when signing with the node wallet. Overrides the credential source account. Ignored when a private key is configured.',
			},
			{
				displayName: 'Work Value',
				name: 'work',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['pay', 'buildPaymentSignature'],
					},
				},
				default: '',
				placeholder: '2bf29ef00786a6bc',
				description:
					'Optional pre-computed work value (16 hex characters). Leave empty to generate work via the RPC node or work server.',
			},
			{
				displayName: 'Markup Percent',
				name: 'markupPercent',
				type: 'number',
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['probeUpstreamPrice'],
					},
				},
				default: 0,
				typeOptions: {
					minValue: 0,
				},
				description: 'Percentage markup applied on top of the upstream price (rounded up to the nearest raw unit)',
			},

			// ── Payment parameters ────────────────────────────────────────────────
			{
				displayName: 'Requirements Source',
				name: 'signatureRequirementsMode',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['buildPaymentSignature'],
					},
				},
				options: [
					{ name: 'Manual', value: 'manual' },
					{ name: 'PAYMENT-REQUIRED Header', value: 'header' },
				],
				default: 'manual',
				description: 'Where to take the payTo address and amount from',
			},
			{
				displayName: 'PAYMENT-REQUIRED Header Value',
				name: 'paymentRequiredHeader',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['buildPaymentSignature'],
						signatureRequirementsMode: ['header'],
					},
				},
				default: '',
				description: 'Raw value of the PAYMENT-REQUIRED response header (base64 JSON)',
			},
			{
				displayName: 'Protocol Version',
				name: 'signatureProtocolVersion',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['buildPaymentSignature'],
						signatureRequirementsMode: ['manual'],
					},
				},
				options: [
					{ name: 'V1', value: 'v1', description: 'X402 v1: X-PAYMENT header' },
					{ name: 'V2', value: 'v2', description: 'X402 v2: PAYMENT-SIGNATURE header' },
				],
				default: 'v2',
				description: 'Which x402 protocol version to build the payment for',
			},
			{
				displayName: 'Pay To Address',
				name: 'payTo',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['verifyPayment', 'settlePayment', 'build402Response'],
					},
				},
				default: '',
				placeholder: 'nano_1abc...',
				description: 'Nano address payments must be sent to',
			},
			{
				displayName: 'Pay To Address',
				name: 'payTo',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['buildPaymentSignature'],
						signatureRequirementsMode: ['manual'],
					},
				},
				default: '',
				placeholder: 'nano_1abc...',
				description: 'Nano address payments must be sent to',
			},
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['verifyPayment', 'settlePayment', 'build402Response'],
					},
				},
				default: '',
				placeholder: '0.001',
				hint: 'Up to 30 decimal places',
				description: 'Expected payment amount in NANO',
			},
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['buildPaymentSignature'],
						signatureRequirementsMode: ['manual'],
					},
				},
				default: '',
				placeholder: '0.001',
				hint: 'Up to 30 decimal places',
				description: 'Payment amount in NANO',
			},
			{
				displayName: 'Payment Signature Header Value',
				name: 'paymentSignature',
				type: 'string',
				required: true,
				displayOptions: {
					show: {
						operation: ['verifyPayment', 'settlePayment'],
					},
				},
				default: '',
				description: 'Raw value of the PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) header',
			},
			{
				displayName: 'Verification Mode',
				name: 'verificationMode',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['verifyPayment'],
					},
				},
				options: [
					{
						name: 'Facilitator',
						value: 'facilitator',
						description: 'Verify through the x402 facilitator (checks work, confirmation and balance)',
					},
					{
						name: 'Local (Nano RPC)',
						value: 'local',
						description: 'Verify the signature and payTo locally against your Nano node, without a facilitator',
					},
				],
				default: 'facilitator',
			},
			{
				displayName: 'Settle Mode',
				name: 'settleMode',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['payment'],
						operation: ['settlePayment'],
					},
				},
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
				default: 'facilitator',
			},

			// ── Response parameters ───────────────────────────────────────────────
			{
				displayName: 'Protocol',
				name: 'protocol',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				options: [
					{
						name: 'Both (V2 Header + V1 Body)',
						value: 'both',
						description: 'Emit the v2 PAYMENT-REQUIRED header and the v1 accepts body so any client can pay',
					},
					{ name: 'V1', value: 'v1', description: 'X402 v1: accepts array in the JSON body' },
					{ name: 'V2', value: 'v2', description: 'X402 v2: PAYMENT-REQUIRED header' },
				],
				default: 'both',
				description: 'Which x402 protocol version(s) to emit payment requirements for',
			},
			{
				displayName: 'Payment ID',
				name: 'paymentId',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: '',
				description: 'Opaque payment identifier echoed back in the payment payload (use an expression for per-request IDs)',
			},
			{
				displayName: 'Service Name',
				name: 'serviceName',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: '',
				description: 'Human-readable service name shown to paying clients',
			},
			{
				displayName: 'Resource Description',
				name: 'resourceDescription',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: '',
				description: 'Description of the paid resource',
			},
			{
				displayName: 'Resource URL',
				name: 'resourceUrl',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: '',
				description: 'URL of the paid resource',
			},
			{
				displayName: 'MIME Type',
				name: 'mimeType',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: 'application/json',
				description: 'MIME type of the paid resource',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: '',
				placeholder: 'ai, image, generation',
				description: 'Comma-separated tags describing the paid resource',
			},
			{
				displayName: 'Error Message',
				name: 'errorMessage',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['build402Response'],
					},
				},
				default: '',
				description: 'Error text shown to the client alongside the payment requirements. Defaults to "Payment Required".',
			},
			{
				displayName: 'Protocol',
				name: 'responseProtocol',
				type: 'options',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['buildPaymentResponse'],
					},
				},
				options: [
					{ name: 'Both', value: 'both' },
					{ name: 'V1', value: 'v1' },
					{ name: 'V2', value: 'v2' },
				],
				default: 'both',
				description: 'Which x402 settlement header(s) to emit',
			},
			{
				displayName: 'Success',
				name: 'responseSuccess',
				type: 'boolean',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['buildPaymentResponse'],
					},
				},
				default: true,
				description: 'Whether the payment was settled successfully',
			},
			{
				displayName: 'Transaction Hash',
				name: 'responseTransaction',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['buildPaymentResponse'],
					},
				},
				default: '',
				description: 'Settled payment block hash (from Settle Payment)',
			},
			{
				displayName: 'Payer Address',
				name: 'responsePayer',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['buildPaymentResponse'],
					},
				},
				default: '',
				description: 'Nano address of the payer',
			},
			{
				displayName: 'Payment ID',
				name: 'responsePaymentId',
				type: 'string',
				displayOptions: {
					show: {
						resource: ['response'],
						operation: ['buildPaymentResponse'],
					},
				},
				default: '',
				description: 'Opaque payment identifier to echo back',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const resource = this.getNodeParameter('resource', i) as string;
			const operation = this.getNodeParameter('operation', i) as string;

			const responseData = await dispatchX402Operation({
				executeFunctions: this,
				resource,
				operation,
				itemIndex: i,
			});

			returnData.push({ json: responseData, pairedItem: { item: i } });
		}

		return [returnData];
	}
}
