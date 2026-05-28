/**
 * Proxy Utilities for Onchain Monitoring
 * ======================================
 *
 * This module provides robust proxy management utilities to facilitate network requests
 * that require HTTP/S proxy routing, especially for external data providers (such as Dexscreener)
 * where rate limits or IP bans may be encountered. It is designed to support both manual proxy lists and
 * dynamic scraping of public proxies, ensuring maximum reliability and throughput.
 *
 * Features:
 *   - Reads manual proxy lists from DEX_PROXIES and DEX_PROXIES_RAW environment variables.
 *   - Parses, normalizes, and randomizes proxy strings to distribute usage and reduce detection.
 *   - Scrapes public proxies from https://free-proxy-list.net/ as a fallback when no manual proxies are configured.
 *   - Implements in-memory proxy caching and scheduled refreshing to optimize performance.
 *   - Designed for integration with modules that require rotating proxy agents, such as token metadata fetching.
 *   - Can be extended for additional proxy providers or scraping logic by modifying getAutoProxies.
 *
 * Usage:
 *   - Call `getAutoProxies()` to get an array of available proxies, prioritizing manual/webshare proxies if present.
 *   - Upstream modules (e.g., dexscreener.ts) fetch proxies through this interface to construct HTTP agent objects.
 *   - Proxy strings follow the format: [username:password@]host:port or simply host:port (for free proxies).
 *
 * Notes:
 *   - Manual proxies are randomized/shuffled each request to maximize coverage and reduce the chance of bans.
 *   - Scraped public proxies (fallback) are cached for 10 minutes to reduce scraping frequency.
 *   - Add or rotate manual proxies using the DEX_PROXIES or DEX_PROXIES_RAW environment variables.
 *   - This module does not handle proxy health checks, but integrates with upstream proxy removal/rotation logic.
 *
 * Environment Variables:
 *   - DEX_PROXIES: Comma-separated list of proxies (optionally with user:pass).
 *   - DEX_PROXIES_RAW: Raw .txt-style proxy entries, e.g., from Webshare or other proxy sources.
 *
 * Dependencies:
 *   - axios for HTTP requests
 *   - cheerio for HTML parsing of proxy scrape responses
 *
 * Example:
 *   const proxies = await getAutoProxies();
 *   // proxies = ['user:pass@host:port', 'host2:port2', ...]
 */

import axios from "npm:axios";
import * as cheerio from "npm:cheerio";

let autoProxies: string[] = [];
let lastScrapeTime = 0;
const SCRAPE_INTERVAL_MS = 10 * 60 * 1000; // Scrape every 10 minutes

const getManualProxies = async (): Promise<string[]> => {
    const manual = (process.env.DEX_PROXIES || "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    // Support for pasting the entire .txt file content into an env var
    const rawContent = process.env.DEX_PROXIES_RAW || "";
    const rawProxies = rawContent
        .split(/[\n,]/) // Split by newline or comma
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            const parts = line.split(":");
            if (parts.length === 4) {
                return `${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
            }
            return line;
        });

    const combined = [...manual, ...rawProxies];

    // Shuffle to ensure we aren't always hitting the same ones first
    return combined.sort(() => Math.random() - 0.5);
};

export const getAutoProxies = async (): Promise<string[]> => {
    const manual = await getManualProxies();
    if (manual.length > 0) return manual; // Prioritize Webshare/Manual proxies

    const now = Date.now();
    // Return cached proxies if they are fresh
    if (autoProxies.length > 0 && (now - lastScrapeTime) < SCRAPE_INTERVAL_MS) {
        return autoProxies;
    }

    try {
        console.log("[PROXIES] Scraping fresh proxies...");
        const response = await axios.get("https://free-proxy-list.net/", {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
        });

        const $ = cheerio.load(response.data);
        const newList: string[] = [];

        // The proxies are in a table with id 'proxylisttable' or within the first table in the main content
        $("table tr").each((i, row) => {
            const cells = $(row).find("td");
            if (cells.length >= 8) {
                const ip = $(cells[0]).text().trim();
                const port = $(cells[1]).text().trim();
                const https = $(cells[6]).text().trim();
                const anonymity = $(cells[4]).text().trim();

                // We only want Elite or Anonymous proxies that support HTTPS
                if (
                    (anonymity === "elite proxy" ||
                        anonymity === "anonymous") && https === "yes"
                ) {
                    newList.push(`${ip}:${port}`);
                }
            }
        });

        if (newList.length > 0) {
            autoProxies = newList;
            lastScrapeTime = now;
            console.log(
                `[PROXIES] Successfully scraped ${autoProxies.length} elite proxies.`,
            );
        }

        return autoProxies;
    } catch (error: any) {
        console.error("[PROXIES] Scrape error:", error.message);
        return autoProxies; // Fallback to old list on error
    }
};

export const removeProxy = (proxy: string) => {
    autoProxies = autoProxies.filter((p) => p !== proxy);
    // console.log(`[PROXIES] Removed dead proxy. ${autoProxies.length} remaining.`);
};
