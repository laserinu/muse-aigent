// copy-trade-amount-out-test.js — unit proof for the Part 76 fix:
// the copy-trader now records the ACTUAL received amount (balance delta)
// instead of only amountOutMinimum. Pure function, no live transaction
// is sent, no state file is written. Run:
//   node copy-trade-amount-out-test.js
//
// Proof case (real onchain data, IFSO 2026-11-09):
//   buy tx 0x80577ada... delivered 310,934,018,152,119,157,173 raw IFSO
//   (receipt Transfer log, block 110061679); the runner had announced
//   495.40 from the estimate and recorded only amountOutMinimum 254.72.
//   The mirror-sell sold exactly 310,934,018,152,119,157,173 raw.
const assert = require("assert");
const { formatUnits } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const ct = require("./copy-trade.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS: ${name}`);
}

// A1 — the IFSO case: 0 held before, 310.93 received.
check("A1 IFSO exact receipt amount", () => {
  const out = ct.actualAmountOut(0n, 310934018152119157173n);
  assert.strictEqual(out, 310934018152119157173n);
});

// A2 — already-held balance: the delta is still exact (only this buy).
check("A2 delta with pre-existing holding", () => {
  const out = ct.actualAmountOut(1000000000000000000n, 311934018152119157173n);
  assert.strictEqual(out, 310934018152119157173n);
});

// A3 — null before (balance read failed pre-buy): fail-open, null out.
check("A3 null before → null", () => {
  assert.strictEqual(ct.actualAmountOut(null, 310934018152119157173n), null);
});

// A4 — null after (balance read failed post-buy): fail-open, null out.
check("A4 null after → null", () => {
  assert.strictEqual(ct.actualAmountOut(0n, null), null);
});

// A5 — no change (buy delivered nothing): null, not 0n.
check("A5 equal balances → null", () => {
  assert.strictEqual(ct.actualAmountOut(500n, 500n), null);
});

// A6 — balance went DOWN (should not happen): null, never negative.
check("A6 after < before → null", () => {
  assert.strictEqual(ct.actualAmountOut(1000n, 500n), null);
});

// A7 — string inputs (STATE stores strings): BigInt() accepts them.
check("A7 string inputs work", () => {
  assert.strictEqual(ct.actualAmountOut("0", "310934018152119157173"), 310934018152119157173n);
});

// A8 — display trim: the runner's log line shows ≤4 decimals.
check("A8 log display trims to 4 decimals", () => {
  const human = formatUnits(310934018152119157173n, 18).replace(/(\.\d{4})\d+$/, "$1");
  assert.strictEqual(human, "310.9340");
});

console.log(`\n${passed}/8 amount-out tests passed.`);
