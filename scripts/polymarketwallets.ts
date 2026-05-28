/**
 * Sloppy code, it's just a quick script
 *
 * - Liquid
 */

import dotenv from "npm:dotenv";
dotenv.config();

const fileNames = process.env.POLYMARKET_FILE_NAMES?.split(",");

let numberOfWallets = 0;
let o1 = Deno.readTextFileSync(`./workshop/rememberindex.txt`);
o1 = parseInt(o1);
for (const fileName of fileNames) {
    const data = Deno.readTextFileSync(`./workshop/data/${fileName}`);
    const json = JSON.parse(data);
    console.log(`${fileName} - ${json.data.length} wallets`);
    numberOfWallets += json.data.length;

    // group into 10,000 wallets
    const groupedWallets = json.data.reduce(
        (acc: any, curr: any, index: number) => {
            const groupIndex = Math.floor(index / 10000);
            if (!acc[groupIndex]) {
                acc[groupIndex] = [];
            }
            acc[groupIndex].push({
                address: curr.trader,
                name: curr.trader_name,
                tag: curr.tag,
                pnl: curr.pnl,
                win_amount: curr.win_amount,
                loss_amount: curr.loss_amount,
                win_rate: curr.win_rate,
                overall_rank: curr.rank,
                tags: curr.trader_tags,
            });
            return acc;
        },
        [],
    );

    // make the folder ./data/data1 if it doesn't exist
    Deno.mkdirSync(
        `./data/polymarket_traders/${fileName.replace(".json", "")}`,
        { recursive: true },
    );

    // write to file
    for (const [index, group] of groupedWallets.entries()) {
        o1 += group.length;
        console.log(
            `Writing ${group.length} wallets to file - Total ${o1} wallets`,
        );
        const filePath = `./data/polymarket_traders/${
            fileName.replace(".json", "")
        }/${fileName.replace(".json", "")}_grouped_${o1}_wallets.json`;
        Deno.writeTextFileSync(
            filePath,
            JSON.stringify(group, null, 2),
        );

        Deno.writeTextFileSync(
            `./workshop/rememberindex.txt`,
            o1.toString(),
        );

        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

console.log(`Total number of wallets: ${numberOfWallets}`);

const folderReadme = (numberOfWallets: number) => `
# Polymarket Wallets

This dataset contains ${numberOfWallets} wallets

Yes, there are ${numberOfWallets} wallets in this dataset.
`;

Deno.writeTextFileSync("./workshop/README.md", folderReadme(numberOfWallets));
