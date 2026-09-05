import { describe, expect, it } from 'vitest';

import { coerceJsonBody, normalizeRequestHeaders } from '../utils/request-headers';

describe('normalizeRequestHeaders', () => {
	it('accepts a plain JSON string', () => {
		const result = normalizeRequestHeaders('{"content-type": "application/json"}');
		expect(result.error).toBeUndefined();
		expect(result.headers).toEqual({ 'content-type': 'application/json' });
	});

	it('accepts an expression result object as-is', () => {
		const result = normalizeRequestHeaders({ 'content-type': 'application/json', 'x-x402': true });
		expect(result.error).toBeUndefined();
		expect(result.headers).toEqual({ 'content-type': 'application/json', 'x-x402': true });
	});

	it('returns empty headers for empty or missing input', () => {
		expect(normalizeRequestHeaders(undefined).headers).toEqual({});
		expect(normalizeRequestHeaders(null).headers).toEqual({});
		expect(normalizeRequestHeaders('').headers).toEqual({});
		expect(normalizeRequestHeaders('   ').headers).toEqual({});
	});

	it('returns an error for invalid JSON strings', () => {
		expect(normalizeRequestHeaders('not-json').error?.kind).toBe('invalid');
		expect(normalizeRequestHeaders('[1,2,3]').error?.kind).toBe('invalid');
	});

	it('returns empty headers for unsupported input types', () => {
		expect(normalizeRequestHeaders(42).headers).toEqual({});
		expect(normalizeRequestHeaders(true).headers).toEqual({});
		expect(normalizeRequestHeaders(['a']).headers).toEqual({});
	});
});

describe('coerceJsonBody', () => {
	it('passes objects through as-is', () => {
		expect(coerceJsonBody({ prompt: 'hello' }).value).toEqual({ prompt: 'hello' });
	});

	it('parses JSON text strings into objects', () => {
		expect(coerceJsonBody('{"prompt":"hello"}').value).toEqual({ prompt: 'hello' });
		expect(coerceJsonBody('  {"a":1}  ').value).toEqual({ a: 1 });
	});

	it('returns undefined value for empty input', () => {
		expect(coerceJsonBody('').value).toBeUndefined();
		expect(coerceJsonBody('   ').value).toBeUndefined();
		expect(coerceJsonBody(undefined).value).toBeUndefined();
	});

	it('reports a clear error for invalid JSON text', () => {
		expect(coerceJsonBody('not-json').error?.kind).toBe('invalid');
		expect(coerceJsonBody('{broken').error?.message).toMatch(/valid JSON/);
	});
});
