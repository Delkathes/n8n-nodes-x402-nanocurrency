import type { IWebhookFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { X402NanoTrigger, X402NanoTriggerV2 } from '../nodes/X402Nano/X402NanoTrigger.node';

const V2 = 'eyJ4NDAyVmVyc2lvbiI6Mn0=';

function mockWebhookContext(req: unknown): IWebhookFunctions {
	return {
		getRequestObject: () => req,
	} as unknown as IWebhookFunctions;
}

describe('X402 Nano Trigger v1', () => {
	it('stays a single-output passthrough', () => {
		const v1 = new X402NanoTrigger();
		expect(v1.description.version).toBe(1);
		expect(v1.description.outputs).toHaveLength(1);
	});

	it('returns noWebhookResponse with the passthrough item on output 0', async () => {
		const v1 = new X402NanoTrigger();
		const result = await v1.webhook.call(
			mockWebhookContext({ headers: { 'content-type': 'application/json' }, params: {}, query: {}, body: {} }),
		);
		expect(result.noWebhookResponse).toBe(true);
		expect(result.workflowData).toHaveLength(1);
		expect(result.workflowData![0]).toHaveLength(1);
		expect((result.workflowData![0][0].json as { body: object }).body).toEqual({});
	});
});

describe('X402 Nano Trigger v2', () => {
	it('describes two labeled outputs', () => {
		const v2 = new X402NanoTriggerV2();
		expect(v2.description.version).toBe(2);
		const outputs = v2.description.outputs as Array<{ displayName?: string }>;
		expect(outputs.map((output) => output.displayName)).toEqual(['Unpaid request', 'Paid request']);
	});

	it('keeps the parameterized webhook paths and responseNode mode', () => {
		const v2 = new X402NanoTriggerV2();
		const webhooks = v2.description.webhooks ?? [];
		expect(webhooks).toHaveLength(2);
		for (const webhook of webhooks) {
			expect(webhook.path).toBe('={{$parameter.path}}');
			expect(webhook.isFullPath).toBe(true);
			expect(webhook.responseMode).toBe('responseNode');
		}
		expect(webhooks.map((webhook) => webhook.httpMethod).sort()).toEqual(['GET', 'POST']);
	});

	it('exposes the path parameter', () => {
		const v2 = new X402NanoTriggerV2();
		const pathParam = (v2.description.properties ?? []).find((property) => property.name === 'path');
		expect(pathParam).toBeDefined();
	});

	it('implements symmetric webhookMethods for both webhooks', () => {
		const v2 = new X402NanoTriggerV2();
		expect(v2.webhookMethods).toBeDefined();
		expect(Object.keys(v2.webhookMethods ?? {})).toEqual(['default', 'setup']);
	});
});

describe('X402 Nano Trigger v2 webhook()', () => {
	it('returns noWebhookResponse with both output arrays always present', async () => {
		const v2 = new X402NanoTriggerV2();
		const result = await v2.webhook.call(
			mockWebhookContext({ headers: {}, params: {}, query: {}, body: {} }),
		);
		expect(result.noWebhookResponse).toBe(true);
		expect(result.workflowData).toHaveLength(2);
		expect(result.workflowData![0]).toHaveLength(1);
		expect(result.workflowData![1]).toHaveLength(0);
	});

	it('routes a request without a payment header to the unpaid output', async () => {
		const v2 = new X402NanoTriggerV2();
		const result = await v2.webhook.call(
			mockWebhookContext({
				headers: { 'Content-Type': 'application/json' },
				params: {},
				query: {},
				body: { hello: 'world' },
			}),
		);
		const item = result.workflowData![0][0].json as { body: object; payment: { hasPayment: boolean; headerInvalid: boolean } };
		expect(item.body).toEqual({ hello: 'world' });
		expect(item.payment.hasPayment).toBe(false);
		expect(item.payment.headerInvalid).toBe(false);
	});

	it('routes a paid request to the paid output with the classification', async () => {
		const v2 = new X402NanoTriggerV2();
		const result = await v2.webhook.call(
			mockWebhookContext({
				headers: { 'PAYMENT-SIGNATURE': V2 },
				params: {},
				query: {},
				body: {},
			}),
		);
		expect(result.workflowData![0]).toHaveLength(0);
		expect(result.workflowData![1]).toHaveLength(1);
		const item = result.workflowData![1][0].json as {
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
		const v2 = new X402NanoTriggerV2();
		const result = await v2.webhook.call(
			mockWebhookContext({
				headers: { 'x-payment': 'garbage!!' },
				params: {},
				query: {},
				body: {},
			}),
		);
		expect(result.workflowData![1]).toHaveLength(1);
		const item = result.workflowData![1][0].json as {
			payment: { protocol: string; headerInvalid: boolean };
		};
		expect(item.payment.protocol).toBe('v1');
		expect(item.payment.headerInvalid).toBe(true);
	});
});