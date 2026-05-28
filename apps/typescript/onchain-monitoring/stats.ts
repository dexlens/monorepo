/**
/**
 * Onchain Monitoring Stats & Firebase Logging
 * ===========================================
 *
 * This module handles the exporting of runner statistics (such as token "Pulse" events)
 * and interaction with Firebase Firestore for tracking, logging, and reporting the performance
 * of alerted tokens. It provides utility functions for recording real-time alerts and retrieving
 * historical performance data to be used in health reports or dashboards.
 *
 * Key Features:
 *   - Configures and initializes a Firebase Firestore connection using environment variables.
 *   - Exports the core `RunnerStat` interface, representing an alerted token's stats at event time.
 *   - Provides `logRunner(runner: RunnerStat)` to log events to Firestore.
 *   - Supports aggregation and reporting of token performance and runner history.
 *   - Includes utility for formatting marketcap values and fetching configuration (`getBotConfig`).
 *
 * Environment Variables Required:
 *   - FIREBASE_API_KEY
 *   - FIREBASE_AUTH_DOMAIN
 *   - FIREBASE_PROJECT_ID
 *   - FIREBASE_STORAGE_BUCKET
 *   - FIREBASE_MESSAGING_SENDER_ID
 *   - FIREBASE_APP_ID
 *
 * Usage:
 *   - Used within the onchain filtering and alerting pipeline to record detection events.
 *   - Consumed by dashboards/scripts to retrieve runner stats for analysis or UI overlays.
 *
 * Note: All imports are explicit with npm: prefixes or relative .ts suffixes for clarity and Deno compatibility.
 */

import { initializeApp } from "@firebase/app";
import {
    addDoc,
    collection,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    increment,
    limit,
    orderBy,
    query,
    QueryDocumentSnapshot,
    setDoc,
    Timestamp,
    updateDoc,
    where,
} from "npm:@firebase/firestore";
import dotenv from "npm:dotenv";
import { getBatchTokenMetadata } from "./dexscreener.ts";

dotenv.config();

const requiredEnvVars = [
    "FIREBASE_API_KEY",
    "FIREBASE_AUTH_DOMAIN",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_STORAGE_BUCKET",
    "FIREBASE_MESSAGING_SENDER_ID",
    "FIREBASE_APP_ID",
];

const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
    console.error(
        `[FIREBASE] CRITICAL: Missing environment variables: ${
            missingVars.join(", ")
        }`,
    );
}

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export interface RunnerStat {
    name: string;
    symbol: string;
    address: string;
    sector: string;
    mcap: number;
    maxMcap?: number; // Highest mcap reached since alert
    priceUsd: string;
    timestamp: number;
    chain: string;
}

export const logRunner = async (runner: RunnerStat) => {
    if (missingVars.length > 0) return;
    try {
        // Ensure all numeric fields are actually numbers
        const cleanRunner = {
            ...runner,
            mcap: Number(runner.mcap) || 0,
            maxMcap: Number(runner.mcap) || 0, // Initialize maxMcap with current mcap
            timestamp: Number(runner.timestamp) || Date.now(),
            createdAt: Timestamp.now(), // For Firebase side sorting
        };

        // Use address as doc ID for tokens to make updates easier, or just addDoc for history
        // For historical reports, we want to track the performance of EACH alert.
        // If we alert the same token twice, they are separate entries in the report.
        await addDoc(collection(db, "alerts"), cleanRunner);
        console.log(
            `[FIREBASE] ✅ Saved alert to cloud: ${runner.symbol} (${runner.address})`,
        );
    } catch (e: any) {
        console.error(
            `[FIREBASE] ❌ Save error for ${runner.symbol}:`,
            e.message,
        );
    }
};

export const getLastRecapTimestamp = async (): Promise<number> => {
    try {
        const docRef = doc(db, "state", "recap");
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            return docSnap.data().lastRecapTimestamp;
        }
    } catch (e) {
        console.error("[FIREBASE] State load error:", e);
    }
    return Date.now() - 12 * 60 * 60 * 1000; // Default fallback
};

export const setLastRecapTimestamp = async (ts: number) => {
    try {
        await setDoc(doc(db, "state", "recap"), { lastRecapTimestamp: ts });
    } catch (e) {
        console.error("[FIREBASE] State save error:", e);
    }
};

export interface GlobalStats {
    ethTxsScanned: number;
    solTxsScanned: number;
    nftEventsScanned: number;
    alertsSent: number;
    startTime: number;
}

