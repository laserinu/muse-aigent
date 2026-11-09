// run.js — Robinhood token sniper: watcher + evaluator + executor + position manager.
// Run by the cron every 2 minutes. Safe by default: it only BUYS when state.live === true.
// The user must explicitly approve live sniping ("Go") before state.live is set true.
// Usage: node run.js [--live] [--dry-run]
//   --live     : allow real buys (only if state.live is also true; otherwise still dry-run)
//   --dry-run  : force dry-run (evaluate + log only, no buys, no sells) [default]
//
// Flow per run:
//   1. Load STATE.json (creates it if missing).
//   2. If state.live is false, run in DRY-RUN mode: scan + evaluate + log "would BUY", no txs.
//   3. Scan PoolManager Initialize events from state.lastScannedBlock to latest.
//   4. For each new pool: evaluate it. If PASS and snipesDone < 5 and live -> buy 0.00001 ETH.
//      If PASS and dry-run -> log "would BUY".
//      If SKIP -> log the reason.
//   5. Position management: for each held token, compute current price vs buy price.
//      If >= +100% -> sell 50% (live) or log (dry-run). If <= -50% -> sell ALL (live) or log.
//   6. Save STATE.json, append to LOG.md.
const fs = require("fs");
const path = require("path");
const { createPublicClient, http, parseAbi, keccak256, toHex } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const { evaluatePool } = require("./evaluate.js");
const trade = require("./trade.js");

const DIR = "/home/hatch/workspace/tokens/sniper/robinhood";
const STATE_PATH = path.join(DIR, "STATE.json");
const LOG_PATH = path.join(DIR, "LOG.md");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const BUY_AMOUNT_WEI = 10000000000000n; // 0.00001 ETH
const MAX_SNIPES = 5;

