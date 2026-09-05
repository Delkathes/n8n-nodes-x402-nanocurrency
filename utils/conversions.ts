/**
 * Nano unit conversions (NANO <-> raw) built on BigInt arithmetic.
 * 1 NANO = 10^30 raw.
 */

import NanoConverter from './nano-converter';
import { X402PaymentError } from './errors';

/**
 * Canonicalize a wire amount into a raw-unit decimal string. Accepts either a
 * digits-only string or a non-negative safe integer. Rejects floats, negative
 * values, numbers beyond 2^53-1 and non-numeric input — raw amounts larger
 * than Number.MAX_SAFE_INTEGER would otherwise be silently rounded.
 */
export function toAmountRaw(value: unknown): string {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new X402PaymentError(
				`Invalid raw amount "${value}": raw amounts must be a non-negative integer within the safe integer range`,
			);
		}
		return BigInt(value).toString();
	}
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
		return value.trim();
	}
	throw new X402PaymentError(
		`Invalid raw amount "${String(value)}": expected an unsigned decimal integer string`,
	);
}

export function isValidNanoAmount(amount: string): boolean {
	if (typeof amount !== 'string') {
		return false;
	}
	const trimmed = amount.trim();
	if (!/^\d+(\.\d{1,30})?$/.test(trimmed)) {
		return false;
	}
	const [intPart, decPart] = trimmed.split('.');
	return BigInt(intPart) > 0n || (decPart !== undefined && /[1-9]/.test(decPart));
}

/** Convert NANO (decimal string, up to 30 decimals) to raw units. */
export function nanoToRaw(nano: string): string {
	const trimmed = (nano ?? '').trim();
	if (!isValidNanoAmount(trimmed)) {
		throw new Error(
			`Invalid NANO amount "${nano}": expected a positive decimal string with up to 30 decimal places`,
		);
	}
	return NanoConverter.convert(trimmed, 'NANO', 'RAW');
}

/** Convert raw units to NANO (full 30-decimal precision). */
export function rawToNano(raw: string): string {
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
		throw new Error(`Invalid raw amount "${raw}": expected an unsigned decimal string`);
	}
	return NanoConverter.convert(raw, 'RAW', 'NANO');
}
