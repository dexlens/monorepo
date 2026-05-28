/**
 * Onchain Monitoring Filtering Logic
 * ==================================
 *
 * This module implements the core filtering, alerting, and state-tracking logic for the onchain monitoring bot.
 * It handles real-time signals for both tokens and NFTs, applies config-based filters, and manages
 * deduplication as well as user notifications.
 *
 * Key Responsibilities:
 *   - Maintains state for token and NFT "swarm" detection over configurable windows.
 *   - Applies volume, marketcap, liquidity and social gating based on loaded configuration.
 *   - Filters or ignores specific contracts (e.g., Uniswap LP/NFT contracts) and bonding curve tokens if configured.
 *   - Integrates with auxiliary modules (Solana, NFTs, Dexscreener) for data enrichment.
 *   - Sends alerts via Telegraf with dynamically assembled inline buttons and context.
 *   - Performs periodic state cleanup to remove stale tokens/NFTs.
 *
 * Core Constructs:
 *   - `CONFIG`: The loaded bot configuration controlling tradeoffs and gating.
 *   - `swarmState` & `nftSwarmState`: Track activity bursts (unique buyers/minters) for each token/NFT.
 *   - `processedHashes`: Deduplicates transactions/events.
 *   - `alertedTokensToday`: Prevents redundant alerts per day.
 *   - `IGNORE_NFT_CONTRACTS`: Blocklist for known irrelevant NFTs.
 *
 * Exposed API:
 *   - `loadConfig()`: Fetches and applies latest configuration from backend or env.
 *
 * Notes:
 *   - Designed for use in bots or monitoring services focused on surfacing high-signal early activity
 *     and pumping tokens/NFTs on Ethereum and Solana.
 *   - Composable – can be extended with new chains or filtering paradigms as needed.
 */

import type { SolscanTx } from "./solana.ts";
import type { NFTActivity } from "./nfts.ts";
import { getContractMetadata } from "./nfts.ts";
import { DexTokenInfo, getTokenMetadata } from "./dexscreener.ts";
import { BotConfig, formatMcap, getBotConfig, logRunner } from "./stats.ts";
import { Markup } from "npm:telegraf";
import { sendAlert } from "./bot.ts";
import dotenv from "npm:dotenv";
import { BaseTx } from "./base.ts";

dotenv.config();

let CONFIG: BotConfig = {
    swarmThreshold: 8,
    swarmWindowMs: 300000,
    minMcap: 25000,
    maxMcap: 150000,
    maxLiquidity: 100000,
    nftEnabled: true,
    ignoreBonding: false,
};

export const loadConfig = async () => {
    CONFIG = await getBotConfig();
    console.log("[CONFIG] Loaded settings:", CONFIG);
};

const processedHashes = new Set<string>();
const alertedTokensToday = new Set<string>();

const IGNORE_NFT_CONTRACTS = new Set([
    "0xc36442b4a4522e871399cd717abdd847ab11fe88", // Uniswap V3 Positions NFT
    "0x2946929344692c222723e9903a518c43f72b59c1", // Uniswap V3 Positions (Alternative)
    "0x1f98431c8ad98523631ae4a59f267346ea31f984", // Uniswap V4
    "0x4976a4D39B8F421D8c42bF8863A2938174548d88", // Uniswap V4 LP
]);

const swarmState: Record<string, {
    uniqueBuyers: Set<string>;
    buyTimestamps: Set<number>;
    lastCheck: number;
    lastApiCheck: number;
    metadata?: DexTokenInfo;
}> = {};
const nftSwarmState: Record<
    string,
    { uniqueMinters: Set<string>; lastCheck: number }
> = {};
const nftBuySwarmState: Record<
    string,
    { uniqueBuyers: Set<string>; lastCheck: number }
> = {};

export const filterAndProcessBase = async (txs: BaseTx[]) => {
    for (const tx of txs) {
        if (processedHashes.has(tx.hash)) continue;
        processedHashes.add(tx.hash);
        const target = tx.to.toLowerCase();
        if (target.length > 20 && target !== "0x") {
            await updateSwarmAndCheck(target, tx.from.toLowerCase(), "BASE");
        }
    }
    return [];
};

export const filterAndProcessSol = async (txs: SolscanTx[]) => {
    for (const tx of txs) {
        if (processedHashes.has(tx.txHash)) continue;
        processedHashes.add(tx.txHash);
        const tokenAddress = (tx as any).tokenAddress;
        if (tokenAddress && tokenAddress !== "SOL") {
            await updateSwarmAndCheck(tokenAddress, tx.signer, "SOL");
        }
    }
    return [];
};

