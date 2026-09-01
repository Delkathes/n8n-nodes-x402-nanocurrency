import {
	type IAuthenticate,
	type ICredentialDataDecryptedObject,
	type ICredentialTestRequest,
	type ICredentialType,
	type IHttpRequestOptions,
	type INodeProperties,
} from 'n8n-workflow';

export class X402NanoApi implements ICredentialType {
	name = 'x402NanoApi';
	displayName = 'X402 Nano API';
	icon = 'file:x402.svg' as const;
	documentationUrl = 'https://docs.nano.org/commands/rpc-protocol/';
	properties: INodeProperties[] = [
		{
			displayName: 'RPC URL',
			name: 'rpcUrl',
			type: 'string',
			default: 'http://localhost:7076',
			description:
				'URL of your Nano RPC node. For public proxies, e.g. https://rpc.nano.to (requires Bearer auth)',
			placeholder: 'https://rpc.nano.to',
		},
		{
			displayName: 'Authentication Method',
			name: 'authMethod',
			type: 'options',
			options: [
				{
					name: 'None',
					value: 'none',
				},
				{
					name: 'Bearer Token',
					value: 'bearer',
					description: 'Sends an "Authorization: Bearer <token>" header (used by rpc.nano.to)',
				},
				{
					name: 'Basic Auth',
					value: 'basic',
				},
				{
					name: 'API Key Header',
					value: 'apiKey',
				},
			],
			default: 'none',
		},
		{
			displayName: 'Bearer Token',
			name: 'bearerToken',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description:
				'Token sent as "Authorization: Bearer <token>". Required by public proxies like rpc.nano.to',
			displayOptions: {
				show: {
					authMethod: ['bearer'],
				},
			},
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					authMethod: ['basic'],
				},
			},
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			displayOptions: {
				show: {
					authMethod: ['basic'],
				},
			},
		},
		{
			displayName: 'API Key Header Name',
			name: 'headerName',
			type: 'string',
			default: 'Authorization',
			displayOptions: {
				show: {
					authMethod: ['apiKey'],
				},
			},
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			displayOptions: {
				show: {
					authMethod: ['apiKey'],
				},
			},
		},
		{
			displayName: 'Wallet ID',
			name: 'walletId',
			type: 'string',
			default: '',
			description:
				'Nano wallet ID used to sign payments through the node (requires enable_control on your node). Leave empty when signing locally with a private key.',
			placeholder: 'A1B2C3D4E5F6...',
		},
		{
			displayName: 'Source Account',
			name: 'sourceAccount',
			type: 'string',
			default: '',
			description: 'Default Nano account to pay from',
			placeholder: 'nano_1abc...',
		},
		{
			displayName: 'Private Key',
			name: 'privateKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description:
				'Optional 64-character hex private key for local signing (no node wallet required). Takes precedence over the wallet ID when set.',
			placeholder: '9F0E444C...',
		},
		{
			displayName: 'Work Server URL',
			name: 'workServerUrl',
			type: 'string',
			default: '',
			description:
				'Optional dedicated work generation server. Falls back to work_generate on the RPC node.',
			placeholder: 'https://work.example.com',
		},
	];

	authenticate: IAuthenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const authMethod = credentials.authMethod as string;

		if (authMethod === 'bearer' && credentials.bearerToken) {
			requestOptions.headers = {
				...requestOptions.headers,
				Authorization: `Bearer ${credentials.bearerToken}`,
			};
		} else if (authMethod === 'apiKey' && credentials.apiKey) {
			requestOptions.headers = {
				...requestOptions.headers,
				[(credentials.headerName as string) || 'Authorization']: credentials.apiKey as string,
			};
		} else if (authMethod === 'basic') {
			requestOptions.auth = {
				username: credentials.username as string,
				password: credentials.password as string,
			};
		}

		return requestOptions;
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.rpcUrl}}',
			method: 'POST',
			body: {
				action: 'version',
			},
		},
	};
}
