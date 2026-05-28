/**
 * Dexscreener API Integration for Onchain Monitoring
 * ==================================================
 *
 * This module provides interfaces and utilities to interact with the Dexscreener API
 * for fetching real-time token metadata and market data, supporting onchain monitoring activities.
 *
 * Key Features:
 *   - Defines the `DexTokenInfo` interface describing standardized metadata for tokens.
 *   - Implements batching and proxy logic to reliably fetch token data under network or rate constraints.
 *   - Provides rate limiting for outgoing requests to prevent API throttling.
 *   - Integrates with support modules (such as proxyManager) to utilize rotating HTTP proxies.
 *
 * Main Exports:
 *   - `DexTokenInfo`: Structure containing normalized token market and social data.
 *   - `getNextProxyAgent()`: Asynchronously returns a proxy agent and proxy string for network requests.
 *
 * Usage:
 *   - Used by onchain monitoring and filtering logic to enrich token signals
 *     with up-to-date marketcap, liquidity, volume, and additional metadata.
 *   - Core to health reporting, alerting, and bot functionality which relies on accurate token state.
 *
 * Dependencies:
 *   - axios for HTTP requests.
 *   - proxyManager module for dynamic proxy management.
 *   - https-proxy-agent for networking support.
 *
 * Notes:
 *   - Adapts to manual or automated proxy lists as provided in environment variables.
 *   - Returns consistent and reliable token data for downstream modules and alert pipelines.
 */

import axios from "npm:axios";
import { getAutoProxies, removeProxy } from "./proxyManager.ts";

const DEXSCREENER_API_BASE = "https://api.dexscreener.com/latest/dex/tokens";

const MANUAL_PROXIES = (process.env.DEX_PROXIES || "").split(",").map((p) =>
    p.trim()
).filter((p) => p.length > 0);
let currentProxyIndex = 0;

const getNextProxyAgent = async (): Promise<
    { agent: any; proxy: string | null }
> => {
    const proxyList = await getAutoProxies();

    if (proxyList.length === 0) return { agent: null, proxy: null };

    const proxy = proxyList[currentProxyIndex % proxyList.length];
    currentProxyIndex++;

    try {
        const { HttpsProxyAgent } = await import("https-proxy-agent");
        // Webshare and others often use username:password@ip:port format
        // If the string already contains '@', it's already in the correct format
        // Otherwise, we assume it's ip:port and prefix with http://
        const proxyUrl = proxy.includes("@")
            ? `http://${proxy}`
            : `http://${proxy}`;
        return { agent: new HttpsProxyAgent(proxyUrl), proxy };
    } catch (e) {
        console.error("[DEX] Proxy agent error:", e);
        return { agent: null, proxy: null };
    }
};

export interface DexTokenInfo {
    address: string;
    symbol: string;
    name: string;
    mcap: number;
    liquidity: number;
    priceUsd: string;
    url: string;
    volume5m: number;
    pairCreatedAt: number;
    icon?: string;
    header?: string;
    labels?: string[];
    websites?: { label: string; url: string }[];
    socials?: { type: string; url: string }[];
}

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 500;

export const getTokenMetadata = async (
    tokenAddress: string,
): Promise<DexTokenInfo | null> => {
    const { agent, proxy } = await getNextProxyAgent();
    try {
        const now = Date.now();
        const timeSinceLast = now - lastRequestTime;
        if (timeSinceLast < MIN_REQUEST_INTERVAL_MS) {
            await new Promise((resolve) =>
                setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - timeSinceLast)
            );
        }
        lastRequestTime = Date.now();

        const response = await axios.get(
            `${DEXSCREENER_API_BASE}/${tokenAddress}`,
            {
                httpsAgent: agent,
                proxy: false,
                timeout: 15000,
            },
        );

        if (
            !response.data || !response.data.pairs ||
            response.data.pairs.length === 0
        ) {
            return null;
        }

        const pair = response.data.pairs.sort((a: any, b: any) =>
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];

        return {
            address: tokenAddress,
            symbol: pair.baseToken.symbol,
            name: pair.baseToken.name,
            mcap: Math.max(pair.fdv || 0, pair.marketCap || 0),
            liquidity: pair.liquidity?.usd || 0,
            priceUsd: pair.priceUsd,
            url: pair.url,
            volume5m: pair.volume?.m5 || 0,
            pairCreatedAt: pair.pairCreatedAt || 0,
            icon: pair.info?.imageUrl,
            header: pair.info?.header,
            labels: pair.labels || [],
            websites: pair.info?.websites || [],
            socials: pair.info?.socials || [],
        };
    } catch (error: any) {
        if (
            proxy &&
            (error.code === "ECONNABORTED" || error.code === "ECONNRESET" ||
                error.response?.status >= 500)
        ) {
            removeProxy(proxy);
        }

        if (error.response?.status === 429) {
            console.error(`[DEX] Rate limited by DexScreener!`);
        } else if (
            error.code === "ECONNABORTED" || error.code === "ECONNRESET" ||
            error.response?.status >= 500
        ) {
            console.warn(
                `[DEX] Proxy/API failed for ${tokenAddress}, retrying direct...`,
            );
            try {
                const directResp = await axios.get(
                    `${DEXSCREENER_API_BASE}/${tokenAddress}`,
                    { timeout: 10000 },
                );
                if (directResp.data && directResp.data.pairs) {
                    const pair = directResp.data.pairs.sort((a: any, b: any) =>
                        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
                    )[0];
                    return {
                        address: tokenAddress,
                        symbol: pair.baseToken.symbol,
                        name: pair.baseToken.name,
                        mcap: Math.max(pair.fdv || 0, pair.marketCap || 0),
                        liquidity: pair.liquidity?.usd || 0,
                        priceUsd: pair.priceUsd,
                        url: pair.url,
                        volume5m: pair.volume?.m5 || 0,
                        pairCreatedAt: pair.pairCreatedAt || 0,
                        icon: pair.info?.imageUrl,
                        header: pair.info?.header,
                        labels: pair.labels || [],
                        websites: pair.info?.websites || [],
                        socials: pair.info?.socials || [],
                    };
                }
            } catch (inner) {}
        }
        return null;
    }
};