export const filterAndProcessNFTs = async (activities: NFTActivity[]) => {
    const txGroups: Record<string, NFTActivity[]> = {};

    for (const act of activities) {
        if (IGNORE_NFT_CONTRACTS.has(act.contractAddress.toLowerCase())) {
            continue;
        }

        if (!txGroups[act.transactionHash]) txGroups[act.transactionHash] = [];
        txGroups[act.transactionHash].push(act);

        // Process Mints for Degen Detection
        if (act.type === "MINT") {
            await updateNFTSwarmAndCheck(act.contractAddress, act.to);
        } else if (act.type === "TRANSFER") {
            // Process Secondary Buys for Swarm Detection
            await updateNFTBuySwarmAndCheck(act.contractAddress, act.to);
        }
    }

    // Process Sweeps
    for (const [hash, acts] of Object.entries(txGroups)) {
        if (processedHashes.has(hash)) continue;

        // A sweep is multiple transfers of the same contract in one TX
        const contractCounts: Record<string, number> = {};
        acts.forEach((a) => {
            if (a.type === "TRANSFER") {
                contractCounts[a.contractAddress] =
                    (contractCounts[a.contractAddress] || 0) + 1;
            }
        });

        for (const [address, count] of Object.entries(contractCounts)) {
            if (count >= 8) { // 8 or more is a sweep
                processedHashes.add(hash);

                const meta = await getContractMetadata(address);

                let message =
                    `🛒 [OpenSea Preview](https://opensea.io/assets/ethereum/${address})\n\n` +
                    `🧹 *NFT SWEEP DETECTED*\n\n` +
                    `📦 Collection: *${meta.name}*\n` +
                    `📜 Address: \`${address}\`\n` +
                    `👤 Buyer: \`${acts[0].to}\`\n` +
                    `🔢 Amount: ${count} NFTs\n`;

                if (meta.floorPrice) {
                    message += `💰 Floor Price: ${
                        meta.floorPrice.toFixed(3)
                    } ETH\n`;
                }

                message +=
                    `\n🔗 [Etherscan](https://etherscan.io/address/${address})\n` +
                    `🧾 [Transaction](https://etherscan.io/tx/${hash})`;

                await sendAlert(message, {
                    thumb: meta.image,
                    img: meta.banner || meta.image, // Use banner if available, else fallback to image for large preview
                }, "NFT");
                await logRunner({
                    name: meta.name,
                    symbol: address,
                    address: address,
                    sector: "NFT",
                    mcap: 0,
                    priceUsd: meta.floorPrice?.toString() || "0",
                    timestamp: Date.now(),
                    chain: "ETH",
                });
            }
        }
    }
};

const updateNFTSwarmAndCheck = async (
    contractAddress: string,
    minter: string,
) => {
    if (!CONFIG.nftEnabled) return;
    if (IGNORE_NFT_CONTRACTS.has(contractAddress.toLowerCase())) return;
    const now = Date.now();
    if (!nftSwarmState[contractAddress]) {
        nftSwarmState[contractAddress] = {
            uniqueMinters: new Set(),
            lastCheck: now,
        };
    }
    const state = nftSwarmState[contractAddress]!;

    if (now - state.lastCheck > CONFIG.swarmWindowMs) {
        state.uniqueMinters.clear();
        state.lastCheck = now;
    }
    state.uniqueMinters.add(minter);

    if (state.uniqueMinters.size >= CONFIG.swarmThreshold + 2) {
        if (alertedTokensToday.has(contractAddress)) return;

        const meta = await getContractMetadata(contractAddress);

        let message =
            `🛒 [OpenSea Preview](https://opensea.io/assets/ethereum/${contractAddress})\n\n` +
            `🔥 *DEGEN NFT MINT DETECTED*\n\n` +
            `📦 Collection: *${meta.name}*\n` +
            `📜 Contract: \`${contractAddress}\`\n` +
            `👥 Activity: ${state.uniqueMinters.size} unique minters in 5m\n` +
            `🚀 *Status: Pumping* 📈\n`;

        if (meta.floorPrice) {
            message += `💰 Floor Price: ${meta.floorPrice.toFixed(3)} ETH\n`;
        }

        message +=
            `\n🔗 [Etherscan](https://etherscan.io/address/${contractAddress})`;

        await sendAlert(message, {
            thumb: meta.image,
            img: meta.banner || meta.image,
        }, "NFT");
        await logRunner({
            name: meta.name,
            symbol: contractAddress,
            address: contractAddress,
            sector: "NFT",
            mcap: 0,
            priceUsd: meta.floorPrice?.toString() || "0",
            timestamp: now,
            chain: "ETH",
        });
        alertedTokensToday.add(contractAddress);
    }
};

