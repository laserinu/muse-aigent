// sell-all.js — sell ALL of every open v1 position (user-approved 2026-11-08 ~02:24 WIB).
// The five positions are dead launches (0 trades in 6h on Dexscreener); selling frees
// all five slots for new snipes. The v1 watcher cron must be PAUSED before running
// this, or its STATE.json save can clobber the soldAll flags.
// Usage: node sell-all.js          (dry-run: build each sell, print minOut, send nothing)
//        node sell-all.js --live   (execute all sells sequentially, update STATE.json after each)
const fs = require("fs");
const path = require("path");
const { createPublicClient, http, parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const trade = require("./trade.js");

const DIR = "/home/hatch/workspace/tokens/sniper/archive/robinhood-v1-20261108";
const STATE_PATH = path.join(DIR, "STATE.json");
const LOG_PATH = path.join(DIR, "LOG.md");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const client = createPublicClient({ transport: http(RPC) });
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const live = process.argv.includes("--live");
function log(line) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${line}\n`);
  console.log(line);
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const skip = new Set((process.env.SKIP_SYMBOLS || "").split(",").map((s) => s.trim()).filter(Boolean));
  const open = state.positions.filter((p) => !p.soldAll && !skip.has(p.symbol));
  log(`SELL-ALL ${live ? "LIVE" : "DRY-RUN"}: ${open.length} open position(s), snipesDone=${state.snipesDone}`);
  const wethBefore = await client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] });
  log(`agent WETH before: ${wethBefore.toString()}`);
  for (const pos of open) {
    const bal = await client.readContract({ address: pos.token, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] });
    log(`${pos.symbol} (${pos.token}): balance ${bal.toString()}`);
    if (bal === 0n) {
      pos.soldAll = true;
      log(`${pos.symbol}: balance 0, marking sold`);
      continue;
    }
    const sell = await trade.buildSell(pos.poolKey, pos.token, pos.decimals, bal);
    log(`${pos.symbol}: sell ${bal.toString()} tokens, minOut ${sell.amountOutMinimum} WETH wei`);
    if (!live) continue;
    const res = await trade.executeTxs(sell.txs);
    const wethAfter = await client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] });
    pos.soldAll = true;
    pos.sellTx = res[res.length - 1].hash;
    pos.sellTxs = res.map((r) => r.hash);
    pos.soldAt = new Date().toISOString();
    pos.soldAmountToken = bal.toString();
    pos.sellReason = "user-approved exit 2026-11-09: sell all sniping tokens, clean up";
    state.snipesDone = Math.max(0, state.snipesDone - 1);
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    log(`SOLD ALL ${pos.symbol}: ${bal.toString()} tokens -> WETH balance now ${wethAfter.toString()}. Txs: ${res.map((r) => r.hash).join(", ")}. snipesDone now ${state.snipesDone}`);
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  const wethAfterAll = await client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] });
  log(`agent WETH after: ${wethAfterAll.toString()} (delta ${(wethAfterAll - wethBefore).toString()} wei)`);
  log(`SELL-ALL ${live ? "LIVE" : "DRY-RUN"} done. snipesDone=${state.snipesDone}, open positions=${state.positions.filter((p) => !p.soldAll).length}`);
}
main().catch((e) => { console.error("SELL-ALL ERROR:", e); process.exit(1); });
