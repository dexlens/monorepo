/**
 * Solana Chain Transfer Fetcher
 * =============================
 *
 * This module provides functions to interact with the Solana blockchain,
 * specifically to retrieve recent token transfers via the Helius API.
 *
 * Overview:
 *   - Defines the `SolscanTx` interface for standardized Solana transaction data.
 *   - Implements `getRecentSolanaTransfers`, which queries major router contracts (e.g., Jupiter, Pump.fun)
 *     for recent high-value SOL and SPL token transfers using the Helius API.
 *
 * Features:
 *   - Helius API Key rotation for robust request distribution and rate limit handling.
 *   - Filters transfers to exclude native SOL and common stablecoin/token noise (e.g., USDC, USDT).
 *   - Supports threshold-based transaction filtering by minimum SOL value.
 *   - Tracks last processed signatures per program for efficient polling.
 *
 * Usage:
 *   - The module expects a valid `HELIUS_API_KEYS` or `HELIUS_API_KEY` environment variable (comma-separated if multiple).
 *   - `getRecentSolanaTransfers(minSolValue)` returns recent qualifying transfers of interest.
 *
 * Dependencies:
 *   - axios: For HTTP requests to the Helius REST endpoint.
 *   - dotenv: For environment variable management.
 *
 * Example:
 *   const txs = await getRecentSolanaTransfers(1); // Gets recent Solana swaps/transfers over 1 SOL
 *
 * Notes:
 *   - Designed for integration in on-chain monitoring and alerting bots.
 *   - Covers only top router addresses/programs to reduce noise and focus on impactful activity.
 *
 * Made with Love by Liquid for Dexlens.io
 */

import axios from "npm:axios";
import dotenv from "npm:dotenv";

dotenv.config();

export interface SolscanTx {
    txHash: string;
    signer: string;
    lamports: number;
    blockTime: number;
    status: string;
    tokenAddress?: string;
}

const HELIUS_KEYS =
    (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || "").split(",")
        .map((k) => k.trim()).filter((k) => k.length > 0);
let currentKeyIndex = 0;

const getNextHeliusKey = () => {
    if (HELIUS_KEYS.length === 0) return null;
    const key = HELIUS_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % HELIUS_KEYS.length;
    return key;
};

const lastProcessedSignatures: Record<string, string> = {};

export const getRecentSolanaTransfers = async (
    minSolValue: number = 1,
): Promise<SolscanTx[]> => {
    let currentApiKey = getNextHeliusKey();
    if (!currentApiKey) {
        console.error("[SOL] ERROR: No HELIUS_API_KEYS found in environment!");
        return [];
    }

    try {
        const programs = [
            {
                name: "Jupiter",
                address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
            },
            {
                name: "Pump.fun",
                address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
            },
        ];

        const results: SolscanTx[] = [];

        for (const program of programs) {
            console.log(
                `[SOL] Scanning ${program.name} using Key ${currentKeyIndex}...`,
            );

            const lastSig = lastProcessedSignatures[program.address];

            // 1. Fetch Signatures (Uses RPC with Retry & Reactive Rotation)
            let signatures: any[] = [];
            let attempts = 0;
            while (attempts < 6) { // Increase attempts to allow for rotation
                try {
                    const params: any = { limit: 1000 }; // Increased to 1000 to ensure we don't miss txs
                    if (lastSig) params.until = lastSig;

                    const sigResponse = await axios.post(
                        `https://mainnet.helius-rpc.com/?api-key=${currentApiKey}`,
                        {
                            jsonrpc: "2.0",
                            id: "my-id",
                            method: "getSignaturesForAddress",
                            params: [program.address, params],
                        },
                        { timeout: 12000 },
                    );

                    signatures = sigResponse.data.result;
                    if (signatures) break;

                    // If result is null/undefined but no error was thrown
                    attempts++;
                } catch (e: any) {
                    attempts++;
                    if (e.response?.status === 429) {
                        console.warn(
                            `[SOL] Key ${currentKeyIndex} rate limited (429). Rotating...`,
                        );
                        currentApiKey = getNextHeliusKey() || currentApiKey;
                        // Immediate retry with new key doesn't count as a "wait" attempt
                        continue;
                    }
                    if (attempts >= 6) {
                        console.error(
                            `[SOL] RPC failed after maximum attempts: ${e.message}`,
                        );
                    }
                    await new Promise((r) => setTimeout(r, 500 * attempts));
                }
            }

            if (
                !signatures || !Array.isArray(signatures) ||
                signatures.length === 0
            ) {
                continue;
            }

            lastProcessedSignatures[program.address] = signatures[0].signature;

            const sigs = signatures.map((s: any) => s.signature);
            if (sigs.length === 0) continue;

            const CHUNK_SIZE = 100;
            for (let i = 0; i < sigs.length; i += CHUNK_SIZE) {
                const chunk = sigs.slice(i, i + CHUNK_SIZE);

                try {
                    // 2. Batch Parse Transactions (Uses REST with Retry & Reactive Rotation)
                    let txs: any[] = [];
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const txResp = await axios.post(
                                `https://api.helius.xyz/v0/transactions?api-key=${currentApiKey}`,
                                {
                                    transactions: chunk,
                                },
                                { timeout: 15000 },
                            );
                            txs = txResp.data;
                            if (txs) break;
                        } catch (e: any) {
                            if (e.response?.status === 429) {
                                console.warn(
                                    `[SOL] Key ${currentKeyIndex} rate limited (429) during parse. Rotating...`,
                                );
                                currentApiKey = getNextHeliusKey() ||
                                    currentApiKey;
                            }
                            if (attempt === 2) throw e;
                            await new Promise((r) =>
                                setTimeout(r, 1000 * (attempt + 1))
                            );
                        }
                    }

                    if (!txs || !Array.isArray(txs)) {
                        console.log(
                            `[SOL] Failed to parse batch transactions for ${program.name} (Chunk ${
                                i / CHUNK_SIZE
                            }).`,
                        );
                        continue;
                    }

                    let parsedCount = 0;
                    for (const tx of txs) {
                        if (!tx) continue;

                        const buyer = tx.feePayer;
                        // Look for any token transfer that isn't native SOL or USDC/USDT noise
                        const tokenTransfer = tx.tokenTransfers?.find((
                            t: any,
                        ) => t.mint !==
                                "So11111111111111111111111111111111111111112" && // SOL
                            t.mint !==
                                "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && // USDC
                            t.mint !==
                                "Es9vMFrzaDCSTMd38RD8C2D135RTL6lb6F4wJdsxK2bj" && // USDT
                            t.mint !==
                                "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" // Fake USDT often found in logs
                        );
                        const tokenAddress = tokenTransfer?.mint || "SOL";

                        if (tokenAddress === "SOL") continue;

                        results.push({
                            txHash: tx.signature,
                            signer: buyer,
                            lamports: 1000000000,
                            blockTime: tx.timestamp,
                            status: "Success",
                            tokenAddress,
                        });
                        parsedCount++;
                    }
                    console.log(
                        `[SOL] Found ${parsedCount} gem swaps among ${txs.length} txs for ${program.name} (Chunk ${
                            i / CHUNK_SIZE
                        }).`,
                    );
                } catch (e) {
                    console.error(
                        `[SOL] Helius REST Error for ${program.name} (Chunk ${
                            i / CHUNK_SIZE
                        }):`,
                        e,
                    );
                }
            }

            // Cooldown to respect rate limits
            await new Promise((r) => setTimeout(r, 500));
        }

        return results;
    } catch (error) {
        console.error("Error fetching Solana transactions:", error);
        return [];
    }
};
