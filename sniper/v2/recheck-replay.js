// recheck-replay.js — DRY-RUN replay of the FIXED recheck for GIGATENEV + JOSE.
//
// Background: the v2 recheck (+10 min) only re-scored socials and never
// recomputed the total, so a token that verified its website/socials after
// detection could never buy. This replay proves what the fixed recheck
// (full evaluatePool, all Part 51 gates) does with the two known cases.
//
//   GIGATENEV 0xc9675fe679c7d4e1b94416f66d61c96127eb964a — detected
//     2026-11-07 10:58:27Z at 20/100 (social 0/25), recheck social 25/25
//     => re-scored 45. Under the CURRENT buy line (45) that is a would-buy.
//   JOSE 0x62f61595de85e96e915fa98295373f47ac942fbf — detected 11:46:25Z
//     at 10/100 (social 0/25), recheck social 20/25 => re-scored 30.
//     Must stay no-buy.
//
// Method: find each token's V4 pool from the ORIGINAL detection scan
// window (Initialize logs on the Robinhood PoolManager), then run the
// full evaluator fresh — exactly what the fixed recheck does at +10 min.
// No txs, no STATE.json writes (the evaluator's normal fail-open memory
// recording still runs, same as any live watcher cycle).
//
// Usage: node recheck-replay.js

const chains = require("./chains.js");
const { evaluatePool } = require("./evaluate.js");

const CASES = [
  {
    symbol: "GIGATENEV",
    token: "0xc9675fe679c7d4e1b94416f66d61c96127eb964a",
    fromBlock: 108354534, toBlock: 108355655, // 2026-11-07 10:58Z run
    detectedScore: 20, recheckSocial: 25, expectedRescored: 45,
  },
  {
    symbol: "JOSE",
    token: "0x62f61595de85e96e915fa98295373f47ac942fbf",
    fromBlock: 108381700, toBlock: 108382841, // 2026-11-07 11:46Z run
    detectedScore: 10, recheckSocial: 20, expectedRescored: 30,
  },
];

async function main() {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  console.log(`buy line (half threshold): ${cfg.scoreThresholds?.half} | cap/chain: ${cfg.capPerChain} | buy size: $${cfg.buySizeUsd}`);
  for (const c of CASES) {
    console.log(`\n=== ${c.symbol} ${c.token} ===`);
    console.log(`detected at ${c.detectedScore}/100 (social 0/25) -> recheck social ${c.recheckSocial}/25 -> naive re-scored ${c.expectedRescored}/100`);
    let pools;
    try {
      pools = await chains.scanNewPools(chain, c.fromBlock, c.toBlock);
    } catch (e) {
      console.log(`  pool scan FAILED: ${e.message.slice(0, 150)}`);
      continue;
    }
    const mine = pools.filter((p) =>
      p.currency0.toLowerCase() === c.token.toLowerCase() ||
      p.currency1.toLowerCase() === c.token.toLowerCase());
    console.log(`  ${pools.length} pools in detection window, ${mine.length} for this token`);
    if (mine.length === 0) { console.log("  NO POOL FOUND in detection window — cannot replay"); continue; }
    for (const pool of mine) {
      console.log(`  pool ${pool.poolId} (${pool.currency0.slice(0, 10)}..${pool.currency1.slice(0, 10)}) fee ${pool.fee} tickSpacing ${pool.tickSpacing} block ${pool.blockNumber}`);
      let res;
      try {
        res = await evaluatePool(cfg, chain, pool);
      } catch (e) {
        console.log(`  EVALUATOR ERROR: ${e.message.slice(0, 200)}`);
        continue;
      }
      for (const chk of res.checks) console.log(`    ${chk.pass ? "PASS" : "FAIL"} ${chk.check} — ${chk.pass ? chk.detail : chk.reason}`);
      for (const s of res.scores) console.log(`    SCORE ${s.component}: ${s.points}/${s.max} — ${s.detail}`);
      const scoreLine = res.scores.map((s) => `${s.component}:${s.points}`).join(" ");
      console.log(`  >>> FRESH EVALUATION: verdict=${res.verdict} score=${res.score}/100 size=${res.size} (${scoreLine}) reason=${res.reason}`);
      if (res.verdict === "SKIP") {
        console.log(`  >>> RECHECK DECISION: NO-BUY (SKIP — ${res.reason})`);
      } else if (res.size === "watch") {
        console.log(`  >>> RECHECK DECISION: NO-BUY (watch, ${res.score} < ${cfg.scoreThresholds?.half})`);
      } else {
        console.log(`  >>> RECHECK DECISION: WOULD-BUY at ${res.score}/100 size ${res.size} (recheck buy path: cap + balance guard + live flags would apply in production)`);
      }
    }
  }
  console.log("\n=== replay end (dry-run, no txs, no STATE writes) ===");
}

main().catch((e) => { console.error("REPLAY ERROR:", e); process.exit(1); });
