/**
/**
 * NFT Monitoring Module
 * =====================
 *
 * This module provides functions for monitoring NFT-related on-chain activity,
 * retrieving contract metadata, and tracking NFT mints and transfers.
 *
 * Overview:
 *   - Defines the `NFTActivity` interface for standardizing NFT event data.
 *   - Provides utility to fetch the latest block number on Ethereum (for polling/monitoring).
 *   - Implements `getContractMetadata` for rich NFT collection metadata via Reservoir or other endpoints.
 *
 * Features:
 *   - Monitors NFT contract events (mints, transfers) using Etherscan API for Ethereum.
 *   - Metadata enrichment using Reservoir API endpoints for image, name, banner, and floor price.
 *
 * Usage:
 *   - Requires a valid `ETHERSCAN_API_KEY` in environment variables for on-chain event querying.
 *   - `getLatestBlockNumber()` retrieves the most recent Ethereum block number.
 *   - `getContractMetadata(address)` returns enriched metadata for a given NFT contract.
 *
 * Dependencies:
 *   - axios: For executing HTTP requests.
 *   - dotenv: For loading environment variables (.env).
 *
 * Example:
 *   const blockNumber = await getLatestBlockNumber();
 *   const meta = await getContractMetadata("0x123...");
 *
 * Notes:
 *   - Extend this module with collection-specific activity or filtering logic as needed.
 *   - Designed for use in monitoring bots, alerting dashboards, and NFT analytics.
 */

import axios from "npm:axios";
import dotenv from "npm:dotenv";

dotenv.config();

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const BASE_URL = "https://api.etherscan.io/v2/api";

export interface NFTActivity {
    contractAddress: string;
    from: string;
    to: string;
    tokenId: string;
    transactionHash: string;
    blockNumber: number;
    type: "MINT" | "TRANSFER";
}

export const getLatestBlockNumber = async (): Promise<number> => {
    if (!ETHERSCAN_API_KEY) return 0;
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                chainid: 1,
                module: "proxy",
                action: "eth_blockNumber",
                apikey: ETHERSCAN_API_KEY,
            },
        });
        return parseInt(response.data.result, 16);
    } catch (error) {
        console.error("[NFT] Error fetching block number:", error);
        return 0;
    }
};

export interface NFTMetadata {
    name: string;
    image?: string;
    banner?: string;
    floorPrice?: number;
}

export const getContractMetadata = async (
    address: string,
): Promise<NFTMetadata> => {
    // Try Reservoir First for Rich Data
    const endpoints = [
        `https://api.reservoir.tools/collections/v5?id=${address}`,
        `https://api-ethereum.reservoir.tools/collections/v5?id=${address}`,
    ];

    for (const url of endpoints) {
        try {
            const response = await axios.get(url, {
                timeout: 5000,
                headers: { "User-Agent": "Mozilla/5.0" },
            });
            if (response.data?.collections?.length > 0) {
                const coll = response.data.collections[0];
                return {
                    name: coll.name || "Unknown Collection",
                    image: coll.image,
                    banner: coll.banner,
                    floorPrice: coll.floorAsk?.price?.amount?.decimal,
                };
            }
        } catch (error: any) {
            // Log only if it's not a common DNS or timeout error to keep logs clean
            if (!error.message.includes("ENOTFOUND")) {
                console.warn(`[NFT] Reservoir failed: ${error.message}`);
            }
        }
    }

    // Fallback to Etherscan just for the Name if Reservoir is down/blocked
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                chainid: 1,
                module: "token",
                action: "tokeninfo",
                contractaddress: address,
                apikey: ETHERSCAN_API_KEY,
            },
            timeout: 3000,
        });
        if (response.data?.result?.length > 0) {
            return {
                name: response.data.result[0].tokenName || "Unknown Collection",
            };
        }
    } catch (e) {}

    return { name: "Unknown Collection" };
};

export const getRecentNFTActivity = async (
    fromBlock: number,
): Promise<NFTActivity[]> => {
    if (!ETHERSCAN_API_KEY) {
        console.error("[NFT] ERROR: ETHERSCAN_API_KEY is missing!");
        return [];
    }

    try {
        console.log(`[NFT] Scanning logs from block ${fromBlock}...`);
        const response = await axios.get(BASE_URL, {
            params: {
                chainid: 1,
                module: "logs",
                action: "getLogs",
                fromBlock: fromBlock,
                toBlock: "latest",
                topic0:
                    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
                apikey: ETHERSCAN_API_KEY,
            },
        });

        if (
            response.data.status === "0" &&
            response.data.message !== "No logs found"
        ) {
            return [];
        }

        const logs = response.data.result;
        if (!logs || !Array.isArray(logs)) return [];

        const activities: NFTActivity[] = [];

        for (const log of logs) {
            // ERC-721 Transfer has 4 topics: topic0 (event), topic1 (from), topic2 (to), topic3 (tokenId)
            // ERC-20 Transfer has 3 topics: topic0, topic1, topic2.
            if (log.topics.length === 4) {
                const from = "0x" + log.topics[1].substring(26).toLowerCase();
                const to = "0x" + log.topics[2].substring(26).toLowerCase();
                const tokenId = parseInt(log.topics[3], 16).toString();

                activities.push({
                    contractAddress: log.address.toLowerCase(),
                    from,
                    to,
                    tokenId,
                    transactionHash: log.transactionHash,
                    blockNumber: parseInt(log.blockNumber, 16),
                    type: from === "0x0000000000000000000000000000000000000000"
                        ? "MINT"
                        : "TRANSFER",
                });
            }
        }

        return activities;
    } catch (error) {
        console.error("[NFT] Error fetching NFT logs:", error);
        return [];
    }
};
