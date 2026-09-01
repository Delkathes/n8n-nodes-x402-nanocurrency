import { describe, expect, it } from 'vitest';

import { X402Nano } from '../nodes/X402Nano/X402Nano.node';
import { X402NanoTrigger } from '../nodes/X402Nano/X402NanoTrigger.node';
import { X402FacilitatorApi } from '../credentials/X402FacilitatorApi.credentials';
import { X402NanoApi } from '../credentials/X402NanoApi.credentials';

describe('scaffold', () => {
	it('exports the client node description', () => {
		expect(new X402Nano().description.name).toBe('x402Nano');
	});

	it('exports the trigger node description', () => {
		expect(new X402NanoTrigger().description.name).toBe('x402NanoTrigger');
	});

	it('declares the expected credentials on the client node', () => {
		const names = (new X402Nano().description.credentials ?? [])
			.map((credential) => credential.name)
			.sort();
		expect(names).toEqual(['x402FacilitatorApi', 'x402NanoApi'].sort());
	});

	it('registers the credential types', () => {
		expect(new X402FacilitatorApi().name).toBe('x402FacilitatorApi');
		expect(new X402NanoApi().name).toBe('x402NanoApi');
	});
});
