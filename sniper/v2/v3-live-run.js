// v3-live-run.js — Live V3 watcher (Robinhood Chain only).
//
// Built 2026-11-08 ~03:38 WIB for the live V3 wiring (separate V3 cap of
// 5, user delegated the decision to the parent). Execution via the
// V3SwapHelper contract (see v3-helper-trade.js) — the PROVEN V3 path.
// The Universal Router builders in v3-trade.js are DEAD and are NOT used.
//
// One run:
//   1. Scan the Robinhood V3 factory for new PoolCreated events from
//      v3-STATE.json lastScannedBlock (or the last --window-blocks).
//   2. Evaluate each new pool (v3.js: hard gates + 0-100 score, incl.
//      the LP-locked NPM ownerOf check).
//      - PASS + size full/half + live -> buy $0.02 via the helper.
//      - PASS + size full/half + dry-run -> log "would BUY".
//      - PASS + size watch -> log watch-only (score breakdown).
//      - SKIP -> log the reason.
//   3. Social re-check: pools that had info:null at detection are
//      re-scored at +10 min (config.social.recheckMinutes).
//   4. Position management: for each held V3 token, current price vs buy
//      price. +100% -> sell 50% (live) or log (dry-run). -50% -> sell ALL.
//   5. Save v3-STATE.json, append to v3-LIVE-LOG.md.
//
// LIVE is off by default (v3-STATE.json live=false). A run only sends real
// transactions when --live is passed AND v3-STATE.json live=true AND
// config.live=true AND chain 4663 live=true AND the runner passes
// { liveConfirm: true }. In dry-run NOTHING is sent — the runner only
// reads, evaluates, and logs. The dry-run path NEVER calls sendTx.
//
// V3 cap: 5 positions on Robinhood, tracked separately as v3SnipesDone in
// v3-STATE.json. V3 buys do NOT count toward v2's snipesDone.
// Half-sizing is NOT wired (same as v2): full $0.02 for every buy.
//
// Usage:
//   node v3-live-run.js                          # dry-run, from watermark
//   node v3-live-run.js --window-blocks 2000    # dry-run, last 2000 blocks
//   node v3-live-run.js --live                   # LIVE (requires all live flags)

const fs = require("fs");
const path = require("path");
const { parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const chains = require("./chains.js");
const v3 = require("./v3.js");
const trade = require("./trade.js");
const helperTrade = require("./v3-helper-trade.js");
const social = require("./social.js");

const DIR = "/home/hatch/workspace/tokens/sniper/v2";
const STATE_PATH = path.join(DIR, "v3-STATE.json");
const LOG_PATH = path.join(DIR, "v3-LIVE-LOG.md");
const V3_CAP = 5; // separate V3 cap — independent of v2's per-chain cap
const MAX_EVALS_PER_RUN = 30;

const DELTA_TOKEN = "0xe8ffd7e24187f72afb08d75b1bb13088a989a791";
const DELTA_POOL = "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94";
const WETH_RH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  return {
    version: 1, poolType: "V3", chainId: 4663, live: false,
    lastScannedBlock: null, v3SnipesDone: 0,
    positions: [], pendingRechecks: [], evaluated: [], wouldBuys: [],
  };
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// Memory disposition update (2026-11-08): fail-open, never throws.
function memUpdate(chainId, token, decision, extra) {
  try { require("./memory.js").updateDecision(chainId, token, decision, extra); } catch { /* fail-open */ }
}

function parseArgs() {
  const args = { windowBlocks: null, fromBlock: null, toBlock: null, live: false, controlDelta: true };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--live") args.live = true;
    else if (a === "--window-blocks" && process.argv[i + 1]) args.windowBlocks = Number(process.argv[++i]);
    else if (a.startsWith("--window-blocks=")) args.windowBlocks = Number(a.slice(16));
    else if (a === "--from-block" && process.argv[i + 1]) args.fromBlock = Number(process.argv[++i]);
    else if (a === "--to-block" && process.argv[i + 1]) args.toBlock = Number(process.argv[++i]);
    else if (a === "--no-control-delta") args.controlDelta = false;
  }
  return args;
}

