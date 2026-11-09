// memory-followup.js — Outcome re-check job for the deployer memory
// (built 2026-11-08; aegis-style 24h / 72h / 7d feedback loop).
//
// What it does:
//   1. Finds tokens in memory.sqlite due for a 24h / 72h / 7d check
//      (first_seen_at + checkpoint, outcome column still NULL).
//   2. Pulls in positions from the three STATE.json files (v1, v2, v3)
//      that are not in memory yet, so bought tokens get outcome-tracked
//      even when their evaluator was never wired to memory (v1).
//   3. For each due token, fetches the current price + 24h trade activity
//      (Dexscreener first — priceNative in the pool's quote token,
//      liquidity.usd, txns.h24; onchain spot as a price-only fallback)
//      and classifies the outcome:
//        rugged    = price <= 10% of peak AND (liquidity < $100 OR 0 trades/24h)
//        abandoned = not rugged AND 0 trades in the last 24h
//        alive     = trades in the last 24h and not rugged
//        unknown   = no trade data at all (not resolved — retried next run)
//      At 7d the final_outcome is set; deployer reputation reads the
//      latest resolved checkpoint, so a 24h rug counts immediately.
//   4. Writes outcomes + peak price into memory.sqlite.
//
// SAFETY: this script NEVER sends a transaction. It only reads public
// APIs/RPCs and writes to our own local SQLite file. Safe to run on a
// schedule.
//
// Usage:
//   node memory-followup.js            # run (writes outcomes)
//   node memory-followup.js --dry-run  # log what it WOULD do, write nothing
//   node memory-followup.js --force    # re-check tokens even if the
//                                      # checkpoint column is already set
//
// Recommended cron (NOT created by this build — parent sets it up):
//   every hour: cd ~/workspace/tokens/sniper/v2 && node memory-followup.js
//   (hourly is plenty: checkpoints are 24h/72h/7d apart; each run only
//   touches due tokens and is idempotent.)

const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const social = require("./social.js");
const mem = require("./memory.js");

const DIR = "/home/hatch/workspace/tokens/sniper/v2";
const V1_STATE = "/home/hatch/workspace/tokens/sniper/archive/robinhood-v1-20261108/STATE.json";
const V2_STATE = path.join(DIR, "STATE.json");
const V3_STATE = path.join(DIR, "v3-STATE.json");

const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// Dexscreener chain slugs per chain id (same mapping as config).
const SLUGS = { 4663: "robinhood", 8453: "base", 5042: "arc", 137: "polygon", 1: "ethereum", 56: "bsc", 42161: "arbitrum" };

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

// --- Price + activity from Dexscreener -------------------------------------
// Returns { price, liquidityUsd, trades24h, pairAddress, source } or null.
// price = priceNative (quote token per base token) of the pair whose quote
// matches our pool quote, else the highest-liquidity pair.
// (NOTE: the raw tokens/v1 endpoint returns an ARRAY of pairs;
// social.fetchDexscreenerInfo returns a single-pair summary object —
// do not use it here.)
async function dexscreenerOutcome(chainId, token, quoteAddress) {
  const slug = SLUGS[chainId];
  if (!slug) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let json;
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${token}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      json = await res.json();
    } finally { clearTimeout(t); }
    if (!Array.isArray(json) || json.length === 0) return null;
    let pick = null;
    if (quoteAddress) {
      pick = json.find((p) => p.quoteToken && p.quoteToken.address && p.quoteToken.address.toLowerCase() === quoteAddress.toLowerCase());
    }
    if (!pick) pick = json.slice().sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const price = pick.priceNative != null ? Number(pick.priceNative) : null;
    return {
      price,
      liquidityUsd: pick.liquidity ? pick.liquidity.usd : null,
      trades24h: pick.txns && pick.txns.h24 ? (pick.txns.h24.buys || 0) + (pick.txns.h24.sells || 0) : null,
      pairAddress: pick.pairAddress || null,
      source: "dexscreener",
    };
  } catch (e) {
    return null;
  }
}

