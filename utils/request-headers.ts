/**
 * Request header input normalization (zero dependencies).
 *
 * The "Request Headers" node parameter is a JSON field: users can type a
 * plain JSON string or use an expression that evaluates directly to an
 * object (e.g. `={{ {"content-type": "application/json"} }}`). n8n passes
 * expression results through as-is, so the node must accept both shapes.
 */

export type HeaderInputError = { kind: 'invalid'; message: string };

export function normalizeRequestHeaders(
	input: unknown,
): { headers: Record<string, unknown>; error?: HeaderInputError } {
	if (input === undefined || input === null || input === '') {
		return { headers: {} };
	}

	if (typeof input === 'object' && !Array.isArray(input)) {
		return { headers: input as Record<string, unknown> };
	}

	if (typeof input === 'string') {
		const trimmed = input.trim();
		if (trimmed.length === 0) {
			return { headers: {} };
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return { headers: parsed as Record<string, unknown> };
			}
			return {
				headers: {},
				error: { kind: 'invalid', message: 'Headers must be a valid JSON object' },
			};
		} catch {
			return {
				headers: {},
				error: { kind: 'invalid', message: 'Headers must be a valid JSON object' },
			};
		}
	}

	return { headers: {} };
}
