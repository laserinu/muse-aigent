// run.js — Sniper v2 watcher (chain-agnostic, DRY-RUN by default).
//
// One run:
//   1. For each enabled chain (or --chains list): scan PoolManager
//      Initialize events from state.lastScannedBlock[chainId] to latest
//      (or the last --window-blocks, for tests).
//   2. For each new pool: evaluate it (hard gates + 0-100 score).
//      - PASS + size full/half + live -> build + execute the buy.
//      - PASS + size full/half + dry-run -> log "would BUY".
//      - PASS + size watch -> log watch-only (score breakdown).
//      - SKIP -> log the reason.
//   3. Social re-check: pools that had info:null at detection are
//      re-scored at +10 min (config.social.recheckMinutes).
//   4. Position management: for each held token, current price vs buy
//      price. +100% -> sell 50% (live) or log (dry-run). -50% -> sell ALL.
//   5. Save STATE.json, append to LOG.md.
//
// LIVE is off by default (config.live=false, chain.live=false). A run only
// sends real transactions when --live is passed AND config.live AND
// chain.live are all true AND trade.js's own gate passes. In dry-run
// NOTHING is sent — the runner only reads, evaluates, and logs.
//
// Usage:
//   node run.js                          # dry-run, all enabled chains
//   node run.js --chains 4663,8453      # dry-run, subset
//   node run.js --window-blocks 300     # dry-run over the last 300 blocks
//   node run.js --live                   # LIVE (requires all live flags)

const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const { evaluatePool } = require("./evaluate.js");
const trade = require("./trade.js");
const social = require("./social.js");

const DIR = "/home/hatch/workspace/tokens/sniper/v2";
const STATE_PATH = path.join(DIR, "STATE.json");
const LOG_PATH = path.join(DIR, "LOG.md");
const MAX_EVALS_PER_CHAIN_PER_RUN = 30;

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  return { live: false, version: 2, lastScannedBlock: {}, positions: [], pendingRechecks: [], snipesDone: {} };
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// Memory disposition update (2026-11-08): record the runner's final
// decision for a scored pool. Fail-open — never throws, never blocks.
function memUpdate(chainId, token, decision, extra) {
  try { require("./memory.js").updateDecision(chainId, token, decision, extra); } catch { /* fail-open */ }
}

function parseArgs() {
  const args = { chains: null, windowBlocks: null, live: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--live") args.live = true;
    else if (a === "--chains" && process.argv[i + 1]) args.chains = process.argv[++i].split(",").map(Number);
    else if (a.startsWith("--chains=")) args.chains = a.slice(9).split(",").map(Number);
    else if (a === "--window-blocks" && process.argv[i + 1]) args.windowBlocks = Number(process.argv[++i]);
    else if (a.startsWith("--window-blocks=")) args.windowBlocks = Number(a.slice(16));
  }
  return args;
}

// Current price of a held token in quote units, from pool sqrtPriceX96.
// NOTE (2026-11-07, expanded quotes): this returns quote-per-token in RAW
// units of both tokens. For a stock quote (ERC-8056) the uiMultiplier scales
// the buy-time price AND the current price identically, so the RELATIVE change
// (what the sell rules use) is multiplier-invariant — no conversion needed.
function priceQuotePerToken(state, pos) {
  const sqrtP = BigInt(state.sqrtPriceX96);
  const dec0 = pos.poolKey.currency0.toLowerCase() === pos.quote.address.toLowerCase() ? pos.quote.decimals : pos.decimals;
  const dec1 = pos.poolKey.currency0.toLowerCase() === pos.quote.address.toLowerCase() ? pos.decimals : pos.quote.decimals;
  const spot = chains.priceFromSqrt(sqrtP, dec0, dec1); // human token1 per token0
  // quote per token: if quote is currency1, spot IS quote/token; if quote is
  // currency0, quote/token is 1/spot. (An earlier version had these branches
  // swapped, returning token-per-quote — which INVERTED the sell triggers:
  // a 2x pump read as -50% and a 50% crash read as +100%. Fixed 2026-11-07.)
  return pos.poolKey.currency0.toLowerCase() === pos.quote.address.toLowerCase() ? 1 / spot : spot;
}

