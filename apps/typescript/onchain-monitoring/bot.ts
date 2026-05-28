/**
/**
 * On-Chain Monitoring Bot Telegram Module
 * =======================================
 *
 * This module initializes and manages the Telegram bot for On-Chain Trend Monitoring. It:
 *   - Listens for user commands to control alerts in Telegram groups and chats.
 *   - Integrates with monitoring/reporting logic via commands and subscriptions.
 *   - Provides error handling and helpful onboarding messages.
 *
 * Key Features:
 *   - **Command Registration:** Adds handlers for core commands such as `/gems_on`, `/nfts_on`, `/alerts_off`, `/status`, `/settings`, and `/stats`.
 *   - **Group Subscription Management:** Allows group admins to enable or disable receiving alerts for tokens (gems) and NFTs.
 *   - **Error Handling:** Catches errors globally and replies to users with user-friendly error messages.
 *   - **Onboarding:** Welcomes users with a summary of available commands.
 *
 * Usage:
 *   - This file is imported and initialized by the main on-chain monitoring application.
 *   - Relies on a valid `TELEGRAM_BOT_TOKEN` environment variable.
 *
 * Dependencies:
 *   - telegraf: Handles Telegram bot API interaction.
 *   - dotenv: Loads environment configuration.
 *   - Several internal modules for stats and configuration management.
 *
 * See Also:
 *   - The `sendAlert` export in this file, which enables other modules to send Telegram (and Discord) alerts.
 */

import { Markup, Telegraf } from "npm:telegraf";
import dotenv from "npm:dotenv";
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not defined in .env");
    process.exit(1);
}

import {
    deleteChatSubscription,
    getBotConfig,
    getGlobalStats,
    getHistoricalReport,
    getLastRecapTimestamp,
    getSubscribedChats,
    getTopPerformers,
    incrementGlobalStat,
    updateBotConfig,
    updateChatSubscription,
} from "./stats";
import { loadConfig } from "./filter.ts";

const bot = new Telegraf(token);

// Global Error Handler
bot.catch((err: any, ctx) => {
    console.error(`[TELEGRAF] Error for ${ctx.updateType}:`, err);
    ctx.reply("⚠️ An unexpected error occurred. Please try again later.").catch(
        () => {},
    );
});

bot.start((ctx) => {
    ctx.reply(
        "Welcome to the On-Chain Trend Monitoring Bot! 🚀\n" +
            "I monitor Base, Solana, and NFTs for gems.\n\n" +
            "📢 *Available Commands for Groups:*\n" +
            "✅ `/gems_on` - Enable token alerts in this chat\n" +
            "✅ `/nfts_on` - Enable NFT alerts in this chat\n" +
            "❌ `/alerts_off` - Disable all alerts in this chat\n\n" +
            "Admin commands: `/status`, `/settings`, `/stats`",
        { parse_mode: "Markdown" },
    );
});

bot.command("gems_on", async (ctx) => {
    const chatId = ctx.chat.id;
    await updateChatSubscription(chatId, { gems: true });
    ctx.reply("✅ *Gems alerts enabled* for this chat! (Base & Solana)", {
        parse_mode: "Markdown",
    });
});

bot.command("nfts_on", async (ctx) => {
    const chatId = ctx.chat.id;
    await updateChatSubscription(chatId, { nfts: true });
    ctx.reply("✅ *NFT alerts enabled* for this chat!", {
        parse_mode: "Markdown",
    });
});

bot.command("alerts_off", async (ctx) => {
    const chatId = ctx.chat.id;
    await deleteChatSubscription(chatId);
    ctx.reply("❌ *Alerts disabled* for this chat.");
});

bot.command("status", (ctx) => {
    ctx.reply("Bot is active and monitoring... 🔍");
});

const isAdmin = (ctx: any) => {
    const masterId = process.env.TELEGRAM_CHAT_ID;
    return ctx.from?.id.toString() === masterId;
};

