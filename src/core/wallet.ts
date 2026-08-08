import {
    createWalletClient,
    createPublicClient,
    http,
    type WalletClient,
    type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { ENV } from '../config/env.config';

function getAccount() {
    const rawKey = ENV.WALLET_PRIVATE_KEY;
    if (!rawKey || rawKey === '') {
        throw new Error('[wallet] WALLET_PRIVATE_KEY is not set. Add it to your .env file.');
    }
    if (!rawKey.startsWith('0x')) {
        throw new Error('[wallet] WALLET_PRIVATE_KEY must start with 0x.');
    }
    return privateKeyToAccount(rawKey as `0x${string}`);
}

// ── Singleton clients ─────────────────────────────────────────────────────────
// Created once, reused everywhere. No MetaMask. No human approval.

let _walletClient: WalletClient | null = null;
let _publicClient: PublicClient | null = null;

/**
 * Returns a viem WalletClient backed by WALLET_PRIVATE_KEY.
 * Singleton — safe to call multiple times.
 */
export function getWalletClient(): WalletClient {
    if (!_walletClient) {
        _walletClient = createWalletClient({
            account: getAccount(),
            chain: baseSepolia,
            transport: http(ENV.BASE_SEPOLIA_RPC_URL),
        });
    }
    return _walletClient;
}

/**
 * Returns a viem PublicClient connected to Base Sepolia.
 * Used by escrow.ts for reading contract state.
 * Singleton — safe to call multiple times.
 */
export function getPublicClient(): PublicClient {
    if (!_publicClient) {
        _publicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(ENV.BASE_SEPOLIA_RPC_URL),
        });
    }
    return _publicClient;
}

/**
 * Returns the wallet address derived from WALLET_PRIVATE_KEY.
 */
export function getWalletAddress(): string {
    return getAccount().address;
}

/**
 * Returns the ETH balance (in wei as bigint) for the given address.
 * Defaults to the agent's own wallet address if none is provided.
 */
export async function getBalance(address?: string): Promise<bigint> {
    const client = getPublicClient();
    const target = (address ?? getAccount().address) as `0x${string}`;
    return client.getBalance({ address: target });
}
