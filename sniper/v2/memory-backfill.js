// memory-backfill.js — Seed memory.sqlite from existing logs + STATE files.
// (Built 2026-11-08. Idempotent: safe to re-run.)
//
// Sources (in priority order):
//   A. v1 STATE.json positions (10): poolId + buyBlock known -> deployer
//      via the pool's Initialize log in [buyBlock-20000, buyBlock].
//   B. v3-STATE.json evaluated (5 scored): PoolCreated txHash known ->
//      receipt directly (from = deployer, to = creator contract).
//   C. v2 LOG.md WATCH lines (~790 unique tokens): score + decision +
//      first-seen timestamp. Deployer recovered ONLY for score >= 40
//      (13 tokens — the near-misses that matter) via a window scan of
//      Initialize events around first-seen (earliest pool containing the
//      token); the rest are recorded deployer-less (they still feed
//      buy-line calibration and outcome tracking; bulk deployer recovery
//      is a future option).
//   D. v2 STATE.json pendingRechecks (34): poolId + detectedAt -> deployer
//      via block-at-time + Initialize log.
//   E. DELTA control token: covered by (C) (score 45) — its deployer is
//      recovered the same way.
//
// Deployer = receipt.from of the pool-creation tx (the creator EOA, or
// the launchpad factory when the factory itself sends the tx). creator
// contract = receipt.to (e.g. Pons v1/v2 factory for launchpad tokens).
//
// Deployer recovery needs a block window: block-at-time is found by
// binary search per chain (cached), then the Initialize log is scanned
// in [block-30000, block+1000] with the poolId topic filter.
//
// Usage: node memory-backfill.js [--dry-run]
//   --dry-run prints what it would insert without writing.
// Writes only to memory.sqlite. Reads logs/STATE/RPC/Dexscreener only.
// Never touches STATE.json, LOG.md, or any live flag.

const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const social = require("./social.js");
const mem = require("./memory.js");

const DIR = "/home/hatch/workspace/tokens/sniper/v2";
const V1_STATE = "/home/hatch/workspace/tokens/sniper/archive/robinhood-v1-20261108/STATE.json";
const V2_STATE = path.join(DIR, "STATE.json");
const V3_STATE = path.join(DIR, "v3-STATE.json");
const V2_LOG = path.join(DIR, "LOG.md");

const DRY = process.argv.includes("--dry-run");
const CHAIN_IDS = { Robinhood: 4663, Base: 8453, Arc: 5042, Polygon: 137 };

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

// --- block-at-time (cached per chain) --------------------------------------
// Finds the first block with timestamp >= tsMs. Public RPCs are NOT archive
// nodes: eth_getBlockByNumber for OLD blocks fails (Base publicnode:
// "Archive requests require a personal token"). So instead of binary
// searching from block 0, estimate from the head using the chain's real
// seconds-per-block (measured from the last 1000 blocks), bracket
// ±5000 blocks around the estimate (expanding if needed), and binary
// search INSIDE the bracket — every probed block is recent.
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
  // Estimate from the head block's timestamp (not Date.now() — the head
  // can lag wall-clock by a few seconds on slow chains).
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

// --- deployer recovery ------------------------------------------------------
// Topic-filtered: exact poolId known. toBlock is clamped to the head
// (a window ending past the head makes some RPCs reject the whole call:
// Base publicnode "block range extends beyond current head").
async function deployerFromPoolId(chain, poolId, fromBlock, toBlock) {
  const client = chains.makeClient(chain);
  const latest = Number(await client.getBlockNumber());
  const logs = await chains.rawGetLogs(client, {
    address: chain.poolManager,
    topics: [chains.INITIALIZE_TOPIC0, poolId],
    fromBlock, toBlock: Math.min(toBlock, latest),
  });
  if (!logs || logs.length === 0) return null;
  const rc = await client.getTransactionReceipt({ hash: logs[0].transactionHash });
  return { deployer: (rc.from || "").toLowerCase(), creatorContract: (rc.to || "").toLowerCase() || null, txHash: logs[0].transactionHash };
}

// Window scan: only the token is known (no poolId). Scans all Initialize
// events in the window and takes the EARLIEST pool containing the token —
// that is the pool the watcher detected. More robust than trusting a
// Dexscreener pairAddress (which may point at a later, bigger pool).
async function deployerFromTokenInWindow(chain, token, fromBlock, toBlock) {
  const client = chains.makeClient(chain);
  const latest = Number(await client.getBlockNumber());
  const pools = await chains.scanNewPools(chain, fromBlock, Math.min(toBlock, latest));
  const hits = pools.filter((p) => p.currency0 === token || p.currency1 === token)
    .sort((a, b) => a.blockNumber - b.blockNumber);
  if (!hits.length) return null;
  const rc = await client.getTransactionReceipt({ hash: hits[0].txHash });
  return { deployer: (rc.from || "").toLowerCase(), creatorContract: (rc.to || "").toLowerCase() || null, txHash: hits[0].txHash, poolId: hits[0].poolId };
}