// Current price of a held V3 token in quote units, from pool slot0.
// Mirrors run.js priceQuotePerToken (V4): quote-per-token, multiplier-free
// for the relative change the sell rules use.
function priceQuotePerTokenV3(poolState, pos) {
  const sqrtP = BigInt(poolState.sqrtPriceX96);
  const quoteIsToken0 = pos.token0.toLowerCase() === pos.quote.address.toLowerCase();
  const dec0 = quoteIsToken0 ? pos.quote.decimals : pos.decimals;
  const dec1 = quoteIsToken0 ? pos.decimals : pos.quote.decimals;
  const spot = chains.priceFromSqrt(sqrtP, dec0, dec1); // human token1 per token0
  return quoteIsToken0 ? 1 / spot : spot;
}

function verdictLine(chainName, res) {
  const sym = res.symbol || res.token?.slice(0, 10) || "?";
  const scoreLine = (res.scores || []).map((s) => `${s.component}:${s.points}`).join(" ");
  if (res.verdict === "SKIP") return `[${chainName}] SKIP ${sym} ${res.token} pool ${res.poolAddress} — ${res.reason}`;
  if (res.size === "watch") return `[${chainName}] WATCH ${sym} ${res.token} pool ${res.poolAddress} — score ${res.score}/100 (${scoreLine}) — below threshold, no buy`;
  return `[${chainName}] would BUY ${sym} ${res.token} pool ${res.poolAddress} — score ${res.score}/100 size ${res.size} (${scoreLine}) — DRY-RUN, no tx sent`;
}