// --- block-at-time (cached per chain) --------------------------------------
// Finds the first block with timestamp >= tsMs. Public RPCs are NOT archive
// nodes: eth_getBlockByNumber for OLD blocks fails (Base publicnode:
// "Archive requests require a personal token"). So instead of binary
// searching from block 0, estimate from the head using the chain's real
// seconds-per-block (measured from the last 1000 blocks), bracket
// ±5000 blocks around the estimate (expanding if needed), and binary
// search INSIDE the bracket — every probed block is recent.
// (Same helper as memory-backfill.js — duplicated deliberately so each
// script stays standalone and chains.js, the live shared code, is untouched.)
const blockCache = new Map();
async function blockAtTime(chain, tsMs) {
  const key = chain.chainId;
  if (!blockCache.has(key)) blockCache.set(key, { cache: new Map(), spb: null });
  const c = blockCache.get(key);
  const client = chains.makeClient(chain);
  const latest = Number(await client.getBlockNumber());
  const target = Math.floor(tsMs / 1000);
  if (c.spb == null) {
    const b1 = await client.getBlock({ blockNumber: BigInt(latest) });
    const b0 = await client.getBlock({ blockNumber: BigInt(Math.max(0, latest - 1000)) });
    c.spb = Math.max(0.05, (Number(b1.timestamp) - Number(b0.timestamp)) / Math.min(1000, latest));
  }
  const getTs = async (n) => {
    if (c.cache.has(n)) return c.cache.get(n);
    const b = await client.getBlock({ blockNumber: BigInt(n) });
    const ts = Number(b.timestamp);
    c.cache.set(n, ts);
    return ts;
  };
  const headTs = await getTs(latest);
  let est = latest - Math.floor((headTs - target) / c.spb);
  est = Math.max(0, Math.min(latest, est));
  let lo = Math.max(0, est - 5000), hi = Math.min(latest, est + 5000);
  for (let expand = 0; expand < 6; expand++) {
    const tsLo = await getTs(lo);
    const tsHi = await getTs(hi);
    if (tsLo <= target && target <= tsHi) break;
    if (tsHi < target) { lo = hi; hi = Math.min(latest, hi + 10000 * (expand + 1)); }
    else if (tsLo > target) { hi = lo; lo = Math.max(0, lo - 10000 * (expand + 1)); }
    else break;
    if (lo === 0 && hi === latest) break;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await getTs(mid);
    if (ts < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// --- Onchain spot fallback (price only — no trade data) --------------------
// V4: fetch the pool's Initialize log to learn currency0/currency1, then
// read both decimals onchain. V3: read slot0 + token0/token1 + decimals.
// Returns { price, source } or null.
async function onchainSpot(chainId, tok) {
  try {
    const cfg = chains.loadConfig();
    const chain = { chainId, ...cfg.chains[String(chainId)] };
    if (!chain.poolManager) return null;
    const client = chains.makeClient(chain);
    const { parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
    const decAbi = parseAbi(["function decimals() view returns (uint8)"]);
    const readDec = (addr) => client.readContract({ address: addr, abi: decAbi, functionName: "decimals" }).catch(() => null);
    if (tok.pool_type === "V3" && tok.pool_address) {
      const v3 = require("./v3.js");
      const st = await v3.readV3PoolState(client, tok.pool_address);
      const [d0, d1] = await Promise.all([readDec(st.token0), readDec(st.token1)]);
      if (d0 == null || d1 == null) return null;
      const spot = v3.v3PriceFromSqrt(st.sqrtPriceX96, d0, d1); // token1 per token0
      const quoteIs0 = tok.quote_address && st.token0 === tok.quote_address.toLowerCase();
      return { price: quoteIs0 ? 1 / spot : spot, source: "onchain-v3" };
    }
    if (tok.pool_id && tok.first_seen_at) {
      const blk = await blockAtTime(chain, Date.parse(tok.first_seen_at));
      const logs = await chains.rawGetLogs(client, {
        address: chain.poolManager,
        topics: [chains.INITIALIZE_TOPIC0, tok.pool_id],
        fromBlock: Math.max(0, blk - 30000), toBlock: blk + 1000,
      });
      if (!logs || logs.length === 0) return null;
      const pool = chains.decodeInitialize(logs[0]);
      const [d0, d1] = await Promise.all([readDec(pool.currency0), readDec(pool.currency1)]);
      if (d0 == null || d1 == null) return null;
      const st = await chains.readPoolState(client, chain.poolManager, tok.pool_id);
      const spot = chains.priceFromSqrt(st.sqrtPriceX96, d0, d1); // token1 per token0
      const quoteIs0 = pool.currency0.toLowerCase() === (tok.quote_address || "").toLowerCase();
      return { price: quoteIs0 ? 1 / spot : spot, source: "onchain-v4" };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function classify(out, baseline) {
  // out: { price, peak, liquidityUsd, trades24h }
  if (out.trades24h == null && out.liquidityUsd == null) return "unknown";
  const peak = out.peak;
  const crashed = peak && out.price != null && out.price <= 0.10 * peak;
  const illiquid = out.liquidityUsd != null && out.liquidityUsd < 100;
  const noTrades = out.trades24h === 0;
  if (crashed && (illiquid || noTrades)) return "rugged";
  if (noTrades) return "abandoned";
  return "alive";
}

// --- Discover bought positions missing from memory -------------------------
function discoverPositions() {
  const found = [];
  const push = (chainId, pos, poolType, source) => {
    if (!pos || !pos.token) return;
    found.push({
      chainId,
      token: String(pos.token).toLowerCase(),
      poolId: pos.poolId || null,
      poolAddress: pos.poolAddress || null,
      poolType,
      symbol: pos.symbol || null,
      quoteSymbol: pos.quote ? pos.quote.symbol : null,
      quoteAddress: pos.quote ? pos.quote.address : null,
      source,
      firstSeenAt: pos.boughtAt ? new Date(pos.boughtAt).toISOString() : null,
      firstPrice: pos.buyPriceQuotePerToken ?? pos.buyPriceWethPerToken ?? null,
      firstPriceQuote: pos.quote ? pos.quote.symbol : "WETH",
      decision: "buy",
      buyTx: (pos.buyTxHashes && pos.buyTxHashes[0]) || pos.buyTx || null,
      buyAmountIn: pos.amountIn || null,
      tokenDecimals: pos.decimals ?? null,
      quoteDecimals: pos.quote ? pos.quote.decimals : null,
    });
  };
  try {
    const s1 = JSON.parse(fs.readFileSync(V1_STATE, "utf8"));
    for (const p of s1.positions || []) push(4663, p, "v4", "v1");
  } catch { /* v1 state unreadable — skip */ }
  try {
    const s2 = JSON.parse(fs.readFileSync(V2_STATE, "utf8"));
    for (const p of s2.positions || []) push(p.chainId, p, "v4", "v2");
  } catch { /* v2 state unreadable — skip */ }
  try {
    const s3 = JSON.parse(fs.readFileSync(V3_STATE, "utf8"));
    for (const p of s3.positions || []) push(4663, p, "V3", "v3");
  } catch { /* v3 state unreadable — skip */ }
  return found;
}

async function main() {
  log(`=== memory-followup start (dry-run=${DRY}, force=${FORCE}) ===`);

  // 1. Discover positions not yet in memory.
  let discovered = 0;
  for (const p of discoverPositions()) {
    if (DRY) { log(`[discover] would upsert ${p.symbol || "?"} ${p.token} (chain ${p.chainId}, ${p.source})`); discovered++; continue; }
    if (mem.upsertToken(p)) discovered++;
  }
  log(`[discover] ${discovered} position(s) from STATE.json files`);

  // 2. Due tokens.
  const due = mem.tokensDueForCheck(Date.now(), { force: FORCE });
  log(`[due] ${due.length} token(s) due for a checkpoint`);
  let checked = 0, resolved = 0, unknown = 0, skipped = 0;
  for (const tok of due) {
    for (const cp of tok.checkpoints) {
      if (!FORCE && tok["outcome_" + cp]) { skipped++; continue; }
      const dx = await dexscreenerOutcome(tok.chain_id, tok.token, tok.quote_address);
      let price = dx ? dx.price : null;
      let liquidityUsd = dx ? dx.liquidityUsd : null;
      let trades24h = dx ? dx.trades24h : null;
      let source = dx ? dx.source : null;
      if (price == null) {
        const oc = await onchainSpot(tok.chain_id, tok);
        if (oc) { price = oc.price; source = oc.source; }
      }
      const peak = Math.max(tok.peak_price ?? tok.first_price ?? price ?? 0, price ?? 0);
      const status = classify({ price, peak, liquidityUsd, trades24h }, tok.first_price);
      const outcome = { price, peak, liquidityUsd, trades24h, status, source };
      if (DRY) {
        log(`[dry-run] ${tok.symbol || "?"} ${tok.token.slice(0, 12)}… chain ${tok.chain_id} ${cp}: price=${price} peak=${peak} liq=$${liquidityUsd} trades24h=${trades24h} -> ${status} (source: ${source || "none"})`);
      } else {
        if (mem.recordOutcome(tok.chain_id, tok.token, cp, outcome)) checked++;
        log(`[${cp}] ${tok.symbol || "?"} ${tok.token.slice(0, 12)}… chain ${tok.chain_id}: price=${price} peak=${peak} liq=$${liquidityUsd} trades24h=${trades24h} -> ${status}`);
      }
      if (status === "unknown") unknown++;
      else resolved++;
    }
  }
  log(`=== memory-followup end: checked=${checked} resolved=${resolved} unknown=${unknown} skipped=${skipped} ===`);
  const s = mem.stats();
  log("memory stats: " + JSON.stringify(s));
}

main().catch((e) => { console.error("FOLLOWUP ERROR:", e); process.exit(1); });