async function deployerFromTxHash(chain, txHash) {
  const client = chains.makeClient(chain);
  const rc = await client.getTransactionReceipt({ hash: txHash });
  return { deployer: (rc.from || "").toLowerCase(), creatorContract: (rc.to || "").toLowerCase() || null, txHash };
}

function chainObj(chainId) {
  const cfg = chains.loadConfig();
  return { chainId, ...cfg.chains[String(chainId)] };
}

async function main() {
  log(`=== memory-backfill start (dry-run=${DRY}) ===`);
  const summary = { v1: 0, v1Deployer: 0, v3: 0, v3Deployer: 0, v2watch: 0, v2watchDeployer: 0, rechecks: 0, recheckDeployer: 0, failed: [] };

  // ---- A. v1 positions ----
  const v1 = JSON.parse(fs.readFileSync(V1_STATE, "utf8"));
  const rh = chainObj(4663);
  for (const p of v1.positions || []) {
    let dep = null;
    try {
      dep = await deployerFromPoolId(rh, p.poolId, Math.max(0, p.buyBlock - 20000), p.buyBlock);
    } catch (e) { summary.failed.push(`v1 ${p.symbol}: deployer lookup failed: ${e.message.slice(0, 80)}`); }
    const row = {
      chainId: 4663, token: p.token, poolId: p.poolId, poolType: "v4",
      deployer: dep ? dep.deployer : null, creatorContract: dep ? dep.creatorContract : null,
      symbol: p.symbol, quoteSymbol: "WETH", quoteAddress: rh.quotes[0].address,
      source: "v1", firstSeenAt: p.boughtAt,
      firstPrice: p.buyPriceWethPerToken != null ? Number(p.buyPriceWethPerToken) : null,
      firstPriceQuote: "WETH", decision: "buy",
      buyTx: p.buyTx || null, buyAmountIn: p.buyAmountToken || null,
    };
    if (!DRY) mem.upsertToken(row);
    summary.v1++;
    if (dep) summary.v1Deployer++;
    log(`[v1] ${p.symbol} ${p.token.slice(0, 12)}… deployer=${dep ? dep.deployer.slice(0, 12) + "…" : "UNKNOWN"} bought ${p.boughtAt} soldAll=${p.soldAll}`);
  }

  // ---- B. v3 evaluated ----
  const v3s = JSON.parse(fs.readFileSync(V3_STATE, "utf8"));
  const rhClient = chains.makeClient(rh);
  for (const e of v3s.evaluated || []) {
    if (!e.token) { log(`[v3] SKIP entry (no token) — nothing to record`); continue; }
    let dep = null, firstSeen = null;
    try {
      dep = await deployerFromTxHash(rh, e.txHash);
      const b = await rhClient.getBlock({ blockNumber: BigInt(e.blockNumber) });
      firstSeen = new Date(Number(b.timestamp) * 1000).toISOString();
    } catch (err) { summary.failed.push(`v3 ${e.symbol}: ${err.message.slice(0, 80)}`); }
    const row = {
      chainId: 4663, token: e.token, poolAddress: e.pool, poolType: "V3",
      deployer: dep ? dep.deployer : null, creatorContract: dep ? dep.creatorContract : null,
      symbol: e.symbol, quoteSymbol: "WETH",
      source: "v3", firstSeenAt: firstSeen,
      score: e.score ?? null, decision: e.verdict === "SKIP" ? "skip" : (e.size === "watch" ? "watch" : "would-buy"),
    };
    if (!DRY) mem.upsertToken(row);
    summary.v3++;
    if (dep) summary.v3Deployer++;
    log(`[v3] ${e.symbol} ${e.token.slice(0, 12)}… score=${e.score} deployer=${dep ? dep.deployer.slice(0, 12) + "…" : "UNKNOWN"}`);
  }

  // ---- C. v2 LOG.md WATCH lines ----
  const logText = fs.readFileSync(V2_LOG, "utf8");
  const watchRe = /^\[([0-9T:.Z-]+)\] \[(\w+)\] WATCH (\S+) (0x[0-9a-fA-F]{40}) — score (\d+)\/100 \(([^)]*)\)/gm;
  const seen = new Map(); // key chainId:token -> earliest record
  let m;
  while ((m = watchRe.exec(logText)) !== null) {
    const [, ts, chainName, symbol, token, score, comps] = m;
    const chainId = CHAIN_IDS[chainName];
    if (!chainId) continue;
    const key = chainId + ":" + token.toLowerCase();
    const prev = seen.get(key);
    if (!prev || ts < prev.firstSeenAt) {
      const breakdown = comps.split(" ").filter(Boolean).map((c) => {
        const [component, pts] = c.split(":");
        return { component, points: Number(pts) };
      });
      seen.set(key, { chainId, token: token.toLowerCase(), symbol, firstSeenAt: ts, score: Number(score), scoreBreakdown: breakdown, decision: "watch" });
    }
  }
  log(`[v2] ${seen.size} unique WATCH tokens parsed from LOG.md`);
  // Recover deployers for score >= 40 only (the near-misses), via a
  // window scan around first-seen (no Dexscreener dependency). Widen the
  // window once if the first pass finds nothing (dry-run-era evaluations
  // can lag creation by hours).
  const hot = [...seen.values()].filter((t) => t.score >= 40);
  log(`[v2] ${hot.length} token(s) scored >= 40 — recovering deployers`);
  for (const t of hot) {
    try {
      const chain = chainObj(t.chainId);
      const blk = await blockAtTime(chain, Date.parse(t.firstSeenAt));
      let dep = await deployerFromTokenInWindow(chain, t.token, Math.max(0, blk - 30000), blk + 1000);
      if (!dep) dep = await deployerFromTokenInWindow(chain, t.token, Math.max(0, blk - 150000), blk + 1000);
      if (dep) { t.deployer = dep.deployer; t.creatorContract = dep.creatorContract; t.poolId = dep.poolId; summary.v2watchDeployer++; }
      else summary.failed.push(`v2 ${t.symbol} ${t.token.slice(0, 12)}: no pool with this token in window around first-seen`);
    } catch (e) { summary.failed.push(`v2 ${t.symbol}: ${e.message.slice(0, 80)}`); }
  }
  // DELTA's decision: it BALANCE-SKIPped (score 45) — upgrade from watch.
  for (const t of seen.values()) {
    if (t.token === "0xe8ffd7e24187f72afb08d75b1bb13088a989a791" && t.chainId === 4663) t.decision = "balance-skip";
  }
  for (const t of seen.values()) {
    if (!DRY) mem.upsertToken({ ...t, source: "v2", poolType: "v4" });
    summary.v2watch++;
  }
  log(`[v2] recorded ${summary.v2watch} WATCH tokens (${summary.v2watchDeployer} with deployer recovered)`);

  // ---- D. v2 pendingRechecks ----
  const v2s = JSON.parse(fs.readFileSync(V2_STATE, "utf8"));
  for (const p of v2s.pendingRechecks || []) {
    let dep = null;
    try {
      const chain = chainObj(p.chainId);
      const blk = await blockAtTime(chain, p.detectedAt);
      dep = await deployerFromPoolId(chain, p.poolId, Math.max(0, blk - 30000), blk + 1000);
    } catch (e) { summary.failed.push(`recheck ${p.symbol}: ${e.message.slice(0, 80)}`); }
    const row = {
      chainId: p.chainId, token: p.token, poolId: p.poolId, poolType: "v4",
      deployer: dep ? dep.deployer : null, creatorContract: dep ? dep.creatorContract : null,
      symbol: p.symbol, quoteSymbol: p.quote ? p.quote.symbol : null,
      quoteAddress: p.quote ? p.quote.address : null,
      source: "v2", firstSeenAt: new Date(p.detectedAt).toISOString(), decision: "watch",
    };
    if (!DRY) mem.upsertToken(row);
    summary.rechecks++;
    if (dep) summary.recheckDeployer++;
  }
  log(`[v2] recorded ${summary.rechecks} pendingRecheck tokens (${summary.recheckDeployer} with deployer)`);

  log("=== memory-backfill end ===");
  log("summary: " + JSON.stringify(summary, null, 2));
  if (summary.failed.length) {
    log(`unrecovered (${summary.failed.length}):`);
    for (const f of summary.failed.slice(0, 40)) log("  - " + f);
    if (summary.failed.length > 40) log(`  … and ${summary.failed.length - 40} more`);
  }
  if (!DRY) log("memory stats: " + JSON.stringify(mem.stats()));
}

main().catch((e) => { console.error("BACKFILL ERROR:", e); process.exit(1); });
