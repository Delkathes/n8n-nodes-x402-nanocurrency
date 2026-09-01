/**
 * Nano RPC helpers used by the x402 payment flow (zero dependencies).
 * All calls go through the "x402 Nano API" credential so its authentication
 * method (none/bearer/basic/api-key) is applied by n8n automatically.
 */

import type { IExecuteFunctions, ICredentialDataDecryptedObject } from 'n8n-workflow';

import { X402PaymentError } from './errors';

export interface NanoRpcConfig {
	rpcUrl: string;
	timeoutMs: number;
	workServerUrl?: string;
}

export function getNanoRpcConfig(credentials: ICredentialDataDecryptedObject): NanoRpcConfig {
	const rpcUrl = (credentials.rpcUrl as string)?.trim() || 'http://localhost:7076';
	return {
		rpcUrl,
		timeoutMs: 15000,
		...(typeof credentials.workServerUrl === 'string' && credentials.workServerUrl.trim()
			? { workServerUrl: credentials.workServerUrl.trim() }
			: {}),
	};
}

export async function nanoRpcCall(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	action: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const response = await context.helpers.httpRequestWithAuthentication.call(
		context,
		'x402NanoApi',
		{
			method: 'POST',
			url: config.rpcUrl,
			body: { action, ...params },
			json: true,
			timeout: config.timeoutMs,
		},
	);

	if (response?.error) {
		throw new X402PaymentError(`Nano RPC error (${action}): ${String(response.error)}`);
	}
	return response as Record<string, unknown>;
}

export interface NanoAccountInfo {
	frontier: string;
	balance: string;
	representative: string;
}

export async function getAccountInfo(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	account: string,
): Promise<NanoAccountInfo> {
	const data = await nanoRpcCall(context, config, 'account_info', {
		account,
		representative: 'true',
	});
	if (!data.frontier || !data.balance || !data.representative) {
		throw new X402PaymentError(
			`Account ${account} not found on the Nano node. Make sure the paying account is opened and funded.`,
		);
	}
	return {
		frontier: String(data.frontier),
		balance: String(data.balance),
		representative: String(data.representative),
	};
}

/** Generate proof of work for a block hash (previous/frontier). */
export async function generateWork(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	hash: string,
): Promise<string> {
	const target: NanoRpcConfig = config.workServerUrl
		? { ...config, rpcUrl: config.workServerUrl }
		: config;
	const data = await nanoRpcCall(context, target, 'work_generate', { hash });
	if (typeof data.work !== 'string' || data.work.length !== 16) {
		throw new X402PaymentError(
			'Failed to generate proof of work. Configure a work server or use a Nano node with enable_control.',
		);
	}
	return data.work;
}

/** Sign a block hash with a node wallet (requires enable_control). */
export async function signWithWallet(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	walletId: string,
	account: string,
	hash: string,
): Promise<string> {
	const data = await nanoRpcCall(context, config, 'sign', { wallet: walletId, account, hash });
	if (typeof data.signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(data.signature)) {
		throw new X402PaymentError(
			'Failed to sign the payment block with the node wallet. Check the wallet ID and enable_control.',
		);
	}
	return data.signature;
}

/** Process (broadcast) a signed block and return its hash. */
export async function processBlock(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	block: Record<string, unknown>,
): Promise<string> {
	const data = await nanoRpcCall(context, config, 'process', {
		json_block: 'true',
		block,
	});
	if (typeof data.hash !== 'string' || data.hash.length !== 64) {
		throw new X402PaymentError('Failed to process the payment block on the Nano node.');
	}
	return data.hash;
}
