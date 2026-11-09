// recheck-test.js — tests for the Part 52 recheck fix (run.js + v3-live-run.js):
//   1. processRechecks re-runs the FULL evaluation and buys at/above the
//      current buy line (45), drops below it; errors fail open (log + drop).
//   2. Legacy entries (no poolKey) keep the old social-only behavior.
//   3. Not-yet-due entries stay queued; already-held pools never re-buy.
//   4. processV3Rechecks mirrors all of the above for V3.
//   5. attemptBuy dry-run branch logs would-BUY and sends nothing; live
//      branch refuses without live flags (cap/balance guards untouched).
//
// All evaluation/buy/social calls are STUBBED — no RPCs, no txs, no STATE
// writes, no memory writes (updateDecision no-ops for tokens not in the
// DB; the stubs never reach it anyway except the recheck-skip/watch
// memUpdate, which no-ops for the fake tokens used here).
// The real evaluator path (GIGATENEV/JOSE) is covered by recheck-replay.js.
//
// Usage: node recheck-test.js

const { processRechecks, attemptBuy } = require("./run.js");
const { processV3Rechecks, attemptV3Buy } = require("./v3-live-run.js");

let passed = 0, failed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + " " + (extra || "")); }
}

const POOLKEY = {
  poolId: "0x" + "ab".repeat(32),
  currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  currency1: "0x00000000000000000000000000000000000000aa",
  fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000",
};
const TOKEN = "0x00000000000000000000000000000000000000aa";
const QUOTE = { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", decimals: 18 };

function fakeEntry(overrides = {}) {
  return {
    chainId: 4663, poolId: POOLKEY.poolId, token: TOKEN, symbol: "TEST",
    detectedAt: Date.now() - 20 * 60 * 1000, // due (+10 min elapsed)
    quote: QUOTE, initialScore: 20,
    initialScores: [{ component: "social-website", points: 0, max: 25 }],
    poolKey: { ...POOLKEY }, txHash: "0x" + "cd".repeat(32),
    blockNumber: 108000000, sqrtPriceX96: "79228162514264337593543950336",
    ...overrides,
  };
}
function fakeRes(score, size, verdict = "PASS") {
  return {
    verdict, score, size, token: TOKEN, symbol: "TEST", decimals: 18,
    poolKey: { ...POOLKEY }, quote: QUOTE,
    scores: [{ component: "social-website", points: 25, max: 25 }],
    spotQuotePerToken: 0.001,
  };
}

(async () => {
  const cfg = require("./config.json");
  const buyLine = cfg.scoreThresholds?.half;
  console.log(`buy line from config: ${buyLine} (must be 45, not the stale 50)`);
  check("buy line is 45", buyLine === 45, `(got ${buyLine})`);

  // ---------- A. v2 processRechecks ----------
  console.log("--- A. v2 processRechecks ---");
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(45, "half"),
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 25, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeEntry()], positions: [], snipesDone: {} };
    const { stillPending, stats } = await processRechecks(cfg, state, false, deps);
    check("45/100 re-score -> would-buy (fix working)", buyCalls === 1 && stats.wouldBuy === 1, JSON.stringify(stats));
    check("bought entry dropped from queue", stillPending.length === 0);
    check("re-score logged with old->new", logs.some((l) => l.includes("re-scored 45/100") && l.includes("from 20/100")), logs.join(" | "));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(30, "watch"),
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 20, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeEntry()], positions: [], snipesDone: {} };
    const { stillPending, stats } = await processRechecks(cfg, state, false, deps);
    check("30/100 re-score -> no buy", buyCalls === 0 && stats.noBuy === 1, JSON.stringify(stats));
    check("watch entry dropped", stillPending.length === 0);
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(0, null, "SKIP"),
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 0, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeEntry()], positions: [], snipesDone: {} };
    const { stats } = await processRechecks(cfg, state, false, deps);
    check("SKIP on re-evaluation -> no buy", buyCalls === 0 && stats.skipped === 1, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => { throw new Error("boom"); },
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 0, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeEntry()], positions: [], snipesDone: {} };
    const { stillPending, stats } = await processRechecks(cfg, state, false, deps);
    check("evaluator error -> fail-open (log + drop, no buy)", buyCalls === 0 && stats.errors === 1 && stillPending.length === 0, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0, socialCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(90, "full"),
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => { socialCalls++; return { points: 25, detail: "stub" }; },
      log: (m) => logs.push(m),
    };
    const legacy = fakeEntry(); delete legacy.poolKey;
    const state = { pendingRechecks: [legacy], positions: [], snipesDone: {} };
    const { stillPending, stats } = await processRechecks(cfg, state, false, deps);
    check("legacy entry (no poolKey) -> social-only, never buys", buyCalls === 0 && socialCalls === 1 && stats.legacy === 1 && stillPending.length === 0, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(90, "full"),
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 25, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const fresh = fakeEntry({ detectedAt: Date.now() }); // not due yet
    const state = { pendingRechecks: [fresh], positions: [], snipesDone: {} };
    const { stillPending, stats } = await processRechecks(cfg, state, false, deps);
    check("not-yet-due entry stays queued, unevaluated", stillPending.length === 1 && stats.due === 0 && buyCalls === 0, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(80, "full"),
      attemptBuy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 25, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = {
      pendingRechecks: [fakeEntry()],
      positions: [{ poolId: POOLKEY.poolId, token: TOKEN, soldAll: false }],
      snipesDone: {},
    };
    const { stats } = await processRechecks(cfg, state, false, deps);
    check("already-held pool -> recheck buy skipped", buyCalls === 0 && stats.noBuy === 1, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluatePool: async () => fakeRes(70, "full"),
      attemptBuy: async () => { buyCalls++; return "bought"; },
      scoreSocial: async () => ({ points: 25, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeEntry()], positions: [], snipesDone: {} };
    const { stats } = await processRechecks(cfg, state, true, deps);
    check("live recheck -> buy path returns bought", buyCalls === 1 && stats.bought === 1, JSON.stringify(stats));
  }

  // ---------- B. attemptBuy dry-run branch (no stubs — real function, live=false) ----------
  console.log("--- B. attemptBuy dry-run ---");
  {
    const state = { pendingRechecks: [], positions: [], snipesDone: {} };
    const chain = { chainId: 4663, ...cfg.chains["4663"] };
    const pool = { poolId: POOLKEY.poolId, sqrtPriceX96: 79228162514264337593543950336n };
    const out = await attemptBuy(cfg, chain, state, null, pool, fakeRes(45, "half"), false);
    check("dry-run attemptBuy -> would-buy, no position recorded", out === "would-buy" && state.positions.length === 0 && (state.snipesDone["4663"] || 0) === 0);
  }

  // ---------- C. v3 processV3Rechecks ----------
  console.log("--- C. v3 processV3Rechecks ---");
  function fakeV3Entry(overrides = {}) {
    return {
      chainId: 4663, poolAddress: "0x" + "ef".repeat(20), token: TOKEN, symbol: "TEST3",
      detectedAt: Date.now() - 20 * 60 * 1000, quote: QUOTE, initialScore: 20,
      initialScores: [{ component: "social-website", points: 0, max: 25 }],
      token0: QUOTE.address, token1: TOKEN, fee: 3000, tickSpacing: 60,
      blockNumber: 108000000, txHash: "0x" + "cd".repeat(32),
      ...overrides,
    };
  }
  function fakeV3Res(score, size, verdict = "PASS") {
    return {
      verdict, score, size, token: TOKEN, symbol: "TEST3", decimals: 18,
      poolAddress: "0x" + "ef".repeat(20), quote: QUOTE,
      scores: [{ component: "social-website", points: 25, max: 25 }],
    };
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluateV3Pool: async () => fakeV3Res(45, "half"),
      attemptV3Buy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 25, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeV3Entry()], positions: [], wouldBuys: [], v3SnipesDone: 0 };
    const { stillPending, stats } = await processV3Rechecks(cfg, state, false, deps);
    check("V3 45/100 re-score -> would-buy", buyCalls === 1 && stats.wouldBuy === 1 && stillPending.length === 0, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluateV3Pool: async () => fakeV3Res(30, "watch"),
      attemptV3Buy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 20, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeV3Entry()], positions: [], wouldBuys: [], v3SnipesDone: 0 };
    const { stats } = await processV3Rechecks(cfg, state, false, deps);
    check("V3 30/100 re-score -> no buy", buyCalls === 0 && stats.noBuy === 1, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0, socialCalls = 0;
    const deps = {
      evaluateV3Pool: async () => fakeV3Res(90, "full"),
      attemptV3Buy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => { socialCalls++; return { points: 25, detail: "stub" }; },
      log: (m) => logs.push(m),
    };
    const legacy = fakeV3Entry(); delete legacy.token0; delete legacy.token1;
    const state = { pendingRechecks: [legacy], positions: [], wouldBuys: [], v3SnipesDone: 0 };
    const { stillPending, stats } = await processV3Rechecks(cfg, state, false, deps);
    check("V3 legacy entry (no token0) -> social-only, never buys", buyCalls === 0 && socialCalls === 1 && stats.legacy === 1 && stillPending.length === 0, JSON.stringify(stats));
  }
  {
    const logs = [];
    let buyCalls = 0;
    const deps = {
      evaluateV3Pool: async () => { throw new Error("boom"); },
      attemptV3Buy: async () => { buyCalls++; return "would-buy"; },
      scoreSocial: async () => ({ points: 0, detail: "stub" }),
      log: (m) => logs.push(m),
    };
    const state = { pendingRechecks: [fakeV3Entry()], positions: [], wouldBuys: [], v3SnipesDone: 0 };
    const { stillPending, stats } = await processV3Rechecks(cfg, state, false, deps);
    check("V3 evaluator error -> fail-open (log + drop)", buyCalls === 0 && stats.errors === 1 && stillPending.length === 0, JSON.stringify(stats));
  }

  // ---------- D. attemptV3Buy dry-run branch ----------
  console.log("--- D. attemptV3Buy dry-run ---");
  {
    const state = { pendingRechecks: [], positions: [], wouldBuys: [], v3SnipesDone: 0 };
    const chain = { chainId: 4663, ...cfg.chains["4663"] };
    const pool = { pool: "0x" + "ef".repeat(20), token0: QUOTE.address, token1: TOKEN };
    const out = await attemptV3Buy(cfg, chain, state, null, pool, fakeV3Res(45, "half"), false, null);
    check("dry-run attemptV3Buy -> would-buy, wouldBuys recorded, no position", out === "would-buy" && state.wouldBuys.length === 1 && state.positions.length === 0 && state.v3SnipesDone === 0);
  }

  console.log(`\n=== recheck-test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
