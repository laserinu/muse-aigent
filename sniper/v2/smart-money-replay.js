// smart-money-replay.js — live replay of the Part 54 known cases against
// the real Robinhood RPC (read-only, no transactions).
//
// Usage:
//   node smart-money-replay.js
//
// Cases (all from the Part 54 research, verified onchain 2026-11-09):
//   1. V4 Swap topic control — the agent's own USDG funding swap receipt
//      (0x6fcc9e79...) must carry a PoolManager log with the fork Swap
//      topic0 0x40e9cecb... (proves the fork signature is the live one;
//      canonical 0x105ac8df... appears nowhere on our chains).
//   2. MCAT (V4, POSITIVE) — #4 (0xe1d16068...) bought MCAT at block
//      109601629 in V4 pool 0xddca8f9b... and STILL HOLDS (balance
//      432,564,252,359,008,400,234,240 verified 2026-11-09 ~07:10 GMT+7).
//      Expect +10 if the buy is <24h old, +5 if 24-48h (age computed
//      live, not hardcoded).
//   3. Debtcat (V4, HOLD GUARD) — #4 bought Debtcat at block 109603936
//      in V4 pool 0xf1c11369... and SOLD (balance 0 verified). The buy
//      must be DETECTED (buys[] non-empty, stillHolds false) but score 0.
//   4. PUSSYCOIN (V3, HOLD GUARD) — #1 (0xc5606cde...) bought PUSSYCOIN
//      at block 109507215 through V3 pool 0x62ab521f... and SOLD 1 min
//      later (balance 0 verified). The buy must be DETECTED but score 0.
//      Note: this buy went through V3, not V4 — the V4 poolId in the same
//      receipt (0x676b5e76...) carried ModifyLiquidity logs, not a Swap.
const chains = require("./chains.js");
const { scoreSmartMoney, V4_SWAP_TOPIC0_FORK } = require("./smart-money.js");

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log((ok ? "  PASS" : "  FAIL") + " " + name + " — got " + got + ", want " + want);
}

async function receiptHasTopic(rpcUrl, txHash, address, topic0) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
  });
  const json = await res.json();
  const logs = (json.result && json.result.logs) || [];
  return logs.some(
    (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === topic0,
  );
}

(async () => {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const rpc = chain.logsRpc || chain.rpc;

  console.log("== Case 1: V4 Swap topic control (USDG funding swap receipt) ==");
  const hasForkTopic = await receiptHasTopic(
    rpc,
    "0x6fcc9e79007c841c96ecab391fc699ebbe59e0b70bb172062754ed40c13ea968",
    chain.poolManager,
    V4_SWAP_TOPIC0_FORK,
  );
  check("USDG funding swap receipt carries fork Swap topic0 0x40e9cecb...", hasForkTopic ? 1 : 0, 1);

  console.log("== Case 2: MCAT (V4, #4 still holds — expect +10 or +5 by age) ==");
  const mcat = await scoreSmartMoney(chain, {
    poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
    token: "0x81a4d02e6e1ca42c0c96e16defee145cfadcec20",
    poolBlock: 109601629,
    cfg,
  });
  console.log("  MCAT result:", mcat.points, "—", mcat.detail);
  console.log("  MCAT buys:", JSON.stringify(mcat.buys));
  const mcatBuyAgeH = mcat.buys.length
    ? (Date.now() - mcat.buys[0].boughtAtMs) / 3600000
    : null;
  const mcatExpected = mcatBuyAgeH === null ? 0 : mcatBuyAgeH < 24 ? 10 : mcatBuyAgeH < 48 ? 5 : 0;
  console.log(`  MCAT buy age: ${mcatBuyAgeH === null ? "n/a" : mcatBuyAgeH.toFixed(2) + "h"} -> expected ${mcatExpected}`);
  check("MCAT detected #4 buy", mcat.buys.length >= 1 ? 1 : 0, 1);
  check("MCAT #4 still holds", mcat.buys.length && mcat.buys[0].stillHolds === true ? 1 : 0, 1);
  check("MCAT points match buy age", mcat.points, mcatExpected);

  console.log("== Case 3: Debtcat (V4, #4 sold — expect 0, buy detected) ==");
  const debt = await scoreSmartMoney(chain, {
    poolId: "0xf1c11369d9f53fa9188dcd492577111f270edbf9e232073349e2404146ffac4d",
    token: "0x1938c8ec9373c8c0e1e289668fc838c47fcd3f22",
    poolBlock: 109603936,
    cfg,
  });
  console.log("  Debtcat result:", debt.points, "—", debt.detail);
  console.log("  Debtcat buys:", JSON.stringify(debt.buys));
  check("Debtcat buy detected", debt.buys.length >= 1 ? 1 : 0, 1);
  check("Debtcat #4 no longer holds", debt.buys.length && debt.buys[0].stillHolds === false ? 1 : 0, 1);
  check("Debtcat points 0 (hold guard)", debt.points, 0);

  console.log("== Case 4: PUSSYCOIN (V3, #1 sold — expect 0, buy detected) ==");
  const pussy = await scoreSmartMoney(chain, {
    poolAddress: "0x62ab521f71431f78ac374cdbadc6cda3c8916b6c",
    token: "0x2e0885d48cb931ca4bbcaad84332e028dd741e18",
    poolBlock: 109507215,
    cfg,
  });
  console.log("  PUSSYCOIN result:", pussy.points, "—", pussy.detail);
  console.log("  PUSSYCOIN buys:", JSON.stringify(pussy.buys));
  check("PUSSYCOIN buy detected via V3 Swap", pussy.buys.length >= 1 ? 1 : 0, 1);
  check("PUSSYCOIN #1 no longer holds", pussy.buys.length && pussy.buys[0].stillHolds === false ? 1 : 0, 1);
  check("PUSSYCOIN points 0 (hold guard)", pussy.points, 0);

  console.log(failures === 0 ? "=== ALL SMART-MONEY REPLAY CHECKS PASSED ===" : `=== ${failures} REPLAY CHECK(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("REPLAY ERROR:", e.message); process.exit(1); });
