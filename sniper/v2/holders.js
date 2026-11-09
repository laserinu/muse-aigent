// holders.js — Holder-concentration + bundle-detection check for the snipers.
//
// Built 2026-11-08 (tools-and-sites Part 49; research Parts 46/47).
// The two highest-ranked checks the guides list that we did not do at all:
//   3. Holder concentration — top holder <5% safe / >15% danger; top 10
//      <20% / >40%; dev wallet <2% / >5% (Meme Central / DEXTools).
//   4. Bundled supply — same-block first-tx wallets, one funder,
//      near-identical amounts = one hidden holder (the most common
//      concealed concentration in 2026).
//
// CRITICAL: pool / burn / locker CONTRACTS are excluded before judging,
// per Meme Central — a pool holding 90% is not concentration. Our own
// $RMUSE reads 90.19% PoolManager + 8.81% agent wallet; the non-contract
// top-10 is 8.8%. All contracts are excluded (is_contract on the indexer,
// eth_getCode on the RPC path), plus the pool, burn addresses, and the
// token contract itself. ONE exception: a contract whose owner() IS the
// deployer counts toward the DEV share — parking supply in a contract you
// control does not hide it (our own $MUSE: the deployer factory holds
// ~95T; its owner is the agent wallet, so it counts as dev).
//
// DATA SOURCES — two tiers, indexer first, RPC fallback always available:
//   Tier 1 — Blockscout PRO API (https://api.blockscout.com/{chainId}/api/v2,
//     /tokens/{token}/holders + /tokens/{token}/transfers). FREE key, no
//     card, from dev.blockscout.com; covers 120+ chains incl. Robinhood
//     4663 + Arc 5042. Key via env BLOCKSCOUT_API_KEY. Used only when set.
//     (Why not keyless? The per-instance APIs — robinhoodchain.blockscout.com
//     and explorer.arc.io — return Cloudflare 403 "Just a moment..." from
//     this VM, verified live 2026-11-08; the PRO API without a key returns
//     HTTP 402. Why not Etherscan? The V2 API returns "Free API access is
//     not supported for this chain" for 4663/5042/8453 — those chains are
//     PAID-ONLY (Lite $49/mo; tokenholderlist itself is PRO, $199/mo),
//     verified live 2026-11-08; the per-chain api.*.etherscan.io hosts do
//     not even connect from this VM. Etherscan is unusable for holder data
//     on our chains at any free tier — documented, not built.)
//   Tier 2 — Onchain RPC fallback (NO key, works today): reconstruct holders
//     from the token's Transfer logs from 10k blocks before pool creation
//     to latest (paced 5000-block chunks with 429 retry — fetchLogsPaced;
//     the shared chains.rawGetLogs does NOT pace, and a burst of rapid
//     POSTs trips the Robinhood RPC's HTTP 429), aggregate net balances,
//     classify contracts via eth_getCode, dev share via direct
//     balanceOf(deployer) + deployer-owned contracts. Bundle =
//     same-block first-receive clustering + near-identical amounts.
//     Complete at T+0 (the distribution happens at/around pool creation
//     for launchpad tokens); for older pools the scan is capped and the
//     result is marked partial.
//
// Score component "holder-concentration", clamped to [-10, +5]:
//   top-1 non-contract  >15% -> -5;  >5% -> -2
//   top-10 non-contract >40% -> -5; >20% -> -2
//   dev share            >5%  -> -5;  >2% -> -2
//   bundle share         >25% -> -5; >10% -> -2
//   clean (+5): no negative fired AND data complete AND top-1 <=5% AND
//     top-10 <=20% AND dev <=2% AND bundle <10%. Null/unknown fields BLOCK
//     the bonus — at T+0 the deployer is often the only holder, so a
//     token whose deployer holds <=2% genuinely earns +5.
//   The deployer EOA is INCLUDED in top-1/top-10 (their share is also the
//   dev share, so a 30% deployer holding hits both sub-signals — clamped
//   at -10 total). This is deliberate: a deployer holding 30% at T+0 is a
//   major red flag, and the clamp bounds the double-count.
//
// Bundle rule (v1): first-receive clustering only. A cluster is >=3 wallets
// whose FIRST receipt of the token lands in the SAME block (within 3 blocks
// of the pool-creation block) with amounts within +/-10% of each other. The
// share is the members' CURRENT balances / totalSupply (a bundler who sold
// down counts less). The FUNDER LINK is NOT computed in v1 — proving one
// funder needs each buyer's funding history (an indexer join), which is too
// many calls per evaluation at T+0. Same-block + near-identical amounts is
// strong evidence, not proof; the limitation is stated in the detail.
// Airdrops look bundle-like (many identical receipts in one block) — the
// SHARE threshold is what matters, not the mere existence of a cluster
// (our own $MUSE airdrop clusters at ~4.8% — under the 10% mid line).
//
// Env overrides (no config.json change — keep the diff minimal):
//   BLOCKSCOUT_API_KEY      enables the indexer tier (else RPC fallback)
//   BLOCKSCOUT_BASE_URL     default https://api.blockscout.com
//   HOLDERS_ENABLED=0       disables the check (0 points, "disabled")
//   HOLDERS_TIMEOUT_MS      default 12000 (whole check, both tiers)
//   HOLDERS_RPC_MAX_BLOCKS  default 100000 (RPC log-scan window cap)
//
// Fail-open contract: scoreHolders NEVER throws. Every failure path
// returns { points: 0, detail: "holders: ... (fail-open)", raw: null }.

