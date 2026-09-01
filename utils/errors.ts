/**
 * Internal error type for x402 payment failures.
 * The node dispatcher wraps these into NodeOperationError for the user.
 */
export class X402PaymentError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = 'X402PaymentError';
		this.statusCode = statusCode;
	}
}