const client = createPublicClient({ transport: http(RPC) });
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  return {
    live: false,
    snipesDone: 0,
    totalBuySpendWei: "0",
    lastScannedBlock: null,
    positions: [], // {token, symbol, decimals, poolId, poolKey, buyTx, buyAmountToken, buyPriceWethPerToken, buyBlock, soldHalf: bool, soldAll: bool}
    skipped: [], // {poolId, token, symbol, reason, block, at}
    createdAt: new Date().toISOString(),
  };
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function log(line) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${line}\n`);
  console.log(line);
}

// WETH per 1 whole token, from sqrtPriceX96.
function priceWethPerToken(sqrtP, tokenDecimals, wethIsCurrency0) {
  const ratio = Number(sqrtP) / 2 ** 96;
  const priceRaw = ratio * ratio;
  if (wethIsCurrency0) {
    // priceRaw = token per WETH (raw). WETH per whole token = 10^(D-18) / priceRaw
    return (10 ** (tokenDecimals - 18)) / priceRaw;
  } else {
    // priceRaw = WETH per token (raw). WETH per whole token = priceRaw * 10^(D-18)
    return priceRaw * 10 ** (tokenDecimals - 18);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const forceDry = args.includes("--dry-run");
  const wantLive = args.includes("--live");
  const state = loadState();
  const live = !forceDry && wantLive && state.live === true;
  log(`--- sniper run (mode: ${live ? "LIVE" : "DRY-RUN"}) ---`);
  if (wantLive && state.live !== true) {
    log("NOTE: --live requested but state.live is false (user has not approved live sniping). Running DRY-RUN.");
  }

  const latest = await client.getBlockNumber();
  const latestN = Number(latest);
  if (state.lastScannedBlock === null) {
    // First run: start from ~2 hours ago so we don't evaluate ancient pools.
    state.lastScannedBlock = latestN - 3600;
    log(`first run: starting scan at block ${state.lastScannedBlock} (latest ${latestN})`);
  }
  const fromBlock = state.lastScannedBlock + 1;
  if (fromBlock > latestN) { log("no new blocks since last scan"); saveState(state); return; }

  // Scan for Initialize events.
  // NOTE: viem's client.getLogs({topics:[...]}) IGNORES the topic filter on this RPC
  // (it returned 179-192 non-Initialize logs in a 100-block window where raw eth_getLogs
  // correctly returned 0). So we use raw eth_getLogs via client.request, which is proven
  // to filter correctly.
  const topic = keccak256(toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
  let logs = [];
  try {
    logs = await client.request({
      method: "eth_getLogs",
      params: [{
        address: POOL_MANAGER,
        topics: [topic],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + latestN.toString(16),
      }],
    });
    // Normalize to the shape the evaluator loop expects (topics[1] = poolId).
    logs = logs.map(l => ({ topics: l.topics, blockNumber: BigInt(l.blockNumber) }));
  } catch (e) {
    log("ERROR scanning Initialize events: " + e.message.slice(0, 200));
    saveState(state); return;
  }
  log(`scanned blocks ${fromBlock}..${latestN}: ${logs.length} new pool(s)`);
  state.lastScannedBlock = latestN;

  // Position management first (sell triggers) — only if we hold anything
  for (const pos of state.positions) {
    if (pos.soldAll) continue;
    try {
      const poolState = await trade.readPoolState(pos.poolId);
      const wethIsC0 = pos.poolKey.currency0.toLowerCase() === WETH;
      const curPrice = priceWethPerToken(BigInt(poolState.sqrtPriceX96), pos.decimals, wethIsC0);
      const buyPrice = Number(pos.buyPriceWethPerToken);
      const change = (curPrice - buyPrice) / buyPrice;
      const bal = await client.readContract({ address: pos.token, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] });
      log(`position ${pos.symbol} (${pos.token}): buy price ${buyPrice} WETH/token, current ${curPrice}, change ${(change * 100).toFixed(1)}%, agent balance ${bal.toString()}`);
      if (change >= 1.0 && !pos.soldHalf) {
        // +100%: sell 50%
        const half = bal / 2n;
        if (half > 0n) {
          if (live) {
            const sell = await trade.buildSell(pos.poolKey, pos.token, pos.decimals, half);
            const res = await trade.executeTxs(sell.txs);
            pos.soldHalf = true;
            log(`SOLD 50% of ${pos.symbol}: ${half.toString()} tokens. Txs: ${res.map(r => r.hash).join(", ")}`);
          } else {
            log(`DRY-RUN: would SELL 50% of ${pos.symbol} (${half.toString()} tokens) at +${(change * 100).toFixed(0)}%`);
          }
        }
      } else if (change <= -0.5) {
        // -50%: sell ALL remaining
        if (bal > 0n) {
          if (live) {
            const sell = await trade.buildSell(pos.poolKey, pos.token, pos.decimals, bal);
            const res = await trade.executeTxs(sell.txs);
            pos.soldAll = true;
            log(`SOLD ALL of ${pos.symbol}: ${bal.toString()} tokens (cut loss at ${(change * 100).toFixed(0)}%). Txs: ${res.map(r => r.hash).join(", ")}`);
          } else {
            log(`DRY-RUN: would SELL ALL of ${pos.symbol} (${bal.toString()} tokens) at ${(change * 100).toFixed(0)}% (cut loss)`);
          }
        }
      }
    } catch (e) {
      log(`position check error for ${pos.symbol}: ` + e.message.slice(0, 200));
    }
  }

  // Evaluate new pools
  const seenTokens = new Set(state.positions.map(p => p.token.toLowerCase()));
  for (const l of logs) {
    const poolId = l.topics[1];
    const block = Number(l.blockNumber);
    let ev;
    try {
      ev = await evaluatePool(poolId);
    } catch (e) {
      log(`pool ${poolId.slice(0, 18)}... block ${block}: EVALUATOR ERROR ${e.message.slice(0, 150)}`);
      continue;
    }
    const sym = ev.symbol || "?";
    if (ev.verdict !== "PASS") {
      log(`SKIP pool ${poolId.slice(0, 18)}... block ${block} token ${ev.token || "?"} (${sym}): ${ev.reason}`);
      state.skipped.push({ poolId, token: ev.token, symbol: sym, reason: ev.reason, block, at: new Date().toISOString() });
      continue;
    }
    // PASS
    if (seenTokens.has(ev.token.toLowerCase())) {
      log(`SKIP pool ${poolId.slice(0, 18)}... ${sym} (${ev.token}): already hold from a snipe`);
      state.skipped.push({ poolId, token: ev.token, symbol: sym, reason: "already hold from a snipe", block, at: new Date().toISOString() });
      continue;
    }
    if (state.snipesDone >= MAX_SNIPES) {
      log(`SKIP pool ${poolId.slice(0, 18)}... ${sym}: max snipes (${MAX_SNIPES}) reached`);
      state.skipped.push({ poolId, token: ev.token, symbol: sym, reason: "max snipes reached", block, at: new Date().toISOString() });
      continue;
    }
    // Check the agent has enough ETH for the buy + gas (0.00001 + ~0.00001 gas buffer)
    const ethBal = await client.getBalance({ address: AGENT });
    if (ethBal < BUY_AMOUNT_WEI + 10000000000n) {
      log(`SKIP ${sym}: agent ETH ${ethBal.toString()} too low for buy + gas`);
      state.skipped.push({ poolId, token: ev.token, symbol: sym, reason: "insufficient ETH", block, at: new Date().toISOString() });
      continue;
    }
    if (!live) {
      log(`DRY-RUN: would BUY ${sym} (${ev.token}) pool ${poolId.slice(0, 18)}... block ${block} — 0.00001 ETH. All checks passed. (No tx sent; set state.live=true + run --live to execute.)`);
      state.skipped.push({ poolId, token: ev.token, symbol: sym, reason: "dry-run (would buy)", block, at: new Date().toISOString() });
      continue;
    }
    // LIVE BUY
    try {
      const buy = await trade.buildBuy(ev.poolKey, ev.token, ev.decimals);
      const res = await trade.executeTxs(buy.txs);
      const buyTx = res[res.length - 1].hash;
      // Read the token balance to learn how much we received
      const balAfter = await client.readContract({ address: ev.token, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] });
      const buyPrice = 0.00001 / (Number(balAfter) / 10 ** ev.decimals); // WETH per whole token
      state.positions.push({
        token: ev.token, symbol: sym, decimals: ev.decimals, poolId, poolKey: ev.poolKey,
        buyTx, buyAmountToken: balAfter.toString(), buyPriceWethPerToken: buyPrice.toString(),
        buyBlock: Number(res[res.length - 1].block), soldHalf: false, soldAll: false,
        boughtAt: new Date().toISOString(),
      });
      state.snipesDone += 1;
      state.totalBuySpendWei = (BigInt(state.totalBuySpendWei) + BUY_AMOUNT_WEI).toString();
      seenTokens.add(ev.token.toLowerCase());
      log(`BOUGHT ${sym} (${ev.token}): 0.00001 ETH -> ${balAfter.toString()} tokens. Buy tx ${buyTx}. Snipes done: ${state.snipesDone}/${MAX_SNIPES}.`);
    } catch (e) {
      log(`BUY FAILED for ${sym} (${ev.token}): ` + e.message.slice(0, 300));
      state.skipped.push({ poolId, token: ev.token, symbol: sym, reason: "buy failed: " + e.message.slice(0, 150), block, at: new Date().toISOString() });
    }
  }

  saveState(state);
  log(`--- run done. snipesDone=${state.snipesDone}/${MAX_SNIPES}, positions=${state.positions.length}, skipped=${state.skipped.length} ---`);
}

main().catch(e => { console.error("RUNNER ERROR:", e); process.exit(1); });