const chains = require("./chains.js");

const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
const BURN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

const BASE_URL = (process.env.BLOCKSCOUT_BASE_URL || "https://api.blockscout.com").replace(/\/$/, "");
const API_KEY = process.env.BLOCKSCOUT_API_KEY || null;
const ENABLED = process.env.HOLDERS_ENABLED !== "0";
const TIMEOUT_MS = Number(process.env.HOLDERS_TIMEOUT_MS || 12000);
const RPC_MAX_BLOCKS = Number(process.env.HOLDERS_RPC_MAX_BLOCKS || 100000);
const INDEXER_TIMEOUT_MS = 5000;
const MAX_HOLDER_CODE_CHECKS = 30;
const MAX_OWNER_CHECKS = 5;
const BUNDLE_MIN_MEMBERS = 3;
const BUNDLE_AMOUNT_TOL = 0.1; // amounts within +/-10% of each other
const BUNDLE_BLOCK_WINDOW = 3; // first receipts within 3 blocks of pool creation count as "same launch"

// Weights — the only tuning knobs; everything below reads these.
const W = {
  cleanBonus: 5,
  top1High: -5, // top-1 non-contract > 15%
  top1Mid: -2, // top-1 non-contract > 5%
  top10High: -5, // top-10 non-contract > 40%
  top10Mid: -2, // top-10 non-contract > 20%
  devHigh: -5, // dev share > 5%
  devMid: -2, // dev share > 2%
  bundleHigh: -5, // bundle share > 25%
  bundleMid: -2, // bundle share > 10%
  minPoints: -10,
  maxPoints: 5,
};
const TOP1_HIGH = 0.15, TOP1_MID = 0.05;
const TOP10_HIGH = 0.4, TOP10_MID = 0.2;
const DEV_HIGH = 0.05, DEV_MID = 0.02;
const BUNDLE_HIGH = 0.25, BUNDLE_MID = 0.1;

const lc = (a) => (a || "").toLowerCase();
const isBurn = (a) => BURN_ADDRESSES.has(lc(a));
const pct = (x) => (x === null || x === undefined ? "?" : (x * 100).toFixed(1) + "%");

