import {
	type IAuthenticateGeneric,
	type ICredentialTestRequest,
	type ICredentialType,
	type INodeProperties,
} from 'n8n-workflow';

export class X402FacilitatorApi implements ICredentialType {
	name = 'x402FacilitatorApi';
	displayName = 'X402 Facilitator API';
	icon = 'file:x402.svg' as const;
	documentationUrl = 'https://x402.org/';
	properties: INodeProperties[] = [
		{
			displayName: 'Facilitator URL',
			name: 'facilitatorUrl',
			type: 'string',
			default: 'http://localhost:5555/facilitator',
			placeholder: 'https://facilitator.example.com',
			description: 'Base URL of the x402 facilitator service (exposes /supported, /verify and /settle)',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description: 'Optional API key for the facilitator (sent as an x-api-key header)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'x-api-key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.facilitatorUrl}}',
			url: '/supported',
			method: 'GET',
		},
	};
}