export const getGlobalStats = async (): Promise<GlobalStats> => {
    try {
        const docRef = doc(db, "state", "global");
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            return docSnap.data() as GlobalStats;
        }
        // Initialize if doesn't exist
        const initial = {
            ethTxsScanned: 0,
            solTxsScanned: 0,
            nftEventsScanned: 0,
            alertsSent: 0,
            startTime: Date.now(),
        };
        await setDoc(docRef, initial);
        return initial;
    } catch (e) {
        console.error("[FIREBASE] Stats load error:", e);
        return {
            ethTxsScanned: 0,
            solTxsScanned: 0,
            nftEventsScanned: 0,
            alertsSent: 0,
            startTime: Date.now(),
        };
    }
};

export const incrementGlobalStat = async (
    key: keyof Omit<GlobalStats, "startTime">,
    amount: number = 1,
) => {
    try {
        const docRef = doc(db, "state", "global");
        await updateDoc(docRef, { [key]: increment(amount) });
    } catch (e) {
        console.error("[FIREBASE] Stat increment error:", e);
    }
};

export interface BotConfig {
    swarmThreshold: number;
    swarmWindowMs: number;
    minMcap: number;
    maxMcap: number;
    maxLiquidity: number;
    nftEnabled: boolean;
    ignoreBonding: boolean;
}

export interface ChatSubscription {
    chatId: number;
    gems: boolean;
    nfts: boolean;
}

export const getSubscribedChats = async (): Promise<ChatSubscription[]> => {
    try {
        const q = query(collection(db, "chats"));
        const querySnapshot = await getDocs(q);
        const chats: ChatSubscription[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
            chats.push({ ...doc.data() as ChatSubscription });
        });
        return chats;
    } catch (e) {
        console.error("[FIREBASE] Chat subscription load error:", e);
        return [];
    }
};

export const updateChatSubscription = async (
    chatId: number,
    update: Partial<{ gems: boolean; nfts: boolean }>,
) => {
    try {
        const docRef = doc(db, "chats", chatId.toString());
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            await setDoc(docRef, update, { merge: true });
        } else {
            await setDoc(docRef, {
                chatId,
                gems: update.gems || false,
                nfts: update.nfts || false,
            });
        }
    } catch (e) {
        console.error("[FIREBASE] Chat subscription update error:", e);
    }
};

export const deleteChatSubscription = async (chatId: number) => {
    try {
        const docRef = doc(db, "chats", chatId.toString());
        // We don't actually delete the doc to keep history, just turn off alerts
        await setDoc(docRef, { gems: false, nfts: false }, { merge: true });
    } catch (e) {
        console.error("[FIREBASE] Chat subscription delete error:", e);
    }
};

export const getBotConfig = async (): Promise<BotConfig> => {
    try {
        const docRef = doc(db, "state", "config");
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            return docSnap.data() as BotConfig;
        }
        // Default initial config
        const initial: BotConfig = {
            swarmThreshold: 8,
            swarmWindowMs: 300000,
            minMcap: 25000,
            maxMcap: 150000,
            maxLiquidity: 100000,
            nftEnabled: true,
            ignoreBonding: false,
        };
        await setDoc(docRef, initial);
        return initial;
    } catch (e) {
        console.error("[FIREBASE] Config load error:", e);
        return {
            swarmThreshold: 8,
            swarmWindowMs: 300000,
            minMcap: 25000,
            maxMcap: 150000,
            maxLiquidity: 100000,
            nftEnabled: true,
            ignoreBonding: false,
        };
    }
};

export const updateBotConfig = async (update: Partial<BotConfig>) => {
    try {
        const docRef = doc(db, "state", "config");
        await setDoc(docRef, update, { merge: true });
    } catch (e) {
        console.error("[FIREBASE] Config update error:", e);
    }
};

