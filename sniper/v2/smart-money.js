// smart-money.js — smart-wallet buy signal for the snipers (Part 55).
//
// Built 2026-11-09 (user tapped "Build the signal" ~06:44 GMT+7 — Option A
// from the Part 54 copy-trade research). A watchlisted wallet's buy of the
// token is a SCORING SIGNAL inside the existing evaluators, never a buy
// trigger: the token must still pass EVERY gate (token-age, min-500,
// honeypot sim, score >= 45) exactly as today. No gate is bypassed, no
// new buy path, no cap change.
//
// Score component "smart-money", clamped to [0, +15]:
//   +10 when >=1 watchlisted wallet bought the token and still holds it
//   +15 when >=2 watchlisted wallets bought it and still hold it
//   (formula: 10 * nFresh + 5 * nHalf, capped at 15 — see scoreFromBuys)
//   Staleness decay: a buy <24h old counts full, 24-48h counts half,
//   >48h counts 0.
//
// Detection — read the pool's onchain Swap history at evaluation time
// (the buy is permanently onchain, so no live stream is needed; the
// 2-min watcher cycle is enough). The HARD part, solved here:
//   - V4: the Swap event's `sender` is the ROUTER, not the buyer. The
//     buyer's identity is ONLY in the swap transaction's `from` field.
//     So for each Swap event we fetch the tx (eth_getTransaction) and
//     check `from` against the watchlist. Never trust GMGN attribution
//     (the ACTUARY case: GMGN attributed a trade to a wallet that did
//     not send the tx).
//   - V3: same — the V3 Swap `sender` is the router for router-routed
//     swaps; tx `from` is the reliable identity.
//   - A wallet trading via a smart wallet / multisig shows the smart
//     wallet as `from`, not the EOA — such trades do NOT match the
//     watchlist. That is correct behavior (only verifiable buys count).
//
// V4 Swap topic0 — the ROBINHOOD FORK signature (verified 2026-11-09):
//   Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
//   The last param is uint24 (fee), NOT int24 as in canonical v4-core.
//   Proof: the agent's own USDG funding swap receipt (0x6fcc9e79...,
//   Robinhood) carries topic0 0x40e9cecb... on the PoolManager, and
//   Base/Arc/Polygon PoolManagers all emit it too (353 logs / 500
//   blocks on Base). Canonical v4-core Swap (int24 fee, 0x105ac8df...)
//   appears NOWHERE on our four chains — it is scanned as a fallback
//   only, in case a chain ever deploys canonical V4.
// V3 Swap topic0: Swap(address,address,int256,int256,uint160,uint128,int24)
//   = 0xc42079f9... (verified in the PUSSYCOIN buy receipt, which went
//   through V3 pool 0x62ab521f...).
//
// Guards (all required by the design):
//   (a) hold guard — a buy counts ONLY while the wallet still holds the
//       token (balanceOf > 0 at evaluation time). Exit-liquidity trap
//       guard: a wallet that bought and dumped scores 0.
//   (b) staleness decay — full <24h, half 24-48h, zero after (above).
//   (c) deployer exclusion — a watchlisted wallet that IS the token's
//       deployer (Initialize-tx `from`) or its creator (GoPlus
//       creator_address) never counts. This is what lets #1 (created 11
//       tokens) stay on the watchlist: self-buys are neutralized
//       per-token instead of dropping the strongest signal.
//   (d) fail-open — any RPC/API error means 0 points, never blocks the
//       evaluation. scoreSmartMoney NEVER throws.
//   (e) bounded RPC — the Swap scan covers at most maxScanBlocks back
//       from latest (default 200,000); at most maxSwapLogs logs are
//       processed (most recent first, plus the oldest when over cap —
//       the birth buys are the highest-signal ones, so a busy pool is
//       sampled from BOTH ends, not just the newest); tx `from` lookups
//       are JSON-RPC BATCHED (50 hashes per HTTP call — verified working
//       on the Robinhood RPC 2026-11-09; per-chunk fallback to sequential
//       client.getTransaction if a batch fails). On fast chains
//       (Robinhood ~10 blocks/s) 200k blocks is ~5.5h — that covers the
//       T+0 and +10 min recheck evaluations that matter; a pool first
//       seen hours after creation may miss older buys. Fail-open:
//       missing data = fewer points, never a wrong buy.
//
// Config (config.json smartMoney; env escape SMART_MONEY_ENABLED=0):
//   enabled, pointsOne (10), pointsTwo (15), fullHours (24),
//   halfHours (48), maxScanBlocks (200000), maxSwapLogs (1000),
//   maxTxFetches (1000), txBatchSize (50).
//
// Watchlist: smart-money-watchlist.json (8 wallets, Part 54). Re-ranked
// monthly by re-running the Part 54 method and replacing the file — no
// code change. A wallet can be dropped without editing code
// (included: false).

const { parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");

const V4_SWAP_TOPIC0_FORK = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const V4_SWAP_TOPIC0_CANON = "0x105ac8df5dee7ee117cb26c7cb806df4ec7a962af1fd9892355fea7dff3fa051";
const V3_SWAP_TOPIC0 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const DEFAULTS = {
  enabled: true,
  pointsOne: 10,
  pointsTwo: 15,
  fullHours: 24,
  halfHours: 48,
  maxScanBlocks: 200000,
  maxSwapLogs: 1000,
  maxTxFetches: 1000,
  txBatchSize: 50,
};

function resolveConfig(cfg) {
  const sm = (cfg && cfg.smartMoney) || {};
  return {
    enabled:
      process.env.SMART_MONEY_ENABLED === "0"
        ? false
        : sm.enabled !== false,
    pointsOne: sm.pointsOne ?? DEFAULTS.pointsOne,
    pointsTwo: sm.pointsTwo ?? DEFAULTS.pointsTwo,
    fullHours: sm.fullHours ?? DEFAULTS.fullHours,
    halfHours: sm.halfHours ?? DEFAULTS.halfHours,
    maxScanBlocks: sm.maxScanBlocks ?? DEFAULTS.maxScanBlocks,
    maxSwapLogs: sm.maxSwapLogs ?? DEFAULTS.maxSwapLogs,
    maxTxFetches: sm.maxTxFetches ?? DEFAULTS.maxTxFetches,
    txBatchSize: sm.txBatchSize ?? DEFAULTS.txBatchSize,
  };
}

// Fetch the `from` (sender) of many tx hashes, JSON-RPC batched
// (txBatchSize hashes per HTTP call) with a per-chunk sequential
// fallback if a batch fails (some RPCs reject batches). Returns a
// Map txHash(lowercase) -> from(lowercase). A tx that cannot be fetched
// is simply absent — the caller treats it as "not a watchlisted buy".
async function fetchTxSenders(client, txHashes, batchSize) {
  const fromByHash = new Map();
  const rpcUrl = client.transport && client.transport.url;
  const sequential = async (hashes) => {
    const settled = await Promise.allSettled(
      hashes.map((h) => client.getTransaction({ hash: h })),
    );
    settled.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value && r.value.from) {
        fromByHash.set(hashes[i].toLowerCase(), r.value.from.toLowerCase());
      }
    });
  };
  for (let i = 0; i < txHashes.length; i += batchSize) {
    const chunk = txHashes.slice(i, i + batchSize);
    let batched = false;
    if (rpcUrl) {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
          body: JSON.stringify(
            chunk.map((h, j) => ({
              jsonrpc: "2.0",
              id: j + 1,
              method: "eth_getTransactionByHash",
              params: [h],
            })),
          ),
        });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json)) {
            batched = true;
            for (const r of json) {
              if (r && r.result && r.result.from) {
                fromByHash.set(r.result.hash.toLowerCase(), r.result.from.toLowerCase());
              }
            }
          }
        }
      } catch {
        batched = false; // fall through to sequential for this chunk
      }
    }
    if (!batched) await sequential(chunk);
  }
  return fromByHash;
}

// Watchlist — cached after first load; reloadWatchlist() clears the cache
// (a monthly re-rank replaces the file; the watcher process restarts every
// cycle anyway, but the cache lets tests pin a fresh list).
let cachedWatchlist = null;
function loadWatchlist() {
  if (cachedWatchlist) return cachedWatchlist;
  const data = require("./smart-money-watchlist.json");
  const wallets = (data.wallets || [])
    .filter((w) => w.included !== false && w.address)
    .map((w) => ({
      address: w.address.toLowerCase(),
      rank: w.rank ?? null,
      pnl30dUsd: w.pnl30dUsd ?? null,
      winRate: w.winRate ?? null,
      chains: w.chains || [],
      flags: w.flags || [],
    }));
  cachedWatchlist = {
    version: data.version ?? null,
    rankedAt: data.rankedAt ?? null,
    wallets,
    byAddress: new Map(wallets.map((w) => [w.address, w])),
  };
  return cachedWatchlist;
}
function reloadWatchlist() {
  cachedWatchlist = null;
  return loadWatchlist();
}