// attemptBuy — the ONE buy path for first-sight and recheck buys alike
// (Part 52 fix: the recheck used to only re-score socials and never buy).
// Returns "bought" | "would-buy" | "cap-skip" | "balance-skip".
// Throws on build/execute failure — the caller logs BUY FAILED.
//   - Dry-run (live=false or chain.live=false): logs "would BUY", sends nothing.
//   - Live: cap check (5/chain) -> balance guard -> buildBuy -> executeTxs
//     -> record position -> memUpdate "buy".
//   - `origin` is an optional log tag ("recheck"); omitted for first-sight
//     buys so their log lines stay byte-identical to before.
//   - Buy-price fallback chain (never lose a position over a read error,
//     v2 fix 2026-11-07): post-buy pool read -> init-event sqrtPriceX96 ->
//     the evaluator's spot price (res.spotQuotePerToken).
async function attemptBuy(cfg, chain, state, client, pool, res, live, origin) {
  const sym = res.symbol || res.token?.slice(0, 10) || "?";
  const scoreLine = (res.scores || []).map((s) => `${s.component}:${s.points}`).join(" ");
  const tag = origin ? ` [${origin}]` : "";
  if (!(live && chain.live === true)) {
    log(`[${chain.name}] would BUY ${sym} ${res.token} — score ${res.score}/100 size ${res.size} (${scoreLine})${tag} — DRY-RUN, no tx sent`);
    return "would-buy";
  }
  const done = state.snipesDone[String(chain.chainId)] || 0;
  if (done >= (cfg.capPerChain || 5)) {
    log(`[${chain.name}] CAP ${sym} score ${res.score} size ${res.size} — cap ${cfg.capPerChain} reached, skipped${tag}`);
    memUpdate(chain.chainId, res.token, "cap-skip");
    return "cap-skip";
  }
  // Pre-buy balance guard (added 2026-11-07, expanded quotes): the agent
  // holds 0 of every new quote (DAI/WBTC/stock tokens). A passing pool
  // would otherwise burn gas on a doomed approve. BALANCE-SKIP logs and
  // moves on — never counts as a snipe.
  const guard = await trade.checkQuoteBalance(cfg, chain, res.quote);
  if (!guard.ok) {
    log(`[${chain.name}] BALANCE-SKIP ${sym} score ${res.score} — agent holds ${guard.balance} ${res.quote.symbol} (raw), needs ${guard.amountIn} for a $${cfg.buySizeUsd} buy; skipped, no tx sent${tag}`);
    memUpdate(chain.chainId, res.token, "balance-skip");
    return "balance-skip";
  }
  const buy = await trade.buildBuy(cfg, chain, res.poolKey, res.token, res.decimals, res.quote);
  const exec = await trade.executeTxs(cfg, chain, buy.txs, { liveConfirm: true });
  state.snipesDone[String(chain.chainId)] = done + 1;
  // Record the position (fix 2026-11-07): buys previously never entered
  // state.positions, so the +100% sell-half / −50% sell-all rules could
  // never fire. Buy price is read from the pool right after the buy
  // (post-buy spot); falls back to the Initialize-event price if the
  // fresh read fails — never lose the position over a read error.
  // Dry-run "would BUY" intentionally records NOTHING (nothing was bought).
  let buyPrice = null;
  let priceSource = "post-buy";
  try {
    const stAfter = await chains.readPoolState(client, chain.poolManager, pool.poolId);
    buyPrice = priceQuotePerToken(stAfter, { poolKey: res.poolKey, quote: res.quote, decimals: res.decimals });
  } catch (e) {
    try {
      priceSource = "init-event";
      buyPrice = priceQuotePerToken({ sqrtPriceX96: pool.sqrtPriceX96 }, { poolKey: res.poolKey, quote: res.quote, decimals: res.decimals });
    } catch {
      if (res.spotQuotePerToken) { priceSource = "eval-spot"; buyPrice = res.spotQuotePerToken; }
      else throw e;
    }
  }
  state.positions.push({
    chainId: chain.chainId,
    symbol: sym,
    token: res.token,
    decimals: res.decimals,
    poolId: pool.poolId,
    poolKey: res.poolKey,
    quote: { symbol: res.quote.symbol, address: res.quote.address, decimals: res.quote.decimals },
    buyPriceQuotePerToken: buyPrice,
    buyPriceSource: priceSource,
    amountIn: buy.amountIn,
    buyTxHashes: exec.map((r) => r.hash),
    boughtAt: Date.now(),
    soldHalf: false,
    soldAll: false,
  });
  log(`[${chain.name}] BOUGHT ${sym} score ${res.score} size ${res.size} — $${cfg.buySizeUsd} ${res.quote.symbol} in. Buy price ${buyPrice} ${res.quote.symbol}/token (${priceSource}). Txs: ${exec.map((r) => r.hash).join(", ")}${tag}`);
  memUpdate(chain.chainId, res.token, "buy", { buyTx: exec[0] ? exec[0].hash : null, buyAmountIn: buy.amountIn });
  return "bought";
}