export const formatMcap = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(0)}k`;
    return `$${val.toFixed(0)}`;
};

export const updateAllActiveMaxMcaps = async () => {
    if (missingVars.length > 0) return;
    try {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        console.log(
            `[BACKGROUND] Updating ATHs for tokens alerted since ${
                new Date(sevenDaysAgo).toLocaleString()
            }...`,
        );

        const q = query(
            collection(db, "alerts"),
            where("timestamp", ">=", sevenDaysAgo),
        );

        const querySnapshot = await getDocs(q);
        const activeAlerts: (RunnerStat & { id: string })[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
            const data = doc.data() as RunnerStat;
            if (data.sector === "Token") {
                activeAlerts.push({ ...data, id: doc.id });
            }
        });

        if (activeAlerts.length === 0) return;

        // Deduplicate addresses to minimize DexScreener API calls
        const addresses = [...new Set(activeAlerts.map((a) => a.address))];
        const currentMetadata = await getBatchTokenMetadata(addresses);

        let updateCount = 0;
        const updatePromises = [];

        for (const alert of activeAlerts) {
            const current = currentMetadata[alert.address.toLowerCase()];
            if (current && current.mcap > (alert.maxMcap || alert.mcap)) {
                updatePromises.push(
                    updateDoc(doc(db, "alerts", alert.id), {
                        maxMcap: current.mcap,
                    }),
                );
                updateCount++;
                // Limit concurrent updates to avoid Firebase rate limits
                if (updatePromises.length >= 20) {
                    await Promise.all(updatePromises);
                    updatePromises.length = 0;
                }
            }
        }

        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }

        if (updateCount > 0) {
            console.log(
                `[BACKGROUND] ATH Update complete. Updated ${updateCount} tokens.`,
            );
        }
    } catch (e: any) {
        console.error("[BACKGROUND] ATH Update Error:", e.message);
    }
};

export const getTopPerformers = async (days: number = 7) => {
    try {
        const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
        const q = query(
            collection(db, "alerts"),
            where("timestamp", ">=", startTime),
            limit(1000),
        );

        const querySnapshot = await getDocs(q);
        const alerts: RunnerStat[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
            const data = doc.data() as RunnerStat;
            if (data.sector === "Token") {
                alerts.push(data);
            }
        });

        if (alerts.length === 0) {
            return "No tokens found in the last " + days + " days.";
        }

        const escapeMd = (text: string) => {
            if (!text) return "";
            return text.replace(/[_*`\[]/g, "\\$&");
        };

        // Group by address to find the BEST entry for each token
        const tokenBestPerf = new Map<
            string,
            {
                symbol: string;
                peak: number;
                initial: number;
                multiplier: number;
            }
        >();

        alerts.forEach((a) => {
            const addr = a.address.toLowerCase();
            const peak = a.maxMcap || a.mcap;
            const initial = a.mcap;
            const multiplier = initial > 0 ? peak / initial : 0;

            if (
                !tokenBestPerf.has(addr) ||
                multiplier > tokenBestPerf.get(addr)!.multiplier
            ) {
                tokenBestPerf.set(addr, {
                    symbol: a.symbol,
                    peak,
                    initial,
                    multiplier,
                });
            }
        });

        const sorted = Array.from(tokenBestPerf.values()).sort((a, b) =>
            b.multiplier - a.multiplier
        );

        let message = `🏆 *Top Performers (Last ${days} Days)*\n\n`;
        sorted.slice(0, 15).forEach((t, i) => {
            const emoji = i === 0
                ? "🥇"
                : i === 1
                ? "🥈"
                : i === 2
                ? "🥉"
                : "🔥";
            message += `${emoji} *${escapeMd(t.symbol)}*:  *${
                t.multiplier.toFixed(2)
            }x*\n`;
            message += `   (Entry: ${formatMcap(t.initial)} → Peak: ${
                formatMcap(t.peak)
            })\n`;
        });

        return message;
    } catch (e: any) {
        console.error("[STATS] Top Performers Error:", e.message);
        return "Error fetching top performers.";
    }
};