// Pure scoring of a set of verified buys. Exported so the mapping can be
// tested without the network.
//   buys: [{ wallet, boughtAtMs, stillHolds, isDeployer }]
//   nowMs: evaluation time (ms epoch).
//   opts: { pointsOne, pointsTwo, fullHours, halfHours }.
// Per-wallet, the FRESHEST qualifying buy sets the weight (1 full,
// 0.5 half); a wallet that sold out (stillHolds false) or is the
// deployer never counts. points = 10*nFull + 5*nHalf, capped at 15:
//   1 fresh -> 10; 2 fresh -> 15 (capped); 1 fresh + 1 half -> 15;
//   1 half -> 5; 2 half -> 10; anything >48h old -> 0.
function scoreFromBuys(buys, nowMs, opts = {}) {
  const pointsOne = opts.pointsOne ?? DEFAULTS.pointsOne;
  const pointsTwo = opts.pointsTwo ?? DEFAULTS.pointsTwo;
  const fullMs = (opts.fullHours ?? DEFAULTS.fullHours) * 3600000;
  const halfMs = (opts.halfHours ?? DEFAULTS.halfHours) * 3600000;
  const best = new Map(); // wallet -> weight (1 full, 0.5 half)
  for (const b of buys || []) {
    if (!b || !b.wallet) continue;
    if (!b.stillHolds || b.isDeployer) continue;
    const boughtAt = Number(b.boughtAtMs);
    if (!Number.isFinite(boughtAt)) continue;
    const age = nowMs - boughtAt;
    if (age < 0 || age >= halfMs) continue; // future (clock skew) or stale
    const w = age < fullMs ? 1 : 0.5;
    const prev = best.get(b.wallet.toLowerCase()) || 0;
    if (w > prev) best.set(b.wallet.toLowerCase(), w);
  }
  let nFull = 0;
  let nHalf = 0;
  for (const w of best.values()) {
    if (w >= 1) nFull++;
    else nHalf++;
  }
  const rawPoints = pointsOne * nFull + (pointsOne / 2) * nHalf;
  const points = Math.max(0, Math.min(pointsTwo, Math.round(rawPoints)));
  const buyers = [...best.entries()].map(([wallet, w]) => ({
    wallet,
    weight: w,
    ageBucket: w >= 1 ? "<24h" : "24-48h",
  }));
  const detail =
    buyers.length === 0
      ? "no watchlisted wallet holds this token (no qualifying buy)"
      : `${buyers.length} watchlisted wallet(s) bought and still hold: ` +
        buyers.map((b) => `${b.wallet.slice(0, 10)}.. (${b.ageBucket})`).join(", ") +
        ` -> ${points} pts`;
  return { points, buyers, detail, nFull, nHalf };
}

