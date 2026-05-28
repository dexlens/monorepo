/**
 * NFT Gate Demo (OnchainParty)
 * ============================
 *
 * This example demonstrates how to protect a web page (or route) based on NFT ownership.
 *
 * What this demo does:
 *   - Connects to Ethereum using an Alchemy-compatible RPC endpoint.
 *   - Sets up an OnchainParty-based authentication gateway.
 *   - Adds a "user" role that requires the user to own at least one of a specific ERC721 NFT (`DEXL_PASS_NFT`).
 *   - Protects the homepage ("/") so only users who own the NFT can access it.
 *
 * How it works:
 *   - When a user attempts to log in, their wallet address is checked for ERC721 token balance.
 *   - If the user owns at least one of the required NFT, their session is granted and balance recorded.
 *   - If the user owns none, login is denied with an error.
 *
 * Running this demo:
 *   1. Set your Alchemy/Ethereum-compatible RPC URL in your environment as `RPC`.
 *   2. Replace `ADDRESS_WOULD_GO_HERE` with your NFT contract address.
 *   3. Start this script (Node.js, Deno, or compatible runtime).
 *   4. Only NFT holders can access "/".
 *   5. The protected homepage will log session details if access is granted.
 *
 * Customize the NFT contract address or logic as needed for your use case.
 */

import dotenv from "npm:dotenv";
dotenv.config();
import OnchainPartyClass from "../server";
import { createAlchemyWeb3 } from "npm:@alch/alchemy-web3";
const web3 = createAlchemyWeb3(process.env.RPC);
const OnchainParty = new OnchainPartyClass();
OnchainParty.add("user", {
    authorize: async (req, account) => {
        console.log("account", account);
        // take a snapshot of ERC721 NFT balance (End of Sartoshi)
        // ONLY allow login if the account holds AT LEAST 1
        const DEXL_PASS_NFT = "ADDRESS_WOULD_GO_HERE";
        let balance = await OnchainParty.contract(
            web3,
            OnchainParty.abi.erc721,
            DEXL_PASS_NFT,
        ).balanceOf(account).call();
        console.log("balance", balance);
        if (balance > 0) {
            return { balance: balance, contract: DEXL_PASS_NFT };
        } else {
            // If the balance is 0, don't allow login
            throw new Error("must own at least one 'DEXL_PASS_NFT'");
        }
    },
});
OnchainParty.app.get("/", OnchainParty.auth("user"), (req, res) => {
    console.log("session", req.session);
    res.sendFile(process.cwd() + "/index.html");
});
OnchainParty.app.listen(3000);