export const getHistoricalReport = async (
    sinceOrDuration?: number | string,
) => {
    try {
        const now = Date.now();
        let startTime = now - 12 * 60 * 60 * 1000;

        if (typeof sinceOrDuration === "number") {
            startTime = sinceOrDuration;
        } else if (typeof sinceOrDuration === "string") {
            const unit = sinceOrDuration.slice(-1);
            const val = parseInt(sinceOrDuration.slice(0, -1));
            if (!isNaN(val)) {
                if (unit === "h") startTime = now - val * 60 * 60 * 1000;
                else if (unit === "d") {
                    startTime = now - val * 24 * 60 * 60 * 1000;
                } else if (unit === "m") startTime = now - val * 60 * 1000;
            }
        }

        const escapeMd = (text: string) => {
            if (!text) return "";
            return text.replace(/[_*`\[]/g, "\\$&");
        };

        console.log(
            `[FIREBASE] Fetching alerts since ${
                new Date(startTime).toLocaleString()
            }...`,
        );

        const q = query(
            collection(db, "alerts"),
            where("timestamp", ">=", startTime),
            orderBy("timestamp", "desc"),
            limit(500), // Increase limit to capture more data for full reports
        );

        const querySnapshot = await getDocs(q);
        const recentRunners: (RunnerStat & { id: string })[] = [];
        querySnapshot.forEach((doc: QueryDocumentSnapshot) => {
            recentRunners.push({ ...doc.data() as RunnerStat, id: doc.id });
        });

        console.log(
            `[FIREBASE] Found ${recentRunners.length} alerts for the period.`,
        );

        if (recentRunners.length === 0) {
            return "No new alerts found for this period.";
        }

        const tokens = recentRunners.filter((r) => r.sector === "Token");

        // Fetch current metadata
        const tokenAddresses = [...new Set(tokens.map((t) => t.address))];
        const currentMetadata = await getBatchTokenMetadata(tokenAddresses);

        const hourCounts: Record<number, number> = {};
        recentRunners.forEach((r) => {
            const date = new Date(r.timestamp);
            if (!isNaN(date.getTime())) {
                const hr = date.getHours();
                hourCounts[hr] = (hourCounts[hr] || 0) + 1;
            }
        });

        const hourEntries = Object.entries(hourCounts);
        const topHour = hourEntries.length > 0
            ? hourEntries.sort((a, b) => b[1] - a[1])[0]
            : null;

        let message = `📊 *Daily Alerts Performance*\n`;
        message += `_(Period: ${new Date(startTime).toLocaleTimeString()} - ${
            new Date(now).toLocaleTimeString()
        })_\n\n`;
        message += `⏱ Peak Activity: ${topHour ? topHour[0] : "N/A"}:00\n`;
        message += `🪙 Tokens: ${tokens.length}\n\n`;

        if (tokens.length > 0) {
            message += `*Token Performance:* \n`;
            message += `_(Peak X's calculated from ATH since alert)_\n\n`;

            const firstTokenAlerts = new Map<
                string,
                RunnerStat & { id: string }
            >();
            [...tokens].reverse().forEach((t) => {
                const addr = t.address.toLowerCase();
                if (!firstTokenAlerts.has(addr)) {
                    firstTokenAlerts.set(addr, t);
                }
            });

            const tokenPerfList = await Promise.all(
                Array.from(firstTokenAlerts.values()).map(async (t) => {
                    const current = currentMetadata[t.address.toLowerCase()];
                    let peakMultiplier = 1;
                    let currentMultiplier = 1;
                    let perfStr = "";

                    const initialMcap = t.mcap;
                    let maxMcap = t.maxMcap || t.mcap;

                    if (current) {
                        const currentMcap = current.mcap;

                        // Update Max Mcap if current is higher
                        if (currentMcap > maxMcap) {
                            maxMcap = currentMcap;
                            // Async update to Firebase (don't wait to keep report fast)
                            updateDoc(doc(db, "alerts", t.id), {
                                maxMcap: currentMcap,
                            }).catch((e) => {
                                console.error(
                                    `[FIREBASE] Failed to update maxMcap for ${t.symbol}:`,
                                    e.message,
                                );
                            });
                        }

                        if (initialMcap > 0) {
                            peakMultiplier = maxMcap / initialMcap;
                            currentMultiplier = currentMcap / initialMcap;

                            const peakEmoji = peakMultiplier >= 5
                                ? "🔥"
                                : peakMultiplier >= 2
                                ? "🚀"
                                : peakMultiplier >= 1
                                ? "📈"
                                : "🔻";
                            const currEmoji = currentMultiplier >= 1
                                ? "✅"
                                : "💤";

                            perfStr =
                                `${peakEmoji} *PEAK: ${
                                    peakMultiplier.toFixed(2)
                                }x* (${formatMcap(maxMcap)})\n` +
                                `      ${currEmoji} CURR: ${
                                    currentMultiplier.toFixed(2)
                                }x (${formatMcap(currentMcap)})`;
                        } else {
                            perfStr = `❓ (Incomplete Mcap Data)`;
                        }
                    } else {
                        const mcapDisplay = initialMcap > 0
                            ? formatMcap(initialMcap)
                            : "N/A";
                        perfStr = `❓ (Initial Mcap: ${mcapDisplay} | Peak: ${
                            formatMcap(maxMcap)
                        })`;
                    }
                    return { symbol: t.symbol, perfStr, peakMultiplier };
                }),
            );

            // Sort by PEAK performance
            tokenPerfList.sort((a, b) => b.peakMultiplier - a.peakMultiplier);

            tokenPerfList.forEach((tp) => {
                message += `- ${escapeMd(tp.symbol)}:\n${tp.perfStr}\n`;
            });
        }

        return message;
    } catch (e) {
        console.error("[FIREBASE] Report Error:", e);
        return "❌ Error generating report. Please check logs.";
    }
};