// ---- Pure scoring of one normalized holder-data object. ----
// d: { top1, top10, devShare, bundleShare, holderCount, complete, source }
// Shares are fractions (0.088 = 8.8%) or null when unknown.
// Exported so the mapping can be tested without the network.
function scoreFromData(d) {
  const raw = {
    top1: d.top1 ?? null,
    top10: d.top10 ?? null,
    devShare: d.devShare ?? null,
    bundleShare: d.bundleShare ?? null,
    holderCount: d.holderCount ?? null,
    complete: !!d.complete,
    source: d.source || "unknown",
    bundleClusters: d.bundleClusters || [],
    topHolders: d.topHolders || [],
    devControlled: d.devControlled || [],
  };

  let points = 0;
  const notes = [];

  if (d.top1 !== null && d.top1 !== undefined) {
    if (d.top1 > TOP1_HIGH) { points += W.top1High; notes.push(`top-1 non-contract ${(d.top1 * 100).toFixed(1)}% > 15% ${W.top1High}`); }
    else if (d.top1 > TOP1_MID) { points += W.top1Mid; notes.push(`top-1 non-contract ${(d.top1 * 100).toFixed(1)}% > 5% ${W.top1Mid}`); }
  }
  if (d.top10 !== null && d.top10 !== undefined) {
    if (d.top10 > TOP10_HIGH) { points += W.top10High; notes.push(`top-10 non-contract ${(d.top10 * 100).toFixed(1)}% > 40% ${W.top10High}`); }
    else if (d.top10 > TOP10_MID) { points += W.top10Mid; notes.push(`top-10 non-contract ${(d.top10 * 100).toFixed(1)}% > 20% ${W.top10Mid}`); }
  }
  if (d.devShare !== null && d.devShare !== undefined) {
    if (d.devShare > DEV_HIGH) { points += W.devHigh; notes.push(`dev wallet ${(d.devShare * 100).toFixed(1)}% > 5% ${W.devHigh}`); }
    else if (d.devShare > DEV_MID) { points += W.devMid; notes.push(`dev wallet ${(d.devShare * 100).toFixed(1)}% > 2% ${W.devMid}`); }
  }
  if (d.bundleShare !== null && d.bundleShare !== undefined) {
    if (d.bundleShare > BUNDLE_HIGH) { points += W.bundleHigh; notes.push(`bundled supply ${(d.bundleShare * 100).toFixed(1)}% > 25% ${W.bundleHigh}`); }
    else if (d.bundleShare > BUNDLE_MID) { points += W.bundleMid; notes.push(`bundled supply ${(d.bundleShare * 100).toFixed(1)}% > 10% ${W.bundleMid}`); }
  }

  if (points === 0) {
    // Clean bonus only on COMPLETE, known data: nulls block it (GoPlus
    // precedent). An unknown dev share blocks it too — the deployer could
    // hold half the supply behind an unreadable balance.
    const explicitlyClean =
      d.complete === true &&
      (d.holderCount ?? 0) > 0 &&
      d.top1 !== null && d.top1 !== undefined && d.top1 <= TOP1_MID &&
      d.top10 !== null && d.top10 !== undefined && d.top10 <= TOP10_MID &&
      d.devShare !== null && d.devShare !== undefined && d.devShare <= DEV_MID &&
      d.bundleShare !== null && d.bundleShare !== undefined && d.bundleShare < BUNDLE_MID;
    if (explicitlyClean) {
      points = W.cleanBonus;
      notes.push(`clean — top-1 ${pct(d.top1)}, top-10 ${pct(d.top10)}, dev ${pct(d.devShare)}, bundle ${pct(d.bundleShare)}, ${d.holderCount ?? "?"} holders +${W.cleanBonus}`);
    } else {
      notes.push("no red flags, but data incomplete/unknown — no clean bonus at T+0");
    }
  }

  points = Math.max(W.minPoints, Math.min(W.maxPoints, points));
  return {
    points,
    detail:
      `holders(${raw.source}): top1 ${pct(d.top1)} top10 ${pct(d.top10)} dev ${pct(d.devShare)} bundle ${pct(d.bundleShare)} holders ${d.holderCount ?? "?"}${d.complete ? "" : " (PARTIAL)"} — ` +
      notes.join("; "),
    raw,
  };
}

