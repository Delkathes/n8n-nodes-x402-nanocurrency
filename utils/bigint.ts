const ZERO = BigInt(0);
const TEN = BigInt(10);

/**
 * Represents a decimal number as a BigInt with a scale (number of decimal places)
 */
interface ScaledBigInt {
	value: bigint;
	scale: number;
}

/**
 * Parse a decimal string into a scaled BigInt
 * e.g., "1.5" -> { value: 15n, scale: 1 }
 */
export function parseDecimal(input: string): ScaledBigInt {
	const str = input.toString().trim();
	const negative = str.startsWith('-');
	const abs = negative ? str.slice(1) : str;

	const dotIndex = abs.indexOf('.');
	if (dotIndex === -1) {
		// No decimal point
		return { value: BigInt(str), scale: 0 };
	}

	const intPart = abs.slice(0, dotIndex) || '0';
	const decPart = abs.slice(dotIndex + 1);
	const combined = intPart + decPart;
	const value = BigInt((negative ? '-' : '') + combined);

	return { value, scale: decPart.length };
}

/**
 * Shift a scaled BigInt by n decimal places
 * Positive n: multiply by 10^n (shift left)
 * Negative n: divide by 10^|n| (shift right)
 */
export function shiftedBy(num: ScaledBigInt, n: number): ScaledBigInt {
	// Shifting by n is equivalent to adjusting the scale by -n
	return { value: num.value, scale: num.scale - n };
}

/**
 * Raise 10 to a power using BigInt
 */
function pow10(exp: number): bigint {
	let result = BigInt(1);
	for (let i = 0; i < exp; i++) {
		result = result * TEN;
	}
	return result;
}

/**
 * Convert a scaled BigInt to a fixed-precision decimal string
 * Uses truncation (ROUND_DOWN) for consistency with original behavior
 */
export function toFixed(num: ScaledBigInt, precision: number, trim: boolean = false): string {
	const { value, scale } = num;
	const negative = value < ZERO;
	let absValue = negative ? -value : value;

	// Adjust to the target precision
	// If scale < precision, we need more decimal places (multiply)
	// If scale > precision, we need fewer decimal places (divide/truncate)
	const scaleDiff = precision - scale;

	if (scaleDiff > 0) {
		// Need more decimal places - multiply by 10^scaleDiff
		absValue = absValue * pow10(scaleDiff);
	} else if (scaleDiff < 0) {
		// Need fewer decimal places - divide by 10^|scaleDiff| (truncates)
		absValue = absValue / pow10(-scaleDiff);
	}

	// Convert to string and pad with leading zeros if needed
	let str = absValue.toString();
	if (str.length <= precision) {
		str = str.padStart(precision + 1, '0');
	}

	// Split into integer and decimal parts
	const intPart = str.slice(0, str.length - precision) || '0';
	const decPart = precision > 0 ? str.slice(str.length - precision) : '';

	// Build result
	let result: string;
	if (precision === 0) {
		result = intPart;
	} else if (trim) {
		const trimmedDec = decPart.replace(/0+$/, '');
		result = trimmedDec.length > 0 ? `${intPart}.${trimmedDec}` : intPart;
	} else {
		result = `${intPart}.${decPart}`;
	}

	return negative ? `-${result}` : result;
}
