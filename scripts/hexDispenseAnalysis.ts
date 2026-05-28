/**
 * Fetches `disperseToken` (and optionally `disperseTokenSimple`) calls to the
 * HexDotCom / Disperse contract, loads each tx via JSON-RPC, decodes calldata,
 * and writes JSON files matching `decoded-input-data-<txHash>.json`.
 *
 * Env:
 *   ETH_RPC_URL — required (e.g. Infura, Alchemy, public node)
 *   ETHERSCAN_API_KEY — required for `--from-etherscan` (Etherscan API v2)
 *   CONTRACT — optional, default 0x6357d3843d715496257e338a878ab0b72040a918
 */
import { decodeFunctionData, type Hex } from "npm:viem";

const DEFAULT_CONTRACT =
  "0x6357d3843d715496257e338a878ab0b72040a918" as const;

/** `disperseToken(address,address[],uint256[])` */
export const DISPERSE_TOKEN_SELECTOR = "0xc73a2d60" as Hex;
/** `disperseTokenSimple(address,address[],uint256[])` */
export const DISPERSE_TOKEN_SIMPLE_SELECTOR = "0x51ba162c" as Hex;

const DISPERSE_ABI = [
  {
    name: "disperseToken",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "values", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "disperseTokenSimple",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "values", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export type DecodedDisperseJson = {
  token: string;
  recipients: string[];
  values: string[];
};

export function decodedArgsToJson(
  args: readonly [string, string[], bigint[]],
): DecodedDisperseJson {
  const [token, recipients, values] = args;
  return {
    token,
    recipients,
    values: values.map((v) => v.toString()),
  };
}

export function decodeDisperseCalldata(input: Hex): {
  functionName: "disperseToken" | "disperseTokenSimple";
  args: readonly [string, string[], bigint[]];
} {
  const { functionName, args } = decodeFunctionData({
    abi: DISPERSE_ABI,
    data: input,
  });
  if (functionName !== "disperseToken" && functionName !== "disperseTokenSimple") {
    throw new Error(`Unexpected function: ${functionName}`);
  }
  const [token, recipients, values] = args as [
    string,
    string[],
    bigint[],
  ];
  return {
    functionName,
    args: [token, recipients, values],
  };
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const json = (await res.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (json.error?.message) {
    throw new Error(`RPC ${method}: ${json.error.message}`);
  }
  if (json.result === undefined) {
    throw new Error(`RPC ${method}: empty result`);
  }
  return json.result;
}

type RpcTx = {
  hash: Hex;
  input: Hex;
  to: Hex | null;
};

export async function ethGetTransactionByHash(
  rpcUrl: string,
  hash: Hex,
): Promise<RpcTx | null> {
  const tx = await rpcCall<RpcTx | null>(rpcUrl, "eth_getTransactionByHash", [
    hash,
  ]);
  return tx;
}

/** Paginated normal tx list for an address (incoming + outgoing). Filter client-side. */
export async function fetchTxHashesFromEtherscan(options: {
  apiKey: string;
  contract: string;
  chainId: number;
}): Promise<{ hash: string; to?: string; input?: string }[]> {
  const { apiKey, contract, chainId } = options;
  const pageSize = 10_000;
  const all: { hash: string; to?: string; input?: string }[] = [];
  let page = 1;

  while (true) {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", String(chainId));
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "txlist");
    url.searchParams.set("address", contract);
    url.searchParams.set("startblock", "0");
    url.searchParams.set("endblock", "99999999");
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(pageSize));
    url.searchParams.set("sort", "asc");
    url.searchParams.set("apikey", apiKey);

    const res = await fetch(url);
    const data = (await res.json()) as {
      status: string;
      message: string;
      result: unknown;
    };

    if (data.status !== "1" || !Array.isArray(data.result)) {
      throw new Error(
        `Etherscan txlist: ${data.message} — ${JSON.stringify(data.result)}`,
      );
    }

    const batch = data.result as {
      hash: string;
      to?: string;
      input?: string;
    }[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
  }

  return all;
}

function parseArgs(argv: string[]): {
  fromEtherscan: boolean;
  includeSimple: boolean;
  hashesFile?: string;
  outDir: string;
  contractFromCli?: string;
  chainId: number;
  limit?: number;
} {
  let fromEtherscan = false;
  let includeSimple = false;
  let hashesFile: string | undefined;
  let outDir = "./decoded-input-data";
  let contractFromCli: string | undefined;
  let chainId = 1;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-etherscan") fromEtherscan = true;
    else if (a === "--include-simple") includeSimple = true;
    else if (a === "--hashes-file") {
      hashesFile = argv[++i];
    } else if (a === "--out") {
      outDir = argv[++i] ?? outDir;
    } else if (a === "--contract") {
      contractFromCli = argv[++i];
    } else if (a === "--chain-id") {
      chainId = Number(argv[++i]);
    } else if (a === "--limit") {
      limit = Number(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      Deno.exit(0);
    }
  }

  return {
    fromEtherscan,
    includeSimple,
    hashesFile,
    outDir,
    contractFromCli,
    chainId,
    limit,
  };
}

function printHelp(): void {
  console.log(`Usage:
  deno run -A main.ts --from-etherscan [options]
  deno run -A main.ts --hashes-file hashes.txt [options]

  Requires ETH_RPC_URL for eth_getTransactionByHash. Listing all txs to an
  address is not part of standard JSON-RPC; --from-etherscan uses Etherscan
  API v2 (needs ETHERSCAN_API_KEY). Alternatively export hashes and use
  --hashes-file.

Options:
  --from-etherscan     List txs via Etherscan API v2, filter disperseToken (+ optional --include-simple)
  --include-simple     Also decode disperseTokenSimple (0x51ba162c)
  --hashes-file PATH   Newline-separated tx hashes (skip Etherscan); still uses RPC for each hash
  --out DIR            Output directory (default: ./decoded-input-data)
  --contract ADDR      Contract (default: ${DEFAULT_CONTRACT})
  --chain-id N         For Etherscan (default: 1)
  --limit N            Max number of txs to process (after filtering)

Environment:
  ETH_RPC_URL          Ethereum JSON-RPC URL (required)
  ETHERSCAN_API_KEY    Required for --from-etherscan
  CONTRACT             Default contract address if --contract omitted
`);
}

function selectorMatches(
  input: string,
  includeSimple: boolean,
): boolean {
  const sel = input.slice(0, 10).toLowerCase();
  if (sel === DISPERSE_TOKEN_SELECTOR) return true;
  if (includeSimple && sel === DISPERSE_TOKEN_SIMPLE_SELECTOR) return true;
  return false;
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function main(): Promise<void> {
  const argv = parseArgs(Deno.args);
  const rpcUrl = Deno.env.get("ETH_RPC_URL")?.trim();
  if (!rpcUrl) {
    console.error("Set ETH_RPC_URL to your Ethereum JSON-RPC endpoint.");
    Deno.exit(1);
  }

  const contract = (
    argv.contractFromCli?.trim().toLowerCase() ??
      Deno.env.get("CONTRACT")?.trim().toLowerCase() ??
      DEFAULT_CONTRACT
  );

  let hashes: string[] = [];

  if (argv.hashesFile) {
    const text = await Deno.readTextFile(argv.hashesFile);
    hashes = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } else if (argv.fromEtherscan) {
    const apiKey = Deno.env.get("ETHERSCAN_API_KEY")?.trim();
    if (!apiKey) {
      console.error(
        "For --from-etherscan, set ETHERSCAN_API_KEY (Etherscan API v2).",
      );
      Deno.exit(1);
    }
    console.error("Fetching transaction list from Etherscan…");
    const rows = await fetchTxHashesFromEtherscan({
      apiKey,
      contract,
      chainId: argv.chainId,
    });
    const filtered = rows.filter((r) => {
      const to = r.to?.toLowerCase();
      if (to !== contract) return false;
      const inp = r.input ?? "";
      return selectorMatches(inp, argv.includeSimple);
    });
    hashes = filtered.map((r) => r.hash);
    console.error(`Found ${hashes.length} disperse token txs (filtered).`);
  } else {
    printHelp();
    console.error(
      "\nProvide --from-etherscan or --hashes-file, or see --help.",
    );
    Deno.exit(1);
  }

  hashes = [...new Set(hashes)];

  if (argv.limit !== undefined && hashes.length > argv.limit) {
    hashes = hashes.slice(0, argv.limit);
  }

  await ensureDir(argv.outDir);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i] as Hex;
    const label = `[${i + 1}/${hashes.length}]`;
    try {
      const tx = await ethGetTransactionByHash(rpcUrl, h);
      if (!tx) {
        console.error(`${label} ${h} — not found`);
        fail++;
        continue;
      }
      const inp = tx.input;
      if (!inp || inp === "0x") {
        console.error(`${label} ${h} — empty input`);
        fail++;
        continue;
      }
      if (!selectorMatches(inp, argv.includeSimple)) {
        console.error(`${label} ${h} — not a selected disperse method, skip`);
        fail++;
        continue;
      }

      const { args } = decodeDisperseCalldata(inp);
      const json = decodedArgsToJson(args);
      const outPath = `${argv.outDir}/decoded-input-data-${h.slice(2)}.json`;
      await Deno.writeTextFile(outPath, JSON.stringify(json, null, 2) + "\n");
      console.error(`${label} wrote ${outPath}`);
      ok++;
    } catch (e) {
      console.error(`${label} ${h} — ${e}`);
      fail++;
    }
  }

  console.error(`Done. ${ok} written, ${fail} failed/skipped.`);
}

if (import.meta.main) {
  await main();
}
