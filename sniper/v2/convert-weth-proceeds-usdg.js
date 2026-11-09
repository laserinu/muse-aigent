// One-off cleanup: convert the v1 sell proceeds (WETH) to USDG (user order:
// "Sell it all now. For USD" + "and the others, clean up").
// Converts ONLY the v1 proceeds delta (48,547,182,057,254 wei) — NOT the
// pre-existing WETH dust (9,801,000,010,403, v3 micro-test) and NOT the
// agent's ETH gas reserve (needed for fresh sniping).
// Route: WETH -> USDG via the deep WETH/USDG V4 pool (proven funding route).
const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const trade = require("./trade.js");

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const PROCEEDS_WEI = 39206842446335n; // v1 sell-all WETH delta 2026-11-09 (perp + Quesadilla + BAMBI + eve; debtdog unsold)
const POOL_ID = "0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593";
const POOL_KEY = {
  poolId: POOL_ID,
  currency0: WETH,
  currency1: USDG,
  fee: 500,
  tickSpacing: 10,
  hooks: "0x0000000000000000000000000000000000000000",
};

async function main() {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const wethBefore = await client.readContract({ address: WETH, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  const usdgBefore = await client.readContract({ address: USDG, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  console.log("WETH before:", wethBefore.toString(), "| USDG before:", usdgBefore.toString());
  if (wethBefore < PROCEEDS_WEI) throw new Error("WETH balance below proceeds amount — refusing");
  const sell = await trade.buildSell(cfg, chain, POOL_KEY, WETH, 18, { address: USDG, symbol: "USDG", decimals: 6 }, PROCEEDS_WEI);
  console.log("minOut USDG (raw):", sell.amountOutMinimum, "=", (Number(sell.amountOutMinimum) / 1e6).toFixed(6), "USDG");
  const exec = await trade.executeTxs(cfg, chain, sell.txs, { liveConfirm: true });
  for (const r of exec) console.log("TX:", r.label, r.hash, "block", r.block, "gas", r.gasUsed);
  const wethAfter = await client.readContract({ address: WETH, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  const usdgAfter = await client.readContract({ address: USDG, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  console.log("WETH after:", wethAfter.toString(), "| USDG after:", usdgAfter.toString(), "(+", (usdgAfter - usdgBefore).toString(), "raw)");
  fs.appendFileSync(
    path.join(__dirname, "LOG.md"),
    `[${new Date().toISOString()}] [cleanup] Converted v1 WETH proceeds ${PROCEEDS_WEI.toString()} wei -> ${(usdgAfter - usdgBefore).toString()} USDG raw. Txs: ${exec.map((r) => r.hash).join(", ")}\n`
  );
  console.log("Done.");
}

main().catch((e) => { console.error("CONVERT FAILED:", e.message.slice(0, 500)); process.exit(1); });
