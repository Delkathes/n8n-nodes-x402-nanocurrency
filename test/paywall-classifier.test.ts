import { describe, expect, it } from 'vitest';

import { classifyPaywallRequest, normalizeHeaderKeys } from '../utils/paywall-classifier';

const V2 = 'eyJ4NDAyVmVyc2lvbiI6Mn0=';
const V1 = 'eyJ4NDAyVmVyc2lvbiI6MX0=';

describe('normalizeHeaderKeys', () => {
	it('lowercases keys and keeps string values', () => {
		expect(normalizeHeaderKeys({ 'PAYMENT-SIGNATURE': 'x', 'X-Payment': 'y' })).toEqual({
			'payment-signature': 'x',
			'x-payment': 'y',
		});
	});

	it('is safe for non-object input', () => {
		expect(normalizeHeaderKeys(undefined)).toEqual({});
		expect(normalizeHeaderKeys(null)).toEqual({});
		expect(normalizeHeaderKeys('nope')).toEqual({});
		expect(normalizeHeaderKeys([1, 2])).toEqual({});
	});

	it('drops non-string header values', () => {
		expect(normalizeHeaderKeys({ a: 1, b: ['x'], c: 'ok' })).toEqual({ c: 'ok' });
	});
});

describe('classifyPaywallRequest', () => {
	it('returns unpaid when no payment header is present', () => {
		const c = classifyPaywallRequest({ 'content-type': 'application/json' });
		expect(c.hasPayment).toBe(false);
		expect(c.protocol).toBe('');
		expect(c.headerName).toBe('');
		expect(c.headerValue).toBe('');
		expect(c.headerInvalid).toBe(false);
	});

	it('detects a v2 payment header (case-insensitive)', () => {
		const c = classifyPaywallRequest({ 'PAYMENT-SIGNATURE': V2 });
		expect(c.hasPayment).toBe(true);
		expect(c.protocol).toBe('v2');
		expect(c.headerName).toBe('PAYMENT-SIGNATURE');
		expect(c.headerValue).toBe(V2);
		expect(c.headerInvalid).toBe(false);
	});

	it('detects a v1 payment header', () => {
		const c = classifyPaywallRequest({ 'x-payment': V1 });
		expect(c.hasPayment).toBe(true);
		expect(c.protocol).toBe('v1');
		expect(c.headerName).toBe('X-PAYMENT');
		expect(c.headerValue).toBe(V1);
		expect(c.headerInvalid).toBe(false);
	});

	it('prefers v2 when both headers are present', () => {
		const c = classifyPaywallRequest({ 'payment-signature': V2, 'x-payment': V1 });
		expect(c.protocol).toBe('v2');
		expect(c.headerValue).toBe(V2);
		expect(c.headerName).toBe('PAYMENT-SIGNATURE');
	});

	it('flags an empty header value as invalid', () => {
		const c = classifyPaywallRequest({ 'payment-signature': '   ' });
		expect(c.hasPayment).toBe(true);
		expect(c.protocol).toBe('v2');
		expect(c.headerInvalid).toBe(true);
	});

	it('flags non-base64 header values as invalid', () => {
		const c = classifyPaywallRequest({ 'x-payment': 'not base64!!' });
		expect(c.hasPayment).toBe(true);
		expect(c.protocol).toBe('v1');
		expect(c.headerInvalid).toBe(true);
	});

	it('accepts base64url-style values', () => {
		const c = classifyPaywallRequest({ 'payment-signature': 'eyJ4NDAy-_' });
		expect(c.headerInvalid).toBe(false);
	});

	it('is safe for non-object input', () => {
		const c = classifyPaywallRequest(undefined);
		expect(c.hasPayment).toBe(false);
		expect(c.protocol).toBe('');
		expect(c.headerInvalid).toBe(false);
	});
});