// ---- Bundle clustering (pure, shared by both tiers). ----
// firstReceives: [{ address, block, amount: BigInt }] — first receipt per wallet.
// balances: Map(address -> BigInt current balance). totalSupply: BigInt.
// poolBlock: the pool-creation block — the bundle window anchors here
// (first receipts BEFORE the pool are allocations, not buys; null falls
// back to the earliest first-receive block).
// Returns { share, clusters: [{ block, members: [addr], share }] }.
// A cluster is >=3 wallets whose first receipt lands in the same block
// (within BUNDLE_BLOCK_WINDOW of the pool-creation block) with amounts
// within +/-10% of each other. Share uses CURRENT balances.
function findBundleClusters(firstReceives, balances, totalSupply, excludeSet, deployer, poolBlock = null) {
  if (!totalSupply || totalSupply === 0n || !Array.isArray(firstReceives) || firstReceives.length === 0) {
    return { share: 0, clusters: [] };
  }
  const anchor = poolBlock !== null && poolBlock !== undefined ? Number(poolBlock) : Math.min(...firstReceives.map((r) => r.block));
  // Candidates: first receipt near launch, amount > 0, not excluded, not the deployer.
  const cands = firstReceives.filter(
    (r) =>
      r.amount > 0n &&
      r.block >= anchor &&
      r.block <= anchor + BUNDLE_BLOCK_WINDOW &&
      !excludeSet.has(lc(r.address)) &&
      lc(r.address) !== lc(deployer || ""),
  );
  // Group by block; within a block, sort amounts and take the largest
  // run where max/min <= 1 + tol.
  const clusters = [];
  const byBlock = new Map();
  for (const c of cands) {
    if (!byBlock.has(c.block)) byBlock.set(c.block, []);
    byBlock.get(c.block).push(c);
  }
  for (const [block, rows] of byBlock) {
    const sorted = [...rows].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    let best = [];
    for (let i = 0; i < sorted.length; i++) {
      const run = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        if (Number((sorted[j].amount * 1000n) / sorted[i].amount) / 1000 <= 1 + BUNDLE_AMOUNT_TOL) run.push(sorted[j]);
        else break;
      }
      if (run.length > best.length) best = run;
    }
    if (best.length >= BUNDLE_MIN_MEMBERS) {
      let shareNum = 0n;
      for (const m of best) shareNum += balances.get(lc(m.address)) || 0n;
      const share = Number((shareNum * 10000n) / totalSupply) / 10000;
      clusters.push({ block, members: best.map((m) => m.address), share });
    }
  }
  clusters.sort((a, b) => b.share - a.share);
  const share = clusters.length > 0 ? clusters[0].share : 0;
  return { share, clusters };
}

// ---- Shared analysis: holders[] + first-receives -> normalized data. ----
// holders: [{ address, value: BigInt, isContract }] (all holders, any size).
// firstReceives: [{ address, block, amount: BigInt }].
// client: viem client or null — needed only for the deployer-owner check.
// poolSet: pool addresses (PoolManager / pool contract) — never counted as
// dev-controlled even if their owner() happens to be the deployer; the
// token contract itself IS owner-checked (a reserve parked in the token
// contract under the deployer's control is dev supply).
async function analyzeHolders(holders, firstReceives, totalSupply, excludeSet, deployer, client, source, complete, poolSet = new Set(), poolBlock = null) {
  const balances = new Map();
  for (const h of holders) balances.set(lc(h.address), h.value);
  const shareOf = (v) => (totalSupply && totalSupply > 0n ? Number((v * 10000n) / totalSupply) / 10000 : null);

  const nonContract = holders
    .filter((h) => !h.isContract && !excludeSet.has(lc(h.address)) && !isBurn(h.address) && h.value > 0n)
    .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const top1 = nonContract.length > 0 ? shareOf(nonContract[0].value) : 0;
  let top10sum = 0n;
  for (const h of nonContract.slice(0, 10)) top10sum += h.value;
  const top10 = nonContract.length > 0 ? shareOf(top10sum) : 0;
  const holderCount = holders.filter((h) => h.value > 0n).length;

  // Dev share: the deployer EOA's own balance PLUS any contract whose
  // owner() is the deployer (parking supply in your own contract does not
  // hide it). The owner check is capped, best-effort, and never throws.
  let devValue = 0n;
  if (deployer) {
    const devEntry = holders.find((h) => lc(h.address) === lc(deployer));
    if (devEntry) devValue += devEntry.value;
  }
  const devControlled = [];
  if (deployer && client) {
    const contractHolders = holders
      .filter((h) => h.isContract && h.value > 0n && !isBurn(h.address) && !poolSet.has(lc(h.address)))
      .sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))
      .slice(0, MAX_OWNER_CHECKS);
    await Promise.all(
      contractHolders.map(async (h) => {
        try {
          const owner = await client.readContract({
            address: h.address,
            abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
            functionName: "owner",
          });
          if (lc(owner) === lc(deployer)) {
            devValue += h.value;
            devControlled.push({ address: h.address, share: shareOf(h.value) });
          }
        } catch { /* no owner() — not deployer-owned, skip */ }
      }),
    );
  }
  const devShare = deployer ? shareOf(devValue) : null;

  const bundle = findBundleClusters(firstReceives, balances, totalSupply, excludeSet, deployer, poolBlock);
  return {
    source,
    complete,
    holderCount,
    top1,
    top10,
    devShare,
    bundleShare: bundle.share,
    bundleClusters: bundle.clusters,
    topHolders: nonContract.slice(0, 5).map((h) => ({ address: h.address, share: shareOf(h.value), isContract: false })),
    devControlled,
  };
}