const updateNFTBuySwarmAndCheck = async (
    contractAddress: string,
    buyer: string,
) => {
    if (!CONFIG.nftEnabled) return;
    if (IGNORE_NFT_CONTRACTS.has(contractAddress.toLowerCase())) return;
    const now = Date.now();
    if (!nftBuySwarmState[contractAddress]) {
        nftBuySwarmState[contractAddress] = {
            uniqueBuyers: new Set(),
            lastCheck: now,
        };
    }
    const state = nftBuySwarmState[contractAddress]!;

    if (now - state.lastCheck > CONFIG.swarmWindowMs) {
        state.uniqueBuyers.clear();
        state.lastCheck = now;
    }
    state.uniqueBuyers.add(buyer);

    if (state.uniqueBuyers.size >= CONFIG.swarmThreshold) {
        if (alertedTokensToday.has(contractAddress)) return;

        const meta = await getContractMetadata(contractAddress);

        let message =
            `🛒 [OpenSea Preview](https://opensea.io/assets/ethereum/${contractAddress})\n\n` +
            `🌊 *NFT COLLECTION SWARM* 🌊\n\n` +
            `📦 Collection: *${meta.name}*\n` +
            `📜 Address: \`${contractAddress}\`\n` +
            `👥 Activity: ${state.uniqueBuyers.size} unique buyers in 5m\n` +
            `🔥 *Status: Trending* 📈\n`;

        if (meta.floorPrice) {
            message += `💰 Floor Price: ${meta.floorPrice.toFixed(3)} ETH\n`;
        }

        message +=
            `\n🔗 [Etherscan](https://etherscan.io/address/${contractAddress})`;

        await sendAlert(message, {
            thumb: meta.image,
            img: meta.banner || meta.image,
        }, "NFT");
        await logRunner({
            name: meta.name,
            symbol: contractAddress,
            address: contractAddress,
            sector: "NFT",
            mcap: 0,
            priceUsd: meta.floorPrice?.toString() || "0",
            timestamp: now,
            chain: "ETH",
        });
        alertedTokensToday.add(contractAddress);
    }
};

