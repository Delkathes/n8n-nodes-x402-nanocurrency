import {
	NodeConnectionTypes,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

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
				displayName: 'Placeholder',
				name: 'placeholderNotice',
				type: 'notice',
				default:
					'Client operations are being implemented: Pay, Probe, Build Payment Signature, Verify Payment, Settle Payment and Supported.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return [this.getInputData()];
	}
}
