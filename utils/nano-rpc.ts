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
	const rpcUrl = typeof credentials.rpcUrl === 'string' ? credentials.rpcUrl.trim() : '';
	if (!rpcUrl) {
		throw new X402PaymentError(
			'The X402 Nano API credential has no RPC URL configured. Set the "RPC URL" field (e.g. https://rpc.nano.to) on the credential.',
		);
	}
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
	confirmedFrontier?: string;
	confirmedBalance?: string;
}

export async function getAccountInfo(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	account: string,
	options: { includeConfirmed?: boolean } = {},
): Promise<NanoAccountInfo> {
	const data = await nanoRpcCall(context, config, 'account_info', {
		account,
		representative: 'true',
		...(options.includeConfirmed ? { include_confirmed: 'true' } : {}),
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
		...(typeof data.confirmed_frontier === 'string'
			? { confirmedFrontier: String(data.confirmed_frontier) }
			: {}),
		...(typeof data.confirmed_balance === 'string'
			? { confirmedBalance: String(data.confirmed_balance) }
			: {}),
	};
}

export interface PendingBlock {
	hash: string;
	amount: string;
	source?: string;
}

/** List confirmed pending receive blocks for an account (sorted, oldest first). */
export async function getPendingBlocks(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	account: string,
	options: { count?: number } = {},
): Promise<PendingBlock[]> {
	const data = await nanoRpcCall(context, config, 'pending', {
		account,
		count: String(options.count ?? 100),
		sorting: 'true',
		threshold: '1',
		source: 'true',
		include_only_confirmed: 'true',
	});
	if (!data.blocks || typeof data.blocks !== 'object' || Array.isArray(data.blocks)) {
		return [];
	}
	return Object.entries(data.blocks as Record<string, unknown>).map(([hash, entry]) => ({
		hash,
		amount: String((entry as Record<string, unknown>).amount ?? '0'),
		...(typeof (entry as Record<string, unknown>).source === 'string'
			? { source: (entry as Record<string, unknown>).source as string }
			: {}),
	}));
}

/**
 * Parse a work_validate RPC response.
 * Nano V27+ answers with `valid_all` (base difficulty) and `valid_receive`
 * (weaker receive tier); older nodes answer with `valid`. x402 payments are
 * always send blocks, so only base-difficulty validity counts — a send with
 * mere receive-tier work would pass validation here but be rejected by
 * `process` ("Invalid work") at settlement.
 */
export function parseWorkValidation(data: Record<string, unknown>): boolean {
	const validAll = String(data.valid_all ?? '');
	const valid = String(data.valid ?? '');
	return (
		validAll === '1' ||
		validAll === 'true' ||
		valid === '1' ||
		valid === 'true'
	);
}

/** Validate proof of work against a root hash (the account frontier). */
export async function validateWork(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	hash: string,
	work: string,
): Promise<boolean> {
	const data = await nanoRpcCall(context, config, 'work_validate', { hash, work });
	return parseWorkValidation(data);
}

export interface NanoBlockInfo {
	hash: string;
	account: string;
	amount?: string;
	subtype?: string;
	confirmed?: boolean;
	link?: string;
	linkAsAccount?: string;
}

/**
 * Fetch details about a block by hash. Returns null when the block does not
 * exist (unknown hash). Used for replay detection and replay matching.
 */
export async function getBlockInfo(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	hash: string,
): Promise<NanoBlockInfo | null> {
	const response = await context.helpers.httpRequestWithAuthentication.call(
		context,
		'x402NanoApi',
		{
			method: 'POST',
			url: config.rpcUrl,
			body: { action: 'block_info', hash, json_block: 'true' },
			json: true,
			timeout: config.timeoutMs,
		},
	);
	if (response?.error) {
		const message = String(response.error);
		if (/not found|unknown/i.test(message)) {
			// The block is not on this node's ledger: not a replay (yet).
			return null;
		}
		throw new X402PaymentError(`Nano RPC error (block_info): ${message}`);
	}

	const data = response as Record<string, unknown>;
	if (typeof data.block_account !== 'string') {
		return null;
	}

	const contentsRaw = data.contents as Record<string, unknown> | string | undefined;
	const contents =
		typeof contentsRaw === 'string' ? (JSON.parse(contentsRaw) as Record<string, unknown>) : contentsRaw;

	return {
		hash,
		account: data.block_account,
		...(typeof data.amount === 'string' ? { amount: data.amount } : {}),
		...(typeof data.subtype === 'string' ? { subtype: data.subtype } : {}),
		...(typeof data.confirmed === 'string'
			? { confirmed: data.confirmed.toLowerCase() === 'true' }
			: {}),
		...(contents && typeof contents.link === 'string' ? { link: contents.link } : {}),
		...(contents && typeof contents.link_as_account === 'string'
			? { linkAsAccount: contents.link_as_account }
			: {}),
	};
}

/** Receive-tier difficulty (Nano V26+): receives are valid at this lower bar. */
export const RECEIVE_WORK_DIFFICULTY = 'fffffff800000000';

/**
 * Generate proof of work for a block hash (previous/frontier). An optional
 * `difficulty` generates tiered work (e.g. the cheaper receive tier); when
 * the node rejects the difficulty parameter or returns an unusable response,
 * the call falls back to base difficulty.
 */
export async function generateWork(
	context: IExecuteFunctions,
	config: NanoRpcConfig,
	hash: string,
	options: { difficulty?: string } = {},
): Promise<string> {
	const target: NanoRpcConfig = config.workServerUrl
		? { ...config, rpcUrl: config.workServerUrl }
		: config;

	if (options.difficulty) {
		try {
			const tiered = await nanoRpcCall(context, target, 'work_generate', {
				hash,
				difficulty: options.difficulty,
			});
			if (typeof tiered.work === 'string' && tiered.work.length === 16) {
				return tiered.work;
			}
		} catch {
			// fall through to base difficulty
		}
	}

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
	// Send only the canonical state-block fields. Derived/convenience fields
	// such as link_as_account are not part of the RPC block schema; some strict
	// nodes reject unknown keys even though mainstream nodes ignore them.
	const canonical: Record<string, unknown> = {};
	for (const key of ['type', 'account', 'previous', 'representative', 'balance', 'link', 'work', 'signature'] as const) {
		if (block[key] !== undefined) {
			canonical[key] = block[key];
		}
	}
	const data = await nanoRpcCall(context, config, 'process', {
		json_block: 'true',
		block: canonical,
	});
	if (typeof data.hash !== 'string' || data.hash.length !== 64) {
		throw new X402PaymentError('Failed to process the payment block on the Nano node.');
	}
	return data.hash;
}