const updateSwarmAndCheck = async (
    tokenAddress: string,
    buyer: string,
    chain: string,
) => {
    const now = Date.now();
    if (!swarmState[tokenAddress]) {
        swarmState[tokenAddress] = {
            uniqueBuyers: new Set(),
            buyTimestamps: new Set(),
            lastCheck: now,
            lastApiCheck: 0,
        };
    }
    const state = swarmState[tokenAddress]!;

    if (now - state.lastCheck > CONFIG.swarmWindowMs) {
        state.uniqueBuyers.clear();
        state.buyTimestamps.clear();
        state.lastCheck = now;
    }
    state.uniqueBuyers.add(buyer);
    state.buyTimestamps.add(now);

    if (state.uniqueBuyers.size >= CONFIG.swarmThreshold) {
        if (alertedTokensToday.has(tokenAddress)) return;

        // ANTI-BUNDLE (Cluster Detection)
        // If all buyers bought in the exact same polling cycle (timestamp)
        // it's highly likely to be a single entity bundling with multiple wallets.
        if (
            chain === "SOL" && state.buyTimestamps.size === 1 &&
            state.uniqueBuyers.size >= CONFIG.swarmThreshold
        ) {
            console.log(
                `[FILTER] Skipping ${tokenAddress} - Likely heavily bundled (All buys in 1 cluster)`,
            );
            return;
        }

        // Only fetch metadata if 60s has passed since the LAST API attempt
        // This prevents 50+ redundant calls in 1 second during a heavy cycle.
        if (now - state.lastApiCheck > 60000) {
            state.lastApiCheck = now;
            const meta = await getTokenMetadata(tokenAddress);
            if (meta) state.metadata = meta;
        }

        if (!state.metadata) {
            console.warn(
                `[FILTER] Skipping ${tokenAddress} - No metadata found (Indexing or Rate Limited).`,
            );
            return;
        }

        const mcap = state.metadata.mcap;
        const vol5m = state.metadata.volume5m || 0;
        const hasSocials = (state.metadata.websites?.length || 0) > 0 ||
            (state.metadata.socials?.length || 0) > 0;
        const hasIcon = !!state.metadata.icon;

        // QUALITY CHECKS
        const passesVolume = vol5m >= 3000; // $3k+ 5m Volume
        const passesSocials = hasIcon && hasSocials; // Must have Icon + at least 1 Link

        let minCap = CONFIG.minMcap;
        let maxCap = CONFIG.maxMcap;

        // Apply specific filters for BASE chain
        if (chain === "BASE") {
            minCap = 200000;
            maxCap = 600000;
        }

        // New Composite Filter: Mcap + Liquidity + (Volume OR Socials for quality)
        // We want to be careful not to be TOO strict, so we'll alert if it passes basic Mcap/Liq
        // but only if it has at least SOME organic signal (Volume or Socials).
        if (
            mcap >= minCap && mcap <= maxCap &&
            state.metadata.liquidity <= CONFIG.maxLiquidity
        ) {
            if (!passesVolume && !passesSocials) {
                console.log(
                    `[FILTER] Skipping ${state.metadata.symbol} - Failed organic quality checks (Vol: $${vol5m}, Socials: ${passesSocials})`,
                );
                return;
            }

            // Filter out bonding curve tokens if enabled
            if (
                CONFIG.ignoreBonding &&
                state.metadata.labels?.includes("bonding-curve")
            ) {
                console.log(
                    `[FILTER] Skipping ${state.metadata.symbol} - Still on bonding curve.`,
                );
                return;
            }

            const isBonding =
                state.metadata.labels?.includes("bonding-curve") || false;
            const isPumpFun = state.metadata.url.includes("pump.fun") ||
                state.metadata.websites?.some((w) =>
                    w.url.includes("pump.fun")
                );

            let message = `${
                passesVolume && passesSocials
                    ? "🌟 *VERIFIED GEM PULSE*"
                    : "💎 *GEM PULSE DETECTED*"
            } *(${chain})*\n\n` +
                `🏷 *${state.metadata.name}* (${state.metadata.symbol})\n` +
                `👥 Activity: ${state.uniqueBuyers.size} unique buyers in 5m\n` +
                `📊 *Signal Mcap: ${formatMcap(mcap)}*\n` +
                `📈 5m Vol: *$${vol5m.toLocaleString()}*\n` +
                `💧 Liq: $${state.metadata.liquidity.toLocaleString()}\n` +
                `${isPumpFun ? "💊 *Platform: Pump.fun*\n" : ""}` +
                `${isBonding ? "🍼 *Status: Still Bonding* 🚀\n" : ""}\n` +
                `${hasIcon ? "🖼 Icon: ✅" : "🖼 Icon: ❌"} | ${
                    hasSocials ? "🔗 Socials: ✅" : "🔗 Socials: ❌"
                }\n\n` +
                `📜 *CA:* \`${tokenAddress}\``;

            const buttons = [];
            // Main Dex Button
            buttons.push([
                Markup.button.url("📈 DexScreener", state.metadata.url),
            ]);

            // Social Row
            const socials = [];
            if (state.metadata.websites && state.metadata.websites.length > 0) {
                socials.push(
                    Markup.button.url("🌐 Web", state.metadata.websites[0].url),
                );
            }
            if (state.metadata.socials) {
                const twitter = state.metadata.socials.find((s) =>
                    s.type === "twitter"
                );
                const telegram = state.metadata.socials.find((s) =>
                    s.type === "telegram"
                );
                if (twitter) {
                    socials.push(Markup.button.url("🐦 X", twitter.url));
                }
                if (telegram) {
                    socials.push(Markup.button.url("📲 TG", telegram.url));
                }
            }
            if (socials.length > 0) {
                buttons.push(socials);
            }

            await sendAlert(message, {
                ...Markup.inlineKeyboard(buttons),
                thumb: state.metadata.icon,
                img: state.metadata.header,
            });

            await logRunner({
                name: state.metadata.name,
                symbol: state.metadata.symbol,
                address: tokenAddress,
                sector: "Token",
                mcap: state.metadata.mcap,
                priceUsd: state.metadata.priceUsd,
                timestamp: now,
                chain,
            });
            alertedTokensToday.add(tokenAddress);
        }
    }
};

// Periodic Cleanup
const runCleanup = () => {
    try {
        const now = Date.now();
        Object.keys(swarmState).forEach((key) => {
            if (now - swarmState[key]!.lastCheck > CONFIG.swarmWindowMs * 2) {
                delete swarmState[key];
            }
        });
        Object.keys(nftSwarmState).forEach((key) => {
            if (
                now - nftSwarmState[key]!.lastCheck > CONFIG.swarmWindowMs * 2
            ) {
                delete nftSwarmState[key];
            }
        });
        Object.keys(nftBuySwarmState).forEach((key) => {
            if (
                now - nftBuySwarmState[key]!.lastCheck >
                    CONFIG.swarmWindowMs * 2
            ) {
                delete nftBuySwarmState[key];
            }
        });

        // Stricter limit on processed hashes to prevent OOM
        if (processedHashes.size > 5000) {
            console.log(
                `[CLEANUP] Clearing ${processedHashes.size} processed hashes.`,
            );
            processedHashes.clear();
        }

        if (new Date().getHours() === 0 && new Date().getMinutes() < 10) {
            alertedTokensToday.clear();
        }
    } catch (e) {
        console.error("[CLEANUP] Error:", e);
    } finally {
        setTimeout(runCleanup, 600000); // 10 minutes
    }
};

runCleanup();
