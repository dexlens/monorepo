/**
/**
 * ERC20 Balance Protection Demo (OnchainParty)
 * ============================================
 *
 * This example demonstrates how to protect a web route based on a user's ERC20 token balance.
 * When a user logs in, their ERC20 token balance is checked and captured; access is only granted
 * if the account holds a positive balance of a specified token.
 *
 * What this demo does:
 *   - Connects to the Ethereum RPC node via Alchemy.
 *   - Sets up an OnchainParty-based auth gateway.
 *   - Adds a "user" role that requires holding any amount of a specific ERC20 token (DEXLENS_TOKEN).
 *   - Protects the homepage route with this ERC20 balance check.
 *   - When the "/" route is accessed, the connected user's session and balance are logged.
 *
 * Running:
 *   1. Put your Alchemy-compatible Ethereum RPC URL in your environment as `RPC`.
 *   2. Start this server script (node erc20_protect.js or use a compatible Deno/Node runtime).
 *   3. It listens on port 3000 by default.
 *   4. Only users with a positive balance of `DEXLENS_TOKEN` can access the homepage.
 *
 * Customize the ERC20 token address or logic as needed for your use case.
 */

import dotenv from "npm:dotenv";
dotenv.config();
import OnchainPartyClass from "../server";
import { createAlchemyWeb3 } from "npm:@alch/alchemy-web3";
const web3 = createAlchemyWeb3(process.env.RPC);
const OnchainParty = new OnchainPartyClass();
OnchainParty.add("user", {
    authorize: async (req, account) => {
        const DEXLENS_TOKEN = "0x2e8faFAF34F610af898d6A5EAbcAd82417C56Ed9";
        let balance = await party.contract(web3, party.abi.erc20, DEXLENS_TOKEN)
            .balanceOf(account).call();
        if (balance > 0) {
            return { balance: balance };
        } else {
            throw new Error("not enough balance");
        }
    },
});
OnchainParty.app.get("/", OnchainParty.protect("user"), (req, res) => {
    console.log("session", req.session);
    res.sendFile(process.cwd() + "/index.html");
});
OnchainParty.app.listen(3000);
