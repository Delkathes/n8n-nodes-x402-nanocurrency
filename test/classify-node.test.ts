import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { X402NanoClassify } from '../nodes/X402Nano/X402NanoClassify.node';

const V2 = 'eyJ4NDAyVmVyc2lvbiI6Mn0=';

function mockExecuteContext(input: INodeExecutionData[]): IExecuteFunctions {
	return {
		getInputData: () => input,
	} as unknown as IExecuteFunctions;
}

describe('X402 Nano Classify', () => {
	it('describes two labeled outputs', () => {
		const node = new X402NanoClassify();
		expect(node.description.name).toBe('x402NanoClassify');
		expect(node.description.version).toBe(1);
		const outputs = node.description.outputs as Array<{ displayName?: string }>;
		expect(outputs.map((output) => output.displayName)).toEqual(['Unpaid request', 'Paid request']);
	});

	it('routes a request without a payment header to the unpaid output', async () => {
		const node = new X402NanoClassify();
		const [unpaid, paid] = await node.execute.call(
			mockExecuteContext([
				{ json: { headers: { 'Content-Type': 'application/json' }, body: { hello: 'world' } } },
			]),
		);
		expect(unpaid).toHaveLength(1);
		expect(paid).toHaveLength(0);
		const item = unpaid[0].json as {
			body: object;
			headers: Record<string, string>;
			payment: { hasPayment: boolean; headerInvalid: boolean };
		};
		expect(item.body).toEqual({ hello: 'world' });
		expect(item.headers).toEqual({ 'content-type': 'application/json' });
		expect(item.payment.hasPayment).toBe(false);
		expect(item.payment.headerInvalid).toBe(false);
	});

	it('routes a paid request to the paid output with the classification', async () => {
		const node = new X402NanoClassify();
		const [unpaid, paid] = await node.execute.call(
			mockExecuteContext([
				{ json: { headers: { 'PAYMENT-SIGNATURE': V2 }, body: {} } },
			]),
		);
		expect(unpaid).toHaveLength(0);
		expect(paid).toHaveLength(1);
		const item = paid[0].json as {
			headers: Record<string, string>;
			payment: { hasPayment: boolean; protocol: string; headerInvalid: boolean; headerValue: string };
		};
		expect(item.headers['payment-signature']).toBe(V2);
		expect(item.payment.hasPayment).toBe(true);
		expect(item.payment.protocol).toBe('v2');
		expect(item.payment.headerInvalid).toBe(false);
		expect(item.payment.headerValue).toBe(V2);
	});

	it('routes a garbage payment header to the paid output with headerInvalid', async () => {
		const node = new X402NanoClassify();
		const [unpaid, paid] = await node.execute.call(
			mockExecuteContext([{ json: { headers: { 'x-payment': 'garbage!!' }, body: {} } }]),
		);
		expect(unpaid).toHaveLength(0);
		expect(paid).toHaveLength(1);
		const item = paid[0].json as { payment: { protocol: string; headerInvalid: boolean } };
		expect(item.payment.protocol).toBe('v1');
		expect(item.payment.headerInvalid).toBe(true);
	});

	it('routes mixed items independently', async () => {
		const node = new X402NanoClassify();
		const [unpaid, paid] = await node.execute.call(
			mockExecuteContext([
				{ json: { headers: {} } },
				{ json: { headers: { 'payment-signature': V2 } } },
				{ json: { headers: { 'x-payment': V2 } } },
				{ json: { headers: {} } },
			]),
		);
		expect(unpaid).toHaveLength(2);
		expect(paid).toHaveLength(2);
	});
});