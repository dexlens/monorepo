/**
/**
 * Base Chain Transfer Fetcher
 * ===========================
 *
 * This module provides functions to interact with the Base (Layer 2, OP Stack) blockchain,
 * specifically to retrieve recent token transfers via the Etherscan API (which also covers Base).
 *
 * Overview:
 *   - Defines the BaseTx interface for standardizing fetched transaction data.
 *   - Implements `getRecentBaseTransfers`, which queries known router contracts (e.g., Uniswap Universal Router, BaseSwap, Aerodrome)
 *     on the Base chain for recent high-value ETH transfers.
 *
 * Usage:
 *   - The module expects a valid `ETHERSCAN_API_KEY` in environment variables.
 *   - `getRecentBaseTransfers(minEthValue)` will fetch and filter recent inbound transfers via known router contracts
 *      for activity above a specified ETH threshold.
 *
 * Dependencies:
 *   - axios: for making HTTP requests to Etherscan's v2 API.
 *   - dotenv: for environment variable management.
 *
 * Example:
 *   const txs = await getRecentBaseTransfers(0.01); // Get recent Base transfers over 0.01 ETH
 *
 * Notes:
 *   - Designed for use in on-chain monitoring bots for DeFi and token launch activity.
 *   - Scans only major router addresses to reduce noise and focus on high-impact swaps.
 */

import axios from "npm:axios";
import dotenv from "npm:dotenv";

dotenv.config();

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const BASE_URL = "https://api.etherscan.io/v2/api"; // Etherscan V2 supports Base

export interface BaseTx {
    hash: string;
    from: string;
    to: string;
    value: string;
    timeStamp: string;
}

export const getRecentBaseTransfers = async (
    minEthValue: number = 0.001,
): Promise<BaseTx[]> => {
    if (!ETHERSCAN_API_KEY) {
        console.error("[BASE] ERROR: ETHERSCAN_API_KEY is missing!");
        return [];
    }

    try {
        const routers = [
            {
                name: "Uniswap Universal Router",
                address: "0x3fC91A3afd70395Cd402dB74D5a07b1673b03318",
            },
            {
                name: "BaseSwap",
                address: "0x327Df1E6de05895d2d21F22129516694F5833942",
            },
            {
                name: "Aerodrome Router",
                address: "0xcF77a3Ba9A5CA399EB73611b51b363D8C803c44b",
            },
        ];

        const results: BaseTx[] = [];

        for (const router of routers) {
            console.log(`[BASE] Scanning ${router.name}...`);
            const response = await axios.get(BASE_URL, {
                params: {
                    chainid: 8453, // Base Chain ID
                    module: "account",
                    action: "txlist",
                    address: router.address,
                    startblock: 0,
                    endblock: 99999999,
                    page: 1,
                    offset: 15,
                    sort: "desc",
                    apikey: ETHERSCAN_API_KEY,
                },
            });

            if (
                response.data.status === "0" &&
                response.data.message !== "No transactions found"
            ) {
                continue;
            }

            const txs = response.data.result;
            if (!txs || !Array.isArray(txs)) continue;

            const filtered = txs
                .filter((tx: any) => {
                    const ethValue = parseFloat(tx.value) / 1e18;
                    return ethValue >= minEthValue;
                })
                .map((tx: any) => ({
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    value: (parseFloat(tx.value) / 1e18).toFixed(4),
                    timeStamp: tx.timeStamp,
                }));

            console.log(
                `[BASE] Found ${filtered.length} matches on ${router.name}.`,
            );
            results.push(...filtered);
        }

        return results;
    } catch (error) {
        console.error("Error fetching Base transactions:", error);
        return [];
    }
};