// attemptV3Buy — the ONE V3 buy path for first-sight and recheck buys
// alike (Part 52 fix — mirrors run.js attemptBuy).
// Returns "bought" | "would-buy" | "cap-skip" | "balance-skip".
// Throws on build/execute failure — the caller logs BUY FAILED.
//   - Dry-run: logs "would BUY" + records state.wouldBuys, sends nothing.
//   - Live: V3 cap check (5) -> buildV3HelperBuy -> balance guard (WETH
//     buys can wrap from ETH) -> executeV3HelperTxs -> record position.
//   - `summary` (optional) gets wouldBuys/buys counted; `origin` is an
//     optional log tag ("recheck"), omitted for first-sight buys.
async function attemptV3Buy(cfg, chain, state, client, pool, res, live, summary, origin) {
  const sym = res.symbol || res.token?.slice(0, 10) || "?";
  const tag = origin ? ` [${origin}]` : "";
  if (!live) {
    if (summary) summary.wouldBuys++;
    log(verdictLine(chain.name, res) + tag);
    if (!state.wouldBuys.some((w) => w.pool === pool.pool)) {
      state.wouldBuys.push({ pool: pool.pool, token: res.token, symbol: res.symbol, score: res.score, size: res.size });
    }
    return "would-buy";
  }
  if (state.v3SnipesDone >= V3_CAP) {
    log(`[Robinhood] CAP ${sym} score ${res.score} size ${res.size} — V3 cap ${V3_CAP} reached, skipped${tag}`);
    memUpdate(4663, res.token, "cap-skip");
    return "cap-skip";
  }
  const buy = await helperTrade.buildV3HelperBuy(cfg, chain, pool.pool, res.token, res.decimals, res.quote);
  // Balance guard: WETH buys can wrap from ETH; other quotes need the
  // ERC-20 balance on hand. BALANCE-SKIP never counts as a snipe.
  const amountIn = BigInt(buy.amountIn);
  const isWeth = res.quote.address.toLowerCase() === WETH_RH.toLowerCase();
  let available;
  if (isWeth) {
    const [wethBal, ethBal] = await Promise.all([
      client.readContract({ address: WETH_RH, abi: ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] }).catch(() => 0n),
      client.getBalance({ address: cfg.agent }),
    ]);
    available = wethBal + ethBal;
  } else {
    available = await client.readContract({ address: res.quote.address, abi: ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] }).catch(() => 0n);
  }
  if (available < amountIn) {
    log(`[Robinhood] BALANCE-SKIP ${sym} score ${res.score} — agent holds ${available} ${res.quote.symbol} (raw, incl. wrappable ETH for WETH), needs ${amountIn} for a $${cfg.buySizeUsd} buy; skipped, no tx sent${tag}`);
    memUpdate(4663, res.token, "balance-skip");
    return "balance-skip";
  }
  const exec = await helperTrade.executeV3HelperTxs(cfg, chain, buy.txs, {
    liveConfirm: true, v3Live: state.live,
    fundToken: res.quote.address, fundAmount: buy.amountIn,
  });
  state.v3SnipesDone += 1;
  if (summary) summary.buys++;
  // Buy price: post-buy spot if readable, else the pre-buy spot implied
  // by the build (minOut = spot x 0.80). Never lose the position over a
  // read error (v2 fix, 2026-11-07).
  let buyPrice = null;
  let priceSource = "post-buy";
  let stAfter = null;
  try {
    stAfter = await v3.readV3PoolState(client, pool.pool);
    buyPrice = priceQuotePerTokenV3(stAfter, {
      token0: stAfter.token0, quote: res.quote, decimals: res.decimals,
    });
  } catch (e) {
    priceSource = "pre-buy-spot";
    const spotOut = (BigInt(buy.amountOutMinimum) * 100n) / 80n;
    buyPrice = (Number(BigInt(buy.amountIn)) * 10 ** res.decimals) / (Number(spotOut) * 10 ** res.quote.decimals);
  }
  state.positions.push({
    chainId: 4663, poolType: "V3", symbol: sym, token: res.token, decimals: res.decimals,
    token0: stAfter ? stAfter.token0 : pool.token0, token1: stAfter ? stAfter.token1 : pool.token1, poolAddress: pool.pool, fee: stAfter ? stAfter.fee : pool.fee,
    quote: { symbol: res.quote.symbol, address: res.quote.address, decimals: res.quote.decimals },
    buyPriceQuotePerToken: buyPrice, buyPriceSource: priceSource,
    amountIn: buy.amountIn, buyTxHashes: exec.map((r) => r.hash),
    boughtAt: Date.now(), soldHalf: false, soldAll: false,
  });
  log(`[Robinhood] BOUGHT ${sym} score ${res.score} size ${res.size} — $${cfg.buySizeUsd} ${res.quote.symbol} in via helper. Buy price ${buyPrice} ${res.quote.symbol}/token (${priceSource}). Txs: ${exec.map((r) => r.hash).join(", ")}${tag}`);
  memUpdate(4663, res.token, "buy", { buyTx: exec[0] ? exec[0].hash : null, buyAmountIn: buy.amountIn });
  return "bought";
}