export const getBatchTokenMetadata = async (
    addresses: string[],
): Promise<Record<string, DexTokenInfo>> => {
    if (addresses.length === 0) return {};

    try {
        const results: Record<string, DexTokenInfo> = {};
        const chunkSize = 30;

        for (let i = 0; i < addresses.length; i += chunkSize) {
            const chunk = addresses.slice(i, i + chunkSize);
            const { agent, proxy } = await getNextProxyAgent();

            try {
                const response = await axios.get(
                    `${DEXSCREENER_API_BASE}/${chunk.join(",")}`,
                    {
                        httpsAgent: agent,
                        proxy: false,
                        timeout: 20000,
                    },
                );

                if (response.data && response.data.pairs) {
                    for (const pair of response.data.pairs) {
                        const addr = pair.baseToken.address.toLowerCase();
                        if (
                            results[addr] &&
                            (results[addr].liquidity || 0) >
                                (pair.liquidity?.usd || 0)
                        ) {
                            continue;
                        }

                        results[addr] = {
                            address: addr,
                            symbol: pair.baseToken.symbol,
                            name: pair.baseToken.name,
                            mcap: Math.max(pair.fdv || 0, pair.marketCap || 0),
                            liquidity: pair.liquidity?.usd || 0,
                            priceUsd: pair.priceUsd,
                            url: pair.url,
                            volume5m: pair.volume?.m5 || 0,
                            pairCreatedAt: pair.pairCreatedAt || 0,
                            labels: pair.labels || [],
                            websites: pair.info?.websites || [],
                            socials: pair.info?.socials || [],
                        };
                    }
                }
            } catch (chunkErr: any) {
                if (proxy) removeProxy(proxy);
                console.warn(
                    `[DEX] Batch chunk failed via proxy, retrying direct...`,
                );
                try {
                    const response = await axios.get(
                        `${DEXSCREENER_API_BASE}/${chunk.join(",")}`,
                        {
                            timeout: 15000,
                        },
                    );
                    if (response.data && response.data.pairs) {
                        for (const pair of response.data.pairs) {
                            const addr = pair.baseToken.address.toLowerCase();
                            if (
                                results[addr] &&
                                (results[addr].liquidity || 0) >
                                    (pair.liquidity?.usd || 0)
                            ) {
                                continue;
                            }

                            results[addr] = {
                                address: addr,
                                symbol: pair.baseToken.symbol,
                                name: pair.baseToken.name,
                                mcap: Math.max(
                                    pair.fdv || 0,
                                    pair.marketCap || 0,
                                ),
                                liquidity: pair.liquidity?.usd || 0,
                                priceUsd: pair.priceUsd,
                                url: pair.url,
                                volume5m: pair.volume?.m5 || 0,
                                pairCreatedAt: pair.pairCreatedAt || 0,
                                labels: pair.labels || [],
                                websites: pair.info?.websites || [],
                                socials: pair.info?.socials || [],
                            };
                        }
                    }
                } catch (innerErr) {
                    console.error(`[DEX] Batch chunk direct retry failed.`);
                }
            }

            if (i + chunkSize < addresses.length) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }

        return results;
    } catch (error) {
        console.error("[DEX] Batch fetch error:", error);
        return {};
    }
};