bot.command("settings", async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply(
            "⛔ Unauthorized. This command is restricted to the bot owner.",
        );
    }
    const config = await getBotConfig();
    const message = `⚙️ *Bot Configuration*\n\n` +
        `🐝 Swarm Threshold: \`${config.swarmThreshold}\`\n` +
        `⏱ Swarm Window: \`${config.swarmWindowMs / 1000}s\`\n` +
        `💰 Min Mcap: \`$${config.minMcap.toLocaleString()}\`\n` +
        `🚀 Max Mcap: \`$${config.maxMcap.toLocaleString()}\`\n` +
        `💧 Max Liq: \`$${config.maxLiquidity.toLocaleString()}\`\n` +
        `🍼 Ignore Bonding: \`${
            config.ignoreBonding ? "ENABLED" : "DISABLED"
        }\`\n` +
        `🖼 NFT Alerts: \`${config.nftEnabled ? "ENABLED" : "DISABLED"}\`\n\n` +
        `💡 Use \`/set <key> <value>\` to update. \n` +
        `Keys: \`swarm\`, \`min\`, \`max\`, \`liq\`, \`nft\`, \`bonding\``;
    ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("set", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Unauthorized.");
    try {
        const text = ctx.message?.text || "";
        const parts = text.split(" ");
        if (parts.length < 3) return ctx.reply("Usage: `/set <key> <value>`");

        const key = parts[1].toLowerCase();
        const val = parts[2];

        const update: any = {};
        if (key === "swarm") update.swarmThreshold = parseInt(val);
        else if (key === "min") update.minMcap = parseInt(val);
        else if (key === "max") update.maxMcap = parseInt(val);
        else if (key === "liq") update.maxLiquidity = parseInt(val);
        else if (key === "nft") {
            update.nftEnabled = val.toLowerCase() === "true" || val === "1" ||
                val === "on";
        } else if (key === "bonding") {
            update.ignoreBonding = val.toLowerCase() === "true" ||
                val === "1" || val === "on";
        } else {return ctx.reply(
                "Invalid key! Use: `swarm`, `min`, `max`, `liq`, `nft`, `bonding`.",
            );}

        await updateBotConfig(update);
        await loadConfig(); // Reload into memory
        ctx.reply(`✅ Config updated: \`${key}\` set to \`${val}\``);
    } catch (e) {
        ctx.reply("❌ Failed to update config. Check logs.");
    }
});

