// One-off manual sell: ALL FOBO -> USDG on Robinhood (user order 2026-11-08 ~07:48 GMT+7).
// Reuses trade.buildSell / trade.executeTxs (same path the runner's sell-all uses).
// Records the result in STATE.json (soldAll) and LOG.md.
const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const trade = require("./trade.js");

async function main() {
  const cfg = chains.loadConfig();
  const statePath = path.join(__dirname, "STATE.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const pos = (state.positions || []).find((p) => p.symbol === "FOBO" && p.chainId === 4663);
  if (!pos) throw new Error("FOBO position not found in STATE.json");
  if (pos.soldAll) throw new Error("FOBO already marked soldAll — refusing to sell twice");

  const chain = { chainId: pos.chainId, ...cfg.chains[String(pos.chainId)] };
  const client = chains.makeClient(chain);
  const usdg = pos.quote.address;
  const balBefore = await client.readContract({ address: pos.token, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  const usdgBefore = await client.readContract({ address: usdg, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  console.log("FOBO balance:", balBefore.toString(), "raw =", (Number(balBefore) / 1e18).toFixed(6), "FOBO");
  console.log("USDG balance before:", usdgBefore.toString());
  if (balBefore === 0n) throw new Error("FOBO balance is 0 — nothing to sell");

  const sell = await trade.buildSell(cfg, chain, pos.poolKey, pos.token, pos.decimals, pos.quote, balBefore);
  console.log("minOut USDG (raw):", sell.amountOutMinimum, "=", (Number(sell.amountOutMinimum) / 1e6).toFixed(6), "USDG");
  const exec = await trade.executeTxs(cfg, chain, sell.txs, { liveConfirm: true });
  for (const r of exec) console.log("TX:", r.label, r.hash, "block", r.block, "gas", r.gasUsed);

  const balAfter = await client.readContract({ address: pos.token, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  const usdgAfter = await client.readContract({ address: usdg, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
  console.log("FOBO balance after:", balAfter.toString());
  console.log("USDG balance after:", usdgAfter.toString(), "(+", (usdgAfter - usdgBefore).toString(), "raw)");

  pos.soldAll = true;
  pos.sellTxHashes = exec.map((r) => r.hash);
  pos.soldAt = Date.now();
  pos.sellUsdgReceivedRaw = (usdgAfter - usdgBefore).toString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const logLine = `[${new Date().toISOString()}] [position Robinhood] SOLD ALL of FOBO (manual, user order): ${balBefore.toString()} tokens -> ${(usdgAfter - usdgBefore).toString()} USDG raw. Txs: ${exec.map((r) => r.hash).join(", ")}\n`;
  fs.appendFileSync(path.join(__dirname, "LOG.md"), logLine);
  console.log("STATE.json + LOG.md updated. Done.");
}

main().catch((e) => { console.error("SELL FAILED:", e.message); process.exit(1); });