// processV3Rechecks — the FIXED +10 min V3 recheck (Part 52, mirrors
// run.js processRechecks). Re-runs the FULL V3 evaluation with fresh data
// (v3.evaluateV3Pool — Part 51 gates included) and, at/above the buy
// line, runs the normal V3 buy path. Below the line: log + drop. Errors:
// log + drop (fail-open). Legacy entries (no token0): social-only + drop.
// Same-pool duplicate guard: never re-buy an already-held pool.
// deps (tests only): { evaluateV3Pool, attemptV3Buy, scoreSocial, log }.
// Returns { stillPending, stats }.
async function processV3Rechecks(cfg, state, live, deps = {}) {
  const evaluate = deps.evaluateV3Pool || v3.evaluateV3Pool;
  const buy = deps.attemptV3Buy || attemptV3Buy;
  const scoreSocialFn = deps.scoreSocial || social.scoreSocial;
  const logFn = deps.log || log;
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const recheckAfterMs = (cfg.social?.recheckMinutes || 10) * 60 * 1000;
  const buyLine = cfg.scoreThresholds?.half ?? 45;
  const stillPending = [];
  const stats = { due: 0, reevaluated: 0, bought: 0, wouldBuy: 0, noBuy: 0, skipped: 0, legacy: 0, errors: 0 };
  for (const p of state.pendingRechecks || []) {
    if (Date.now() - p.detectedAt < recheckAfterMs) { stillPending.push(p); continue; }
    stats.due++;
    if (!p.token0 || !p.token1) {
      stats.legacy++;
      try {
        const s = await scoreSocialFn(chain.dexscreenerSlug, p.token, cfg);
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — social re-check at +10 min: ${s.points}/25 (${s.detail}) [legacy entry, no token0/token1 — full re-evaluation unavailable, dropped]`);
      } catch (e) {
        logFn(`[recheck ${chain.name}] ${p.symbol} — re-check errored: ${e.message.slice(0, 120)}`);
      }
      continue;
    }
    try {
      const pool = {
        pool: p.poolAddress, token0: p.token0, token1: p.token1,
        fee: p.fee, tickSpacing: p.tickSpacing,
        blockNumber: p.blockNumber, txHash: p.txHash,
      };
      const res = await evaluate(cfg, chain, pool);
      stats.reevaluated++;
      const scoreLine = (res.scores || []).map((s) => `${s.component}:${s.points}`).join(" ");
      if (res.verdict === "SKIP") {
        stats.skipped++;
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 (${scoreLine}) but SKIP: ${res.reason} (was ${p.initialScore ?? "?"}/100 at detection) — dropped`);
        memUpdate(4663, res.token, "recheck-skip");
        continue;
      }
      if (res.size === "watch") {
        stats.noBuy++;
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 (${scoreLine}) below ${buyLine} (was ${p.initialScore ?? "?"}/100 at detection) — dropped`);
        memUpdate(4663, res.token, "recheck-watch");
        continue;
      }
      const alreadyHeld = (state.positions || []).some((pos) =>
        pos.poolAddress === p.poolAddress && pos.token.toLowerCase() === res.token.toLowerCase());
      if (alreadyHeld) {
        stats.noBuy++;
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 but already held from this pool — recheck buy skipped, dropped`);
        continue;
      }
      logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 (${scoreLine}) from ${p.initialScore ?? "?"}/100 at detection`);
      const outcome = await buy(cfg, chain, state, client, pool, res, live, null, "recheck");
      if (outcome === "bought") stats.bought++;
      else if (outcome === "would-buy") stats.wouldBuy++;
    } catch (e) {
      stats.errors++;
      logFn(`[recheck ${chain.name}] ${p.symbol} — re-check errored: ${e.message.slice(0, 150)} — dropped (fail-open)`);
    }
  }
  return { stillPending, stats };
}

async function main() {
  const cfg = chains.loadConfig();
  const args = parseArgs();
  const state = loadState();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const live = args.live && state.live === true && cfg.live === true && chain.live === true;
  if (args.live && !live) {
    log("LIVE REQUESTED but a live flag is off (need --live AND v3-STATE.json live=true AND config.live=true AND chain 4663 live=true) — running DRY-RUN instead.");
  }
  log(`=== v3 live-run start (live=${live}, Robinhood only, v3SnipesDone=${state.v3SnipesDone}/${V3_CAP}) ===`);

  let latest;
  try { latest = Number(await client.getBlockNumber()); }
  catch (e) { log(`[Robinhood] ERROR reading latest block: ${e.message.slice(0, 150)}`); return; }
  const toBlock = args.toBlock || latest;
  const fromBlock = args.fromBlock || (args.windowBlocks ? Math.max(0, toBlock - args.windowBlocks) : (state.lastScannedBlock ?? toBlock) + 1);
  if (fromBlock > toBlock) {
    log(`[Robinhood] no new blocks (last ${state.lastScannedBlock}, latest ${toBlock})`);
  } else {
    let pools;
    try {
      pools = await v3.scanV3Pools(chain, fromBlock, toBlock);
    } catch (e) {
      log(`[Robinhood] ERROR scanning PoolCreated events: ${e.message.slice(0, 200)}`);
      pools = null;
    }
    if (pools) {
      log(`[Robinhood] scanned blocks ${fromBlock}..${toBlock}: ${pools.length} new V3 pool(s)`);
      state.lastScannedBlock = toBlock;
      const summary = { found: pools.length, evaluated: 0, skipped: 0, watch: 0, wouldBuys: 0, buys: 0, pons: 0 };
      const toEval = pools.slice(0, MAX_EVALS_PER_RUN);
      if (pools.length > toEval.length) log(`[Robinhood] ${pools.length - toEval.length} pool(s) left unevaluated this run (cap ${MAX_EVALS_PER_RUN})`);
      for (const pool of toEval) {
        let res;
        try {
          res = await v3.evaluateV3Pool(cfg, chain, pool);
        } catch (e) {
          log(`[Robinhood] ${pool.pool} EVALUATOR ERROR: ${e.message.slice(0, 200)}`);
          continue;
        }
        summary.evaluated++;
        if (res.pons && res.pons.pons) summary.pons++;
        const sym = res.symbol || res.token?.slice(0, 10) || "?";
        state.evaluated.push({ pool: pool.pool, token: res.token, symbol: res.symbol, score: res.score, size: res.size, verdict: res.verdict, reason: res.reason, pons: !!(res.pons && res.pons.pons), blockNumber: pool.blockNumber, txHash: pool.txHash });
        if (res.verdict === "SKIP") { summary.skipped++; log(verdictLine(chain.name, res)); continue; }
        if (res.size === "watch") { summary.watch++; log(verdictLine(chain.name, res)); continue; }
        // PASS full/half — the ONE V3 buy path (attemptV3Buy).
        let bought = false;
        try {
          const outcome = await attemptV3Buy(cfg, chain, state, client, pool, res, live, summary);
          bought = outcome === "bought";
          // cap-skip / balance-skip never queued (as before).
          if (outcome === "cap-skip" || outcome === "balance-skip") continue;
        } catch (e) {
          log(`[Robinhood] BUY FAILED ${sym}: ${e.message.slice(0, 200)}`);
        }
        // Social re-check queue (Part 52: full re-evaluation + buy path).
        // Tokens just bought are NOT queued — the recheck exists to catch
        // tokens that did NOT buy at detection; the recheck loop also
        // guards against re-buying an already-held pool. Pool fields are
        // stored so the recheck can rebuild the pool object.
        if (res.social && res.social.infoPresent === false && !bought) {
          state.pendingRechecks.push({
            chainId: 4663, poolAddress: pool.pool, token: res.token, symbol: sym,
            detectedAt: Date.now(), quote: res.quote,
            initialScore: res.score, initialScores: res.scores,
            token0: pool.token0, token1: pool.token1, fee: pool.fee,
            tickSpacing: pool.tickSpacing, blockNumber: pool.blockNumber, txHash: pool.txHash,
          });
        }
      }
      log(`=== v3 scan summary: found ${summary.found}, evaluated ${summary.evaluated}, skipped ${summary.skipped}, watch ${summary.watch}, would-buy ${summary.wouldBuys}, BOUGHT ${summary.buys}, Pons-attributed ${summary.pons} ===`);
    }
  }

  // DELTA control (dry-run only): proves detection + scoring still work.
  if (!live && args.controlDelta) {
    log(`--- DELTA control ---`);
    try {
      const poolAddr = await client.readContract({ address: v3.V3_FACTORY_RH, abi: v3.V3_FACTORY_ABI, functionName: "getPool", args: [DELTA_TOKEN, WETH_RH, 10000] });
      log(`[control] DELTA V3 pool via factory.getPool(DELTA, WETH, 10000): ${poolAddr} (expected ${DELTA_POOL})`);
      const st = await v3.readV3PoolState(client, poolAddr);
      const pool = { token0: st.token0, token1: st.token1, fee: st.fee, tickSpacing: st.tickSpacing, pool: poolAddr.toLowerCase(), blockNumber: 24555353, txHash: "0x301f5b492bdf3f985f7f0d37d1616b07df53f8325f03407be7805412be598e87", logIndex: 0 };
      const res = await v3.evaluateV3Pool(cfg, chain, pool);
      log(`[control] ` + verdictLine(chain.name, res));
      if (res.pons) log(`[control]   attribution: ${res.pons.evidence}`);
    } catch (e) {
      log(`[control] DELTA control FAILED: ${e.message.slice(0, 200)}`);
    }
  }

  // Social re-checks due (+10 min after detection) — Part 52: full
  // re-evaluation + normal V3 buy path (processV3Rechecks).
  const { stillPending, stats: recheckStats } = await processV3Rechecks(cfg, state, live);
  state.pendingRechecks = stillPending;
  log(`[recheck] due ${recheckStats.due}, re-evaluated ${recheckStats.reevaluated}, bought ${recheckStats.bought}, would-buy ${recheckStats.wouldBuy}, no-buy ${recheckStats.noBuy}, skipped ${recheckStats.skipped}, legacy ${recheckStats.legacy}, errors ${recheckStats.errors}`);

  // Position management (sell rules). Dry-run logs only.
  for (const pos of state.positions || []) {
    if (pos.soldAll) continue;
    try {
      const st = await v3.readV3PoolState(client, pos.poolAddress);
      const cur = priceQuotePerTokenV3(st, pos);
      const change = (cur - pos.buyPriceQuotePerToken) / pos.buyPriceQuotePerToken;
      log(`[position ${chain.name}] ${pos.symbol}: buy ${pos.buyPriceQuotePerToken} ${pos.quote.symbol}/token, current ${cur.toExponential(3)}, change ${(change * 100).toFixed(1)}%`);
      if (change >= (cfg.sellHalfAt ?? 1.0) && !pos.soldHalf) {
        if (live) {
          try {
            const bal = await client.readContract({ address: pos.token, abi: ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
            const half = bal / 2n;
            if (half > 0n) {
              const sell = await helperTrade.buildV3HelperSell(cfg, chain, pos.poolAddress, pos.token, pos.decimals, pos.quote, half);
              const exec = await helperTrade.executeV3HelperTxs(cfg, chain, sell.txs, { liveConfirm: true, v3Live: state.live, fundToken: pos.token, fundAmount: half.toString() });
              pos.soldHalf = true;
              log(`[position ${chain.name}] SOLD 50% of ${pos.symbol}: ${half.toString()} tokens. Txs: ${exec.map((r) => r.hash).join(", ")}`);
            }
          } catch (e) {
            log(`[position ${chain.name}] SELL 50% FAILED ${pos.symbol}: ${e.message.slice(0, 200)}`);
          }
        } else {
          log(`[position ${chain.name}] would SELL 50% of ${pos.symbol} at +${(change * 100).toFixed(0)}% — DRY-RUN`);
        }
      } else if (change <= (cfg.sellAllAt ?? -0.5)) {
        if (live) {
          try {
            const bal = await client.readContract({ address: pos.token, abi: ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
            if (bal > 0n) {
              const sell = await helperTrade.buildV3HelperSell(cfg, chain, pos.poolAddress, pos.token, pos.decimals, pos.quote, bal);
              const exec = await helperTrade.executeV3HelperTxs(cfg, chain, sell.txs, { liveConfirm: true, v3Live: state.live, fundToken: pos.token, fundAmount: bal.toString() });
              pos.soldAll = true;
              log(`[position ${chain.name}] SOLD ALL of ${pos.symbol}: ${bal.toString()} tokens at ${(change * 100).toFixed(0)}%. Txs: ${exec.map((r) => r.hash).join(", ")}`);
            }
          } catch (e) {
            log(`[position ${chain.name}] SELL ALL FAILED ${pos.symbol}: ${e.message.slice(0, 200)}`);
          }
        } else {
          log(`[position ${chain.name}] would SELL ALL of ${pos.symbol} at ${(change * 100).toFixed(0)}% — DRY-RUN`);
        }
      }
    } catch (e) {
      log(`[position ${chain.name}] ${pos.symbol} check failed: ${e.message.slice(0, 150)}`);
    }
  }

  saveState(state);
  log("=== v3 live-run end ===");
}

if (require.main === module) {
  main().catch((e) => { console.error("V3 LIVE RUNNER ERROR:", e); process.exit(1); });
}

module.exports = { attemptV3Buy, processV3Rechecks };
