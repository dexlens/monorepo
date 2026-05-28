/**
 * On-Chain Monitoring Bot
 * =======================
 *
 * This bot monitors on-chain activity across multiple networks (e.g., Base, Solana, NFTs)
 * and provides real-time alerts, statistics tracking, and reporting.
 *
 * Features:
 *   - Polls recent transactions and activity for supported blockchains.
 *   - Filters and processes events according to configurable minimum thresholds.
 *   - Integrates with a notification/alert system via the `bot` module.
 *   - Maintains running statistics (e.g., number of transactions scanned, recap timestamps).
 *   - Provides endpoints for liveness/readiness checks.
 *
 * Components:
 *   - `bot`         : Handles alert sending logic.
 *   - `base`        : Fetches recent Base chain transfers.
 *   - `solana`      : Fetches recent Solana transfers.
 *   - `nfts`        : Fetches the latest NFT activities and block numbers.
 *   - `filter`      : Contains filtering and post-processing logic for Base, Solana, and NFT activity.
 *   - `stats`       : Handles global statistics, historical reports, and max market cap tracking.
 *
 * Configuration:
 *   - Controlled via environment variables such as:
 *       - `POLLING_INTERVAL_MS` : Polling interval in milliseconds (default: 30000).
 *       - `BASE_MIN_VALUE_ETH`  : Minimum ETH value for Base transfers (default: 0.005).
 *       - `SOL_MIN_VALUE_SOL`   : Minimum SOL value for Solana transfers (default: 1).
 *       - `PORT`                : Server port (default: 3000).
 *
 * Usage:
 *   - The script runs an Express server instance and a continuous background polling loop.
 *   - All core logic is managed internally; no manual invocations are required.
 */

import bot, { sendAlert } from "./bot.ts";
import { getRecentBaseTransfers } from "./base.ts";
import { getRecentSolanaTransfers } from "./solana.ts";
import { getLatestBlockNumber, getRecentNFTActivity } from "./nfts.ts";
import {
    filterAndProcessBase,
    filterAndProcessNFTs,
    filterAndProcessSol,
    loadConfig,
} from "./filter.ts";
import {
    getHistoricalReport,
    getLastRecapTimestamp,
    incrementGlobalStat,
    setLastRecapTimestamp,
    updateAllActiveMaxMcaps,
} from "./stats.ts";
import dotenv from "npm:dotenv";
import express from "npm:express";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("On-Chain Monitoring Bot is Active 🚀");
});

app.listen(port, () => {
    console.log(`Keep-alive server on port ${port}`);
});

const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL_MS || "30000");
const ATH_UPDATE_INTERVAL = 10 * 60 * 1000; // Increased to 10 minutes to prevent rate limits
const BASE_MIN = parseFloat(process.env.BASE_MIN_VALUE_ETH || "0.005");
const SOL_MIN = parseFloat(process.env.SOL_MIN_VALUE_SOL || "1");

let lastNftBlock = 0;

const runPollingLoop = async () => {
    try {
        console.log(`[${new Date().toISOString()}] Cycle Start`);

        const baseTxs = await getRecentBaseTransfers(BASE_MIN);
        await incrementGlobalStat("ethTxsScanned", baseTxs.length); // Re-use eth field or update schema
        const baseAlerts = await filterAndProcessBase(baseTxs);
        for (const a of baseAlerts) await sendAlert(a, null, "Token");

        const solTxs = await getRecentSolanaTransfers(SOL_MIN);
        await incrementGlobalStat("solTxsScanned", solTxs.length);
        const solAlerts = await filterAndProcessSol(solTxs);
        for (const a of solAlerts) await sendAlert(a, null, "Token");

        console.log(
            `[CYCLE] Scanned ${baseTxs.length} BASE txs, ${solTxs.length} SOL txs.`,
        );

        // NFT Scanning
        if (lastNftBlock > 0) {
            const nftActivities = await getRecentNFTActivity(lastNftBlock + 1);
            await incrementGlobalStat("nftEventsScanned", nftActivities.length);
            if (nftActivities.length > 0) {
                await filterAndProcessNFTs(nftActivities);
                const highestBlock = Math.max(
                    ...nftActivities.map((a) => a.blockNumber),
                );
                lastNftBlock = highestBlock;
            } else {
                const currentBlock = await getLatestBlockNumber();
                if (currentBlock > lastNftBlock) {
                    lastNftBlock = currentBlock;
                }
            }
        } else {
            lastNftBlock = await getLatestBlockNumber();
        }

        console.log(`[${new Date().toISOString()}] Cycle End`);
    } catch (error) {
        console.error("Loop error:", error);
    } finally {
        setTimeout(runPollingLoop, POLLING_INTERVAL);
    }
};

const runAthTracker = async () => {
    try {
        await updateAllActiveMaxMcaps();
    } catch (error) {
        console.error("ATH Tracker error:", error);
    } finally {
        setTimeout(runAthTracker, ATH_UPDATE_INTERVAL);
    }
};

const runDailyRecapCheck = async () => {
    try {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        if ((hour === 9 || hour === 21) && minute === 0) {
            const lastTs = await getLastRecapTimestamp();
            const report = await getHistoricalReport(lastTs);
            const isError = report.includes("Error") ||
                report.includes("No historical data");
            const isNoNewAlerts =
                report === "No new alerts found for this period.";

            if (!isError && !isNoNewAlerts) {
                await sendAlert(report).catch(() => {});
                await setLastRecapTimestamp(Date.now());
            }
        }
    } catch (error) {
        console.error("Daily Recap error:", error);
    } finally {
        setTimeout(runDailyRecapCheck, 60000);
    }
};

const main = async () => {
    console.log("Starting On-Chain Monitoring Bot...");

    await loadConfig();

    bot.launch({
        allowedUpdates: ["message", "callback_query"],
        dropPendingUpdates: true,
    }).then(() => {
        console.log("Telegram bot is online and responding to commands.");
    }).catch((err) => {
        console.error("Failed to launch Telegram bot:", err);
    });

    await sendAlert(
        "🚀 *On-Chain Monitoring Bot Online*\nFocus: Micro-Caps & NFTs | Swarm: 5\nMonitoring Telegram & Discord...",
    ).catch(() => {});

    lastNftBlock = await getLatestBlockNumber();

    // Start sequential loops
    runPollingLoop();
    runAthTracker();
    runDailyRecapCheck();
};

main().catch(console.error);