// processRechecks — the FIXED +10 min recheck (Part 52).
// For each due entry: re-run the FULL evaluation with fresh data
// (evaluatePool — all Part 51 gates apply exactly as at first sight:
// token-age <24h, min-500, memory ±25, GoPlus, holder-concentration,
// registries) and, if it now reaches the buy line, run the normal buy
// path (attemptBuy: cap, balance guard, live flags). Below the line: log
// the re-scored total and drop. Errors: log + drop (fail-open — today's
// behavior), never block the watcher.
// Legacy entries (queued before Part 52, no poolKey) keep the old
// behavior: social-only log + drop — they can never buy.
// Same-pool duplicate guard: a token already held (or held before) from
// this pool is never re-bought via recheck.
// deps (tests only): { evaluatePool, attemptBuy, scoreSocial, log }.
// Returns { stillPending, stats }.
async function processRechecks(cfg, state, live, deps = {}) {
  const evaluate = deps.evaluatePool || evaluatePool;
  const buy = deps.attemptBuy || attemptBuy;
  const scoreSocialFn = deps.scoreSocial || social.scoreSocial;
  const logFn = deps.log || log;
  const recheckAfterMs = (cfg.social?.recheckMinutes || 10) * 60 * 1000;
  const buyLine = cfg.scoreThresholds?.half ?? 45;
  const stillPending = [];
  const stats = { due: 0, reevaluated: 0, bought: 0, wouldBuy: 0, noBuy: 0, skipped: 0, legacy: 0, errors: 0 };
  for (const p of state.pendingRechecks || []) {
    if (Date.now() - p.detectedAt < recheckAfterMs) { stillPending.push(p); continue; }
    stats.due++;
    const chain = { chainId: p.chainId, ...cfg.chains[String(p.chainId)] };
    if (!chain || !chain.poolManager) {
      logFn(`[recheck] ${p.symbol} — unknown/disabled chain ${p.chainId}, dropped`);
      stats.errors++;
      continue;
    }
    const client = chains.makeClient(chain);
    if (!p.poolKey) {
      stats.legacy++;
      try {
        const s = await scoreSocialFn(chain.dexscreenerSlug, p.token, cfg);
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — social re-check at +10 min: ${s.points}/25 (${s.detail}) [legacy entry, no poolKey — full re-evaluation unavailable, dropped]`);
      } catch (e) {
        logFn(`[recheck ${chain.name}] ${p.symbol} — re-check errored: ${e.message.slice(0, 120)}`);
      }
      continue;
    }
    try {
      const pool = {
        poolId: p.poolId,
        currency0: p.poolKey.currency0, currency1: p.poolKey.currency1,
        fee: p.poolKey.fee, tickSpacing: p.poolKey.tickSpacing, hooks: p.poolKey.hooks,
        txHash: p.txHash, blockNumber: p.blockNumber,
        sqrtPriceX96: p.sqrtPriceX96 !== undefined && p.sqrtPriceX96 !== null ? BigInt(p.sqrtPriceX96) : undefined,
      };
      const res = await evaluate(cfg, chain, pool);
      stats.reevaluated++;
      const scoreLine = (res.scores || []).map((s) => `${s.component}:${s.points}`).join(" ");
      if (res.verdict === "SKIP") {
        stats.skipped++;
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 (${scoreLine}) but SKIP: ${res.reason} (was ${p.initialScore ?? "?"}/100 at detection) — dropped`);
        memUpdate(chain.chainId, res.token, "recheck-skip");
        continue;
      }
      if (res.size === "watch") {
        stats.noBuy++;
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 (${scoreLine}) below ${buyLine} (was ${p.initialScore ?? "?"}/100 at detection) — dropped`);
        memUpdate(chain.chainId, res.token, "recheck-watch");
        continue;
      }
      const alreadyHeld = (state.positions || []).some((pos) =>
        pos.poolId === p.poolId && pos.token.toLowerCase() === res.token.toLowerCase());
      if (alreadyHeld) {
        stats.noBuy++;
        logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 but already held from this pool — recheck buy skipped, dropped`);
        continue;
      }
      logFn(`[recheck ${chain.name}] ${p.symbol} ${p.token} — re-scored ${res.score}/100 (${scoreLine}) from ${p.initialScore ?? "?"}/100 at detection`);
      const outcome = await buy(cfg, chain, state, client, pool, res, live, "recheck");
      if (outcome === "bought") stats.bought++;
      else if (outcome === "would-buy") stats.wouldBuy++;
      // cap-skip / balance-skip: logged inside attemptBuy; entry still drops.
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
  const live = args.live && cfg.live === true;
  if (args.live && !live) {
    log("LIVE REQUESTED but config.live is false — running DRY-RUN instead. (Set config.live=true AND chain.live=true to go live; live also needs user funding + a Go per chain.)");
  }
  const allChains = chains.enabledChains(cfg);
  const runChains = args.chains ? allChains.filter((c) => args.chains.includes(c.chainId)) : allChains;
  if (runChains.length === 0) { log("No enabled chains selected — nothing to do."); return; }
  log(`=== v2 run start (live=${live}, chains: ${runChains.map((c) => c.name).join(", ")}) ===`);

  for (const chain of runChains) {
    const client = chains.makeClient(chain);
    let latest;
    try { latest = Number(await client.getBlockNumber()); }
    catch (e) { log(`[${chain.name}] ERROR reading latest block: ${e.message.slice(0, 150)}`); continue; }
    const fromBlock = args.windowBlocks
      ? Math.max(0, latest - args.windowBlocks)
      : (state.lastScannedBlock[String(chain.chainId)] ?? latest) + 1;
    if (fromBlock > latest) { log(`[${chain.name}] no new blocks (last ${state.lastScannedBlock[String(chain.chainId)]}, latest ${latest})`); continue; }
    let pools;
    try {
      pools = await chains.scanNewPools(chain, fromBlock, latest);
    } catch (e) {
      log(`[${chain.name}] ERROR scanning Initialize events: ${e.message.slice(0, 200)}`);
      continue;
    }
    log(`[${chain.name}] scanned blocks ${fromBlock}..${latest}: ${pools.length} new pool(s)`);
    state.lastScannedBlock[String(chain.chainId)] = latest;

    const toEval = pools.slice(0, MAX_EVALS_PER_CHAIN_PER_RUN);
    if (pools.length > toEval.length) log(`[${chain.name}] ${pools.length - toEval.length} pool(s) left unevaluated this run (cap ${MAX_EVALS_PER_CHAIN_PER_RUN})`);
    for (const pool of toEval) {
      let res;
      try {
        res = await evaluatePool(cfg, chain, pool);
      } catch (e) {
        log(`[${chain.name}] ${pool.poolId} EVALUATOR ERROR: ${e.message.slice(0, 200)}`);
        continue;
      }
      const sym = res.symbol || res.token?.slice(0, 10) || "?";
      const pair = res.poolKey ? `${res.poolKey.currency0.slice(0, 10)}..${res.poolKey.currency1.slice(0, 10)}` : `${pool.currency0.slice(0, 10)}..${pool.currency1.slice(0, 10)}`;
      if (res.verdict === "SKIP") {
        log(`[${chain.name}] SKIP ${sym} ${res.token || pool.poolId.slice(0, 18)} pair ${pair} — ${res.reason}`);
        continue;
      }
      const scoreLine = res.scores.map((s) => `${s.component}:${s.points}`).join(" ");
      let bought = false;
      if (res.size === "watch") {
        log(`[${chain.name}] WATCH ${sym} ${res.token} — score ${res.score}/100 (${scoreLine}) — below ${cfg.scoreThresholds?.half ?? 50}, no buy`);
      } else {
        try {
          const outcome = await attemptBuy(cfg, chain, state, client, pool, res, live);
          bought = outcome === "bought";
          // cap-skip / balance-skip never queued (as before — the recheck
          // exists for tokens that passed but did not buy for scoring
          // reasons, not for cap/balance).
          if (outcome === "cap-skip" || outcome === "balance-skip") continue;
        } catch (e) {
          log(`[${chain.name}] BUY FAILED ${sym}: ${e.message.slice(0, 200)}`);
        }
      }
      // Social re-check queue: info:null at detection gets a +10 min
      // re-score (Part 52: full re-evaluation + buy path, not social-only).
      // Tokens just bought are NOT queued — the recheck exists to catch
      // tokens that did NOT buy at detection; the recheck loop also guards
      // against re-buying an already-held pool. The initial score
      // breakdown + poolKey are stored so the recheck can rebuild the pool
      // and compare against the detection score.
      if (res.social && res.social.infoPresent === false && !bought) {
        state.pendingRechecks.push({
          chainId: chain.chainId, poolId: pool.poolId, token: res.token, symbol: sym,
          detectedAt: Date.now(), quote: res.quote,
          initialScore: res.score, initialScores: res.scores, poolKey: res.poolKey,
          txHash: pool.txHash, blockNumber: pool.blockNumber,
          sqrtPriceX96: pool.sqrtPriceX96 !== undefined && pool.sqrtPriceX96 !== null ? pool.sqrtPriceX96.toString() : undefined,
        });
      }
    }
  }

  // Social re-checks due (+10 min after detection) — Part 52: full
  // re-evaluation + normal buy path (processRechecks), not social-only.
  const { stillPending, stats: recheckStats } = await processRechecks(cfg, state, live);
  state.pendingRechecks = stillPending;
  log(`[recheck] due ${recheckStats.due}, re-evaluated ${recheckStats.reevaluated}, bought ${recheckStats.bought}, would-buy ${recheckStats.wouldBuy}, no-buy ${recheckStats.noBuy}, skipped ${recheckStats.skipped}, legacy ${recheckStats.legacy}, errors ${recheckStats.errors}`);

  // Position management (sell rules). Dry-run logs only.
  for (const pos of state.positions || []) {
    if (pos.soldAll) continue;
    const chain = { chainId: pos.chainId, ...cfg.chains[String(pos.chainId)] };
    if (!chain.enabled) continue;
    const client = chains.makeClient(chain);
    try {
      const st = await chains.readPoolState(client, chain.poolManager, pos.poolId);
      const cur = priceQuotePerToken(st, pos);
      const change = (cur - pos.buyPriceQuotePerToken) / pos.buyPriceQuotePerToken;
      log(`[position ${chain.name}] ${pos.symbol}: buy ${pos.buyPriceQuotePerToken} ${pos.quote.symbol}/token, current ${cur.toExponential(3)}, change ${(change * 100).toFixed(1)}%`);
      if (change >= (cfg.sellHalfAt ?? 1.0) && !pos.soldHalf) {
        if (live && chain.live === true) {
          const bal = await client.readContract({ address: pos.token, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
          const half = bal / 2n;
          if (half > 0n) {
            const sell = await trade.buildSell(cfg, chain, pos.poolKey, pos.token, pos.decimals, pos.quote, half);
            const exec = await trade.executeTxs(cfg, chain, sell.txs, { liveConfirm: true });
            pos.soldHalf = true;
            log(`[position ${chain.name}] SOLD 50% of ${pos.symbol}: ${half.toString()} tokens. Txs: ${exec.map((r) => r.hash).join(", ")}`);
          }
        } else {
          log(`[position ${chain.name}] would SELL 50% of ${pos.symbol} at +${(change * 100).toFixed(0)}% — DRY-RUN`);
        }
      } else if (change <= (cfg.sellAllAt ?? -0.5)) {
        if (live && chain.live === true) {
          const bal = await client.readContract({ address: pos.token, abi: chains.ERC20_ABI, functionName: "balanceOf", args: [cfg.agent] });
          if (bal > 0n) {
            const sell = await trade.buildSell(cfg, chain, pos.poolKey, pos.token, pos.decimals, pos.quote, bal);
            const exec = await trade.executeTxs(cfg, chain, sell.txs, { liveConfirm: true });
            pos.soldAll = true;
            log(`[position ${chain.name}] SOLD ALL of ${pos.symbol}: ${bal.toString()} tokens at ${(change * 100).toFixed(0)}%. Txs: ${exec.map((r) => r.hash).join(", ")}`);
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
  log("=== v2 run end ===");
}

if (require.main === module) {
  main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
}

module.exports = { attemptBuy, processRechecks };