// ---- Tier 1: Blockscout PRO API (keyed). ----
async function fetchBlockscoutJson(path) {
  const url = `${BASE_URL}/${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MuseSniperV2/2.0)" },
    signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Blockscout HTTP ${res.status}`);
  return res.json();
}

// Holders endpoint: /api/v2/tokens/{token}/holders?page_size=50.
// items: [{ address: { hash, is_contract }, value }]; next_page_params or null.
async function fetchBlockscoutHolders(chainId, token) {
  const holders = []; // { address, isContract, value: BigInt }
  let path = `${chainId}/api/v2/tokens/${token}/holders?page_size=50`;
  for (let page = 0; page < 2; page++) {
    const j = await fetchBlockscoutJson(path);
    for (const it of j.items || []) {
      const addr = it.address && (it.address.hash || it.address);
      if (!addr || it.value === undefined || it.value === null) continue;
      holders.push({ address: lc(addr), isContract: !!(it.address && it.address.is_contract), value: BigInt(it.value) });
    }
    const np = j.next_page_params;
    if (!np) break;
    const qs = new URLSearchParams(np).toString();
    path = `${chainId}/api/v2/tokens/${token}/holders?${qs}`;
  }
  return holders;
}

// Transfers endpoint: /api/v2/tokens/{token}/transfers?page_size=100.
// items: [{ block_number, from: { hash }, to: { hash }, total: { value }, transaction_hash }]
async function fetchBlockscoutTransfers(chainId, token) {
  const transfers = [];
  let path = `${chainId}/api/v2/tokens/${token}/transfers?page_size=100`;
  for (let page = 0; page < 3; page++) {
    const j = await fetchBlockscoutJson(path);
    for (const it of j.items || []) {
      const from = (it.from && (it.from.hash || it.from)) || null;
      const to = (it.to && (it.to.hash || it.to)) || null;
      const value = it.total && it.total.value !== undefined ? it.total.value : it.value;
      if (!from || !to || value === undefined || value === null || it.block_number === undefined) continue;
      transfers.push({ from: lc(from), to: lc(to), value: BigInt(value), block: Number(it.block_number) });
    }
    const np = j.next_page_params;
    if (!np) break;
    const qs = new URLSearchParams(np).toString();
    path = `${chainId}/api/v2/tokens/${token}/transfers?${qs}`;
  }
  return transfers;
}

