// One-off manual sell: ALL FOBO -> native ETH via the deep FOBO/ETH V4 pool
// (user order 2026-11-08 ~07:48 GMT+7, "For USD" — ETH is converted to USDG after).
// Why this pool: the FOBO/USDG pool we bought into has ZERO liquidity now
// (extsload liq = 0, verified against the healthy WETH/USDG + FOBO/ETH pools)
// — the LP was pulled after our buy, so the direct USDG sell reverts.
// PoolKey verified from the pool's Initialize log (block 98573047).
const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const trade = require("./trade.js");

const FOBO = "0x000de658153f47f23e92973c8eb1e89762703676";
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const POOL_ID = "0x32c50d83271c3af69696fe6b08def9c4f26d38b640da2cdb2a7c39acd8bbca5a";
const POOL_KEY = {
  poolId: POOL_ID,
  currency0: NATIVE_ETH,
  currency1: FOBO,
  fee: 0, // dynamic-fee hook pool (hook sets the fee)
  tickSpacing: 60,
  hooks: "0x0af57f62982d03066ef917acad87f771c06528ec",
};

async function main() {
  const cfg = chains.loadConfig();
  const statePath = path.join(__dirname, "STATE.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const pos = (state.positions || []).find((p) => p.symbol === "FOBO" && p.chainId === 4663);
  if (!pos) throw new Error("FOBO position not found in STATE.json");
  if (pos.soldAll) throw new Error("FOBO already marked soldAll — refusing to sell twice");

  const chain = { chainId: pos.chainId, ...cfg.chains[String(pos.chainId)] };
  const client = chains.makeClient(chain);
  const balBefore = await client.readContract({ address: FOBO, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  const ethBefore = await client.getBalance({ address: cfg.agent });
  console.log("FOBO balance:", balBefore.toString(), "=", (Number(balBefore) / 1e18).toFixed(6), "FOBO");
  console.log("ETH balance before:", ethBefore.toString());
  if (balBefore === 0n) throw new Error("FOBO balance is 0 — nothing to sell");

  const sell = await trade.buildSell(cfg, chain, POOL_KEY, FOBO, 18, { address: NATIVE_ETH, symbol: "ETH", decimals: 18 }, balBefore);
  console.log("minOut ETH (wei):", sell.amountOutMinimum, "=", (Number(sell.amountOutMinimum) / 1e18).toFixed(8), "ETH");
  const exec = await trade.executeTxs(cfg, chain, sell.txs, { liveConfirm: true });
  for (const r of exec) console.log("TX:", r.label, r.hash, "block", r.block, "gas", r.gasUsed);

  const balAfter = await client.readContract({ address: FOBO, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  const ethAfter = await client.getBalance({ address: cfg.agent });
  console.log("FOBO balance after:", balAfter.toString());
  console.log("ETH balance after:", ethAfter.toString(), "(delta", (ethAfter - ethBefore).toString(), "wei, incl. gas spent)");

  pos.soldAll = true;
  pos.sellTxHashes = exec.map((r) => r.hash);
  pos.soldAt = Date.now();
  pos.sellRoute = "FOBO->ETH via FOBO/ETH V4 pool 0x32c50d83 (USDG pool dead, liq 0)";
  pos.sellEthReceivedWei = (ethAfter - ethBefore).toString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const logLine = `[${new Date().toISOString()}] [position Robinhood] SOLD ALL of FOBO (manual, user order) via ETH pool: ${balBefore.toString()} tokens. Txs: ${exec.map((r) => r.hash).join(", ")}\n`;
  fs.appendFileSync(path.join(__dirname, "LOG.md"), logLine);
  console.log("STATE.json + LOG.md updated. Done.");
}

main().catch((e) => { console.error("SELL FAILED:", e.message.slice(0, 500)); process.exit(1); });