// Main entry: score one token on one chain.
// opts: {
//   client (viem public client; default makeClient(chain)),
//   poolId (V4) OR poolAddress (V3) — exactly one is required,
//   token, poolBlock (creation block; required — without it the Swap
//     scan has no start),
//   deployer (Initialize-tx `from`, lowercase), creator (GoPlus
//     creator_address, lowercase) — both optional; a watchlisted wallet
//     matching either never counts,
//   cfg (config.json — smartMoney section; default {}),
// }
// Returns { points, detail, buyers, buys } — NEVER throws (fail-open).
async function scoreSmartMoney(chain, opts = {}) {
  const failOpen = (detail) => ({ points: 0, detail, buyers: [], buys: [] });
  const cfg = resolveConfig(opts.cfg);
  if (!cfg.enabled) return failOpen("smart-money: disabled (SMART_MONEY_ENABLED=0 or config)");
  const token = (opts.token || "").toLowerCase();
  if (!token) return failOpen("smart-money: no token given");
  const poolBlock = Number(opts.poolBlock || 0);
  if (!poolBlock || poolBlock <= 0) {
    return failOpen("smart-money: no pool creation block — cannot scan Swap history");
  }
  const watchlist = loadWatchlist();
  if (watchlist.wallets.length === 0) return failOpen("smart-money: watchlist empty");
  const client = opts.client || chains.makeClient(chain);

  try {
    const latest = await client.getBlockNumber();
    const fromBlock = BigInt(
      Math.max(poolBlock, Number(latest) - cfg.maxScanBlocks),
    );
    let logs;
    if (opts.poolId) {
      // V4: Swap events on the PoolManager, topic1 = poolId. Both topic0s
      // (fork + canonical fallback) in one call.
      logs = await chains.rawGetLogs(client, {
        address: chain.poolManager,
        topics: [[V4_SWAP_TOPIC0_FORK, V4_SWAP_TOPIC0_CANON], opts.poolId.toLowerCase()],
        fromBlock: Number(fromBlock),
        toBlock: Number(latest),
      });
    } else if (opts.poolAddress) {
      // V3: Swap events on the pool contract itself.
      logs = await chains.rawGetLogs(client, {
        address: opts.poolAddress.toLowerCase(),
        topics: [V3_SWAP_TOPIC0],
        fromBlock: Number(fromBlock),
        toBlock: Number(latest),
      });
    } else {
      return failOpen("smart-money: no poolId (V4) or poolAddress (V3) given");
    }

    // Most recent first (recent buys matter for staleness). When over the
    // log cap, sample BOTH ends: the newest half (freshness) + the oldest
    // half (the birth buys — the highest-signal ones; a watchlisted
    // wallet that bought at minute 0 is the oldest swap in the pool,
    // and a newest-only cap drops exactly that buy on a busy pool —
    // proven on Debtcat: 404 swaps in 30 min, #4's buy was the first).
    logs.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
    let capped = logs;
    if (logs.length > cfg.maxSwapLogs) {
      const half = Math.floor(cfg.maxSwapLogs / 2);
      const seen = new Set();
      capped = [];
      for (const l of [...logs.slice(0, half), ...logs.slice(-half)]) {
        const key = l.transactionHash + ":" + String(l.logIndex);
        if (!seen.has(key)) {
          seen.add(key);
          capped.push(l);
        }
      }
    }
    if (capped.length === 0) {
      return failOpen("smart-money: no Swap events for this pool yet");
    }

    // Buyer identity = the swap tx's `from` (the Swap event `sender` is
    // the router). Unique tx hashes, capped; fetched batched (see
    // fetchTxSenders) so a busy pool does not cost hundreds of RPC calls.
    const txHashes = [...new Set(capped.map((l) => l.transactionHash))].slice(
      0,
      cfg.maxTxFetches,
    );
    const fromByHash = await fetchTxSenders(client, txHashes, cfg.txBatchSize);

    const deployer = (opts.deployer || "").toLowerCase() || null;
    const creator = (opts.creator || "").toLowerCase() || null;

    // Block timestamps — only for blocks whose tx `from` is watchlisted.
    const blockTs = new Map();
    async function tsFor(blockNumber) {
      const key = Number(blockNumber);
      if (!blockTs.has(key)) {
        try {
          const blk = await client.getBlock({ blockNumber: BigInt(key) });
          blockTs.set(key, Number(blk.timestamp) * 1000);
        } catch {
          blockTs.set(key, null); // unknown timestamp -> buy not countable
        }
      }
      return blockTs.get(key);
    }

    const buys = [];
    for (const log of capped) {
      const from = fromByHash.get((log.transactionHash || "").toLowerCase());
      if (!from || !watchlist.byAddress.has(from)) continue;
      // Deployer exclusion: a watchlisted wallet buying its OWN token
      // never counts (the #1/#5 deployer-adjacent guard).
      if (deployer && from === deployer) continue;
      if (creator && from === creator) continue;
      const boughtAtMs = await tsFor(log.blockNumber);
      if (boughtAtMs === null) continue;
      buys.push({
        wallet: from,
        boughtAtMs,
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        stillHolds: null, // filled by the hold guard below
      });
    }
    if (buys.length === 0) {
      return failOpen("smart-money: no watchlisted wallet bought this pool");
    }

    // Hold guard: balanceOf > 0 at evaluation time, per distinct wallet.
    // An unreadable balance counts as NOT holding (conservative: no
    // points rather than points on a wallet that may have dumped).
    const wallets = [...new Set(buys.map((b) => b.wallet))];
    const holds = new Map();
    await Promise.all(
      wallets.map(async (w) => {
        try {
          const bal = await client.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [w],
          });
          holds.set(w, BigInt(bal) > 0n);
        } catch {
          holds.set(w, false);
        }
      }),
    );
    for (const b of buys) b.stillHolds = holds.get(b.wallet) === true;

    const scored = scoreFromBuys(buys, Date.now(), cfg);
    return {
      points: scored.points,
      detail: "smart-money: " + scored.detail,
      buyers: scored.buyers,
      buys,
    };
  } catch (e) {
    return failOpen("smart-money: lookup failed (fail-open): " + e.message.slice(0, 80));
  }
}

module.exports = {
  V4_SWAP_TOPIC0_FORK,
  V4_SWAP_TOPIC0_CANON,
  V3_SWAP_TOPIC0,
  DEFAULTS,
  resolveConfig,
  loadWatchlist,
  reloadWatchlist,
  scoreFromBuys,
  fetchTxSenders,
  scoreSmartMoney,
};
