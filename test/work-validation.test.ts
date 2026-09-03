import { describe, expect, it } from 'vitest';

import { parseWorkValidation } from '../utils/nano-rpc';

describe('parseWorkValidation', () => {
	it('accepts modern Nano (V27+) valid_all / valid_receive responses', () => {
		expect(parseWorkValidation({ valid_all: '1', valid_receive: '1' })).toBe(true);
		expect(parseWorkValidation({ valid_all: '1', valid_receive: '0' })).toBe(true);
		expect(parseWorkValidation({ valid_all: '0', valid_receive: '1' })).toBe(true);
		expect(parseWorkValidation({ valid_all: '0', valid_receive: '0' })).toBe(false);
	});

	it('accepts legacy valid responses', () => {
		expect(parseWorkValidation({ valid: '1' })).toBe(true);
		expect(parseWorkValidation({ valid: '0' })).toBe(false);
		expect(parseWorkValidation({ valid: 'true' })).toBe(true);
		expect(parseWorkValidation({ valid: 'false' })).toBe(false);
	});

	it('returns false for empty or malformed responses', () => {
		expect(parseWorkValidation({})).toBe(false);
		expect(parseWorkValidation({ valid_all: 'yes' })).toBe(false);
		expect(parseWorkValidation({ something: '1' })).toBe(false);
	});
});