// ---- Tier 2: onchain RPC fallback — Transfer-log reconstruction. ----
// Paced eth_getLogs over [fromBlock, toBlock] in 5000-block chunks (the
// shared chains.rawGetLogs chunks internally but does NOT pace or retry,
// and a burst of 70+ rapid POSTs trips the Robinhood RPC's HTTP 429 —
// see v3.js note). 400 ms between chunks, per-chunk retry on 429 with
// 1s/2s/3s backoff. Exported for the test's pool-creation lookup.
async function fetchLogsPaced(client, { address, topics, fromBlock, toBlock }) {
  const CHUNK = 5000;
  const out = [];
  for (let start = Number(fromBlock); start <= Number(toBlock); start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, Number(toBlock));
    let logs;
    for (let attempt = 1; ; attempt++) {
      try {
        logs = await chains.rawGetLogs(client, { address, topics, fromBlock: start, toBlock: end });
        break;
      } catch (e) {
        const rateLimited = /429|rate limit|too many requests/i.test(e.message);
        if (!rateLimited || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    out.push(...logs);
    if (end < Number(toBlock)) await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

const ERC20_MIN_ABI = [
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
];

async function reconstructFromLogs(client, token, poolBlock, totalSupply, deployer, excludeSet, poolSet = new Set()) {
  const latest = await client.getBlockNumber();
  // Look back 10k blocks before pool creation: the token is usually
  // deployed in the same flow minutes before the pool, and its mint /
  // initial allocation transfers live in that window. Without the lookback
  // the deployer's pre-pool allocation would be invisible to the
  // reconstruction (its balance is still exact via direct balanceOf, but
  // other pre-pool recipients would be missed).
  const LOOKBACK = 10000;
  const fromBlock = Math.max(0, Number(poolBlock) - LOOKBACK);
  const toBlock = Number(latest);
  const capped = toBlock - fromBlock > RPC_MAX_BLOCKS;
  const endBlock = capped ? fromBlock + RPC_MAX_BLOCKS : toBlock;

  // The Robinhood RPC throttles bursts (HTTP 429) — fetchLogsPaced paces
  // chunks and retries per chunk; if it still fails, fail-open (0) applies.
  const logs = await fetchLogsPaced(client, {
    address: token,
    topics: [TRANSFER_TOPIC0],
    fromBlock,
    toBlock: endBlock,
  });

  const balances = new Map(); // addr -> BigInt net
  const first = new Map(); // addr -> { address, block, amount }
  const add = (addr, delta) => {
    const a = lc(addr);
    balances.set(a, (balances.get(a) || 0n) + delta);
  };
  for (const log of logs) {
    const from = "0x" + (log.topics[1] || "0x").slice(26);
    const to = "0x" + (log.topics[2] || "0x").slice(26);
    let value;
    try { value = BigInt(log.data || "0x0"); } catch { continue; }
    const block = Number(log.blockNumber);
    if (lc(from) !== "0x0000000000000000000000000000000000000000") add(from, -value);
    add(to, value);
    if (value > 0n) {
      const cur = first.get(lc(to));
      if (!cur || block < cur.block) first.set(lc(to), { address: lc(to), block, amount: value });
    }
  }
  // Drop zero/negative dust (a balance can go negative if the scan window
  // missed an earlier receipt — only net > 0 counts as a holder).
  for (const [a, b] of [...balances]) if (b <= 0n) balances.delete(a);

  // Classify the top holders as contract/EOA (batched, capped). A getCode
  // failure counts the holder as non-contract (conservative: assume worst).
  const sorted = [...balances.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  const toClassify = sorted.slice(0, MAX_HOLDER_CODE_CHECKS);
  const codeFlags = new Map();
  await Promise.all(
    toClassify.map(async ([addr]) => {
      try {
        const code = await client.getBytecode({ address: addr });
        codeFlags.set(addr, !!(code && code !== "0x"));
      } catch {
        codeFlags.set(addr, false);
      }
    }),
  );
  const holders = sorted.map(([addr, value]) => ({
    address: addr,
    value,
    // Only the top N were classified; unclassified holders default to
    // non-contract (conservative) — they are small by construction.
    isContract: codeFlags.get(addr) === true,
  }));

  // Dev share: exact balanceOf(deployer) — independent of the log window
  // (the deployer's pre-pool receipts may predate the scan).
  if (deployer) {
    try {
      const devBal = BigInt(await client.readContract({ address: token, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [deployer] }));
      const existing = holders.find((h) => h.address === lc(deployer));
      if (existing) existing.value = devBal;
      else holders.push({ address: lc(deployer), value: devBal, isContract: false });
    } catch { /* dev balance stays as reconstructed */ }
  }

  const data = await analyzeHolders(holders, [...first.values()], totalSupply, excludeSet, deployer, client, "rpc-logs", !capped, poolSet, Number(poolBlock));
  data.scannedBlocks = endBlock - fromBlock;
  data.transferCount = logs.length;
  return data;
}

// ---- Main entry: score one token on one chain. ----
// opts: { client (viem public client, required for the RPC tier),
//         deployer, totalSupply (BigInt|string|null), poolBlock (number|null),
//         excludeAddresses (extra addresses to exclude: pool contract, ...),
//         poolAddress, timeoutMs (per-call whole-check timeout; default
//         HOLDERS_TIMEOUT_MS=12000 — live T+0 scans take ~2s, but old-pool
//         log reconstructions need ~1.2M-block windows and must pass a
//         longer timeout, e.g. 300000 in holders-test.js section C) }
// Never throws — every failure path returns 0 points, fail-open.
async function scoreHolders(chain, token, opts = {}) {
  const failOpen = (detail) => ({ points: 0, detail, raw: null });
  if (!ENABLED) return failOpen("holders: disabled (HOLDERS_ENABLED=0)");
  if (!chain || !chain.chainId || !token) return failOpen("holders: no chain/token given");

  const deployer = (opts.deployer || "").toLowerCase() || null;
  const poolSet = new Set([
    ...(opts.excludeAddresses || []).map((a) => lc(a)),
    ...(opts.poolAddress ? [lc(opts.poolAddress)] : []),
    lc(chain.poolManager || ""),
  ]);
  poolSet.delete("");
  const excludeSet = new Set([
    ...poolSet,
    lc(token), // the token contract itself
  ]);
  excludeSet.delete("");

  let totalSupply = null;
  if (opts.totalSupply !== null && opts.totalSupply !== undefined) {
    try { totalSupply = BigInt(opts.totalSupply); } catch { totalSupply = null; }
  }

  const run = (async () => {
    // Tier 1: Blockscout PRO indexer (only when a key is configured).
    let indexerError = null;
    if (API_KEY) {
      try {
        if (!totalSupply && opts.client) {
          totalSupply = BigInt(await opts.client.readContract({ address: token, abi: ERC20_MIN_ABI, functionName: "totalSupply" }));
        }
        const [holders, transfers] = await Promise.all([
          fetchBlockscoutHolders(chain.chainId, token),
          fetchBlockscoutTransfers(chain.chainId, token),
        ]);
        if (holders.length === 0) throw new Error("Blockscout returned 0 holders");
        const first = new Map();
        for (const t of transfers) {
          if (t.value <= 0n) continue;
          const cur = first.get(t.to);
          if (!cur || t.block < cur.block) first.set(t.to, { address: t.to, block: t.block, amount: t.value });
        }
        const data = await analyzeHolders(holders, [...first.values()], totalSupply, excludeSet, deployer, opts.client || null, "blockscout", true, poolSet, opts.poolBlock ?? null);
        return scoreFromData(data);
      } catch (e) {
        // Fall through to the RPC tier — do not fail the evaluation.
        indexerError = e.message.slice(0, 80);
      }
    }

    // Tier 2: onchain RPC fallback.
    if (!opts.client) return failOpen("holders: no RPC client available (fail-open)");
    if (opts.poolBlock === null || opts.poolBlock === undefined) return failOpen("holders: no pool block known (fail-open)");
    if (!totalSupply) {
      try {
        totalSupply = BigInt(await opts.client.readContract({ address: token, abi: ERC20_MIN_ABI, functionName: "totalSupply" }));
      } catch {
        return failOpen("holders: totalSupply unreadable (fail-open)");
      }
    }
    if (!totalSupply || totalSupply === 0n) return failOpen("holders: totalSupply is 0 (fail-open)");
    const data = await reconstructFromLogs(opts.client, token, opts.poolBlock, totalSupply, deployer, excludeSet, poolSet);
    const scored = scoreFromData(data);
    if (indexerError) scored.detail += ` [blockscout indexer failed (${indexerError}), RPC fallback used]`;
    return scored;
  })();

  // Per-call timeout (Part 51): the 12s default is right for live T+0
  // scans but far too short for old-pool reconstructions (~1.2M-block
  // Transfer-log windows — the $RMUSE/$MUSE test controls timed out at
  // 12s in every re-run). Callers that scan old pools pass timeoutMs.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TIMEOUT_MS;
  try {
    return await Promise.race([
      run,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
  } catch (e) {
    return failOpen("holders: " + e.message.slice(0, 80) + " (fail-open)");
  }
}

module.exports = { scoreHolders, scoreFromData, findBundleClusters, analyzeHolders, fetchLogsPaced, fetchBlockscoutHolders, fetchBlockscoutTransfers, W };
