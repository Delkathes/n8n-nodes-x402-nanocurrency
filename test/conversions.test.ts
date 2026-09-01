import { describe, expect, it } from 'vitest';

import { isValidNanoAmount, nanoToRaw, rawToNano } from '../utils/conversions';

describe('nano conversions', () => {
	it('converts 30-decimal NANO amounts to raw without floating point loss', () => {
		expect(nanoToRaw('1.234567890123456789012345678901')).toBe(
			'1234567890123456789012345678901',
		);
		expect(nanoToRaw('0.000000000000000000000000000001')).toBe('1');
	});

	it('converts raw back to NANO', () => {
		expect(rawToNano('1234567890123456789012345678901')).toBe(
			'1.234567890123456789012345678901',
		);
	});

	it('rejects scientific notation and malformed amounts', () => {
		expect(() => nanoToRaw('1e-7')).toThrow();
		expect(() => nanoToRaw('-1')).toThrow();
		expect(() => nanoToRaw('abc')).toThrow();
		expect(() => rawToNano('abc')).toThrow();
	});

	it('validates amounts', () => {
		expect(isValidNanoAmount('1')).toBe(true);
		expect(isValidNanoAmount('0.000000000000000000000000000001')).toBe(true);
		expect(isValidNanoAmount('0')).toBe(false);
		expect(isValidNanoAmount('1e-7')).toBe(false);
	});
});