bot.command("stats", async (ctx) => {
    const stats = await getGlobalStats();
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000 / 60); // in minutes
    const message = `📊 *Global Lifetime Stats*\n\n` +
        `⏱ Active Since: ${new Date(stats.startTime).toLocaleDateString()}\n` +
        `🔹 ETH Scanned: ${stats.ethTxsScanned.toLocaleString()}\n` +
        `🔸 SOL Scanned: ${stats.solTxsScanned.toLocaleString()}\n` +
        `🖼 NFT Events: ${stats.nftEventsScanned.toLocaleString()}\n` +
        `📢 Total Alerts Sent: ${stats.alertsSent.toLocaleString()}`;
    ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("top", async (ctx) => {
    try {
        const text = ctx.message?.text || "";
        const days = parseInt(text.split(" ")[1]) || 7;
        const message = await getTopPerformers(days);
        await ctx.reply(message, { parse_mode: "Markdown" });
    } catch (error: any) {
        console.error("[BOT] Top command error:", error);
        ctx.reply("❌ Error fetching top performers.");
    }
});

bot.command("report", async (ctx) => {
    try {
        const messageText = ctx.message?.text || "";
        const textParts = messageText.split(" ");
        const duration = textParts[1] || null; // e.g. "1h", "24h"

        await ctx.reply(
            `Calculating performance ${
                duration ? `for last ${duration}` : "since last recap"
            }... ⏳`,
        );

        const startTime = duration || await getLastRecapTimestamp();
        const report = await getHistoricalReport(startTime);

        if (
            !report || report === "No historical data yet." ||
            report === "No new alerts found for this period."
        ) {
            return ctx.reply("No alerts found in that period! 🧠");
        }

        // Split message if it exceeds Telegram's limit (4096 chars)
        const MAX_LENGTH = 4000;
        if (report.length <= MAX_LENGTH) {
            try {
                await ctx.reply(report, { parse_mode: "Markdown" });
            } catch (mdError: any) {
                console.error(
                    "[BOT] Markdown reply failed, falling back to plain text:",
                    mdError.message,
                );
                const plainReport = report.replace(/[*_`]/g, "");
                await ctx.reply(plainReport);
            }
        } else {
            // Split by lines to avoid breaking markdown formatting within a line
            const lines = report.split("\n");
            let currentChunk = "";

            for (const line of lines) {
                if ((currentChunk + line).length > MAX_LENGTH) {
                    await ctx.reply(currentChunk, { parse_mode: "Markdown" })
                        .catch(async () => {
                            await ctx.reply(currentChunk.replace(/[*_`]/g, ""));
                        });
                    currentChunk = "";
                }
                currentChunk += line + "\n";
            }

            if (currentChunk.trim().length > 0) {
                await ctx.reply(currentChunk, { parse_mode: "Markdown" }).catch(
                    async () => {
                        await ctx.reply(currentChunk.replace(/[*_`]/g, ""));
                    },
                );
            }
        }
    } catch (error: any) {
        console.error("[BOT] Report command error:", error);
        ctx.reply(
            "❌ Error generating report. Tip: Use `/report 1h` or `/report 24h`. If it persists, check bot logs.",
        );
    }
});
import axios from "axios";

export const sendAlert = async (
    message: string,
    extra?: any,
    sector: string = "Token",
) => {
    await incrementGlobalStat("alertsSent");
    const masterChatId = process.env.TELEGRAM_CHAT_ID;
    const masterNftChatId = process.env.TELEGRAM_NFT_CHAT_ID || masterChatId;
    const discordWebhook = process.env.DISCORD_WEBHOOK_URL;

    // 1. Fetch Dynamic Subscribers
    const subscribers = await getSubscribedChats();
    const targetChatIds = new Set<number>();

    // Add Master Chats
    if (sector === "Token" && masterChatId) {
        targetChatIds.add(parseInt(masterChatId));
    }
    if (sector === "NFT" && masterNftChatId) {
        targetChatIds.add(parseInt(masterNftChatId));
    }

    // Add Dynamic Subscribers
    subscribers.forEach((s) => {
        if (sector === "Token" && s.gems) targetChatIds.add(s.chatId);
        if (sector === "NFT" && s.nfts) targetChatIds.add(s.chatId);
    });

    if (targetChatIds.size > 0) {
        console.log(
            `[BROADCAST] Sending ${sector} alert to ${targetChatIds.size} chats:`,
            Array.from(targetChatIds),
        );
    }

    // 2. Telegram Broadcast
    for (const tid of targetChatIds) {
        try {
            if (extra && extra.thumb) {
                await bot.telegram.sendPhoto(tid, extra.thumb, {
                    caption: message,
                    parse_mode: "Markdown",
                    ...extra,
                });
            } else {
                await bot.telegram.sendMessage(tid, message, {
                    parse_mode: "Markdown",
                    ...extra,
                });
            }
            // Small throttle to avoid hitting broad Telegram broadcast limits if list is huge
            if (targetChatIds.size > 5) {
                await new Promise((r) => setTimeout(r, 100));
            }
        } catch (error: any) {
            if (error.response?.error_code === 403) {
                console.warn(
                    `[BOT] Bot was kicked from chat ${tid}. Disabling alerts.`,
                );
                await deleteChatSubscription(tid);
            } else {
                console.error(
                    `Error sending Telegram alert to ${tid}:`,
                    error.message,
                );
            }
        }
    }

    // 2. Discord Dispatch (Via Webhook with Rich Embeds)
    if (discordWebhook) {
        try {
            const discordMessage = message.replace(/\*/g, "**");

            // Improved title/description extraction
            const discordLines = discordMessage.split("\n").filter((l) =>
                l.trim().length > 0
            );
            let title = discordLines.find((l) => !l.includes("http")) ||
                "On-Chain Alert";

            const isNFT = message.toLowerCase().includes("nft");
            const isGem = message.toLowerCase().includes("gem");

            // Extract buttons/links from extra if available (Telegraf Markup)
            const links: { label: string; url: string }[] = [];
            if (
                extra && extra.reply_markup &&
                extra.reply_markup.inline_keyboard
            ) {
                extra.reply_markup.inline_keyboard.forEach((row: any[]) => {
                    row.forEach((btn: any) => {
                        if (btn.url) {
                            links.push({ label: btn.text, url: btn.url });
                        }
                    });
                });
            }

            // Extract the primary link (OpenSea or DexScreener) to trigger native Discord preview
            const primaryLinkMatch = message.match(
                /https?:\/\/(opensea\.io|dexscreener\.com)\/[^\s\)]+/,
            );
            let primaryLink = primaryLinkMatch ? primaryLinkMatch[0] : null;

            const embed: any = {
                title: title.replace(/\*\*/g, "").substring(0, 256),
                description: discordMessage.substring(0, 4000),
                color: isGem ? 0x00ff00 : (isNFT ? 0xff00ff : 0x3498db),
                timestamp: new Date().toISOString(),
                footer: {
                    text: `On-Chain Monitoring Bot | Memory Active`,
                },
            };

            if (extra && extra.thumb) {
                embed.thumbnail = { url: extra.thumb };
            }

            // CRITICAL FIX FOR DISCORD NFT PREVIEWS:
            // To force a native OpenSea preview, we send the link in a SEPARATE message
            // when it's an NFT, and skip the rich embed because embeds suppress native previews.
            if (isNFT && primaryLink?.includes("opensea.io")) {
                await axios.post(discordWebhook, { content: primaryLink });
                return; // Skip sending the embed for NFTs to ensure preview works
            }

            await axios.post(discordWebhook, {
                content: primaryLink || "",
                embeds: [embed],
            });
        } catch (error) {
            console.error("Error sending Discord alert:", error);
        }
    }

    if (!masterChatId && !discordWebhook && targetChatIds.size === 0) {
        console.log("No alert platforms configured. Alert (log):", message);
    }
};

export default bot;
