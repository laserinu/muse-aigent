// memory-test.js — Self-test for the deployer memory (memory.js).
// Uses a throwaway DB in /tmp (MEMORY_DB_PATH), never touches the live
// memory.sqlite. Run: node memory-test.js
// Checks: unknown -> 0, trusted -> +10, serial rugger -> -15,
// repeat rugger -> -10, all-died -> -5, cap clamp, due-check windows,
// recordOutcome at 7d sets final_outcome, fail-open with an unwritable
// path, and recordEvaluation first-insert-wins for the T+0 score.

const fs = require("fs");
const assert = require("assert");

const TEST_DB = "/tmp/memory-test-" + process.pid + ".sqlite";
process.env.MEMORY_DB_PATH = TEST_DB;
const mem = require("./memory.js");

const D = (n) => "0x" + String(n).repeat(40);
let passed = 0;
function check(name, fn) {
  try { fn(); console.log("  PASS " + name); passed++; }
  catch (e) { console.log("  FAIL " + name + ": " + e.message); process.exitCode = 1; }
}

function seedDeployer(deployer, outcomes) {
  outcomes.forEach((status, i) => {
    const token = "0x" + deployer.slice(2, 6) + String(i).padStart(36, "0");
    mem.recordEvaluation({ chainId: 4663, token, deployer, score: 40, decision: "watch", source: "test" });
    mem.recordOutcome(4663, token, "7d", { price: 1, peak: 1, liquidityUsd: 5000, trades24h: 10, status });
  });
}

console.log("== memory-test ==");
check("unknown deployer -> 0, never penalized", () => {
  const a = mem.adjustmentForDeployer(D("1"));
  assert.strictEqual(a.points, 0);
});
check("trusted deployer (5 alive, 0 rugged) -> +10", () => {
  seedDeployer(D("2"), ["alive", "alive", "alive", "alive", "alive"]);
  assert.strictEqual(mem.adjustmentForDeployer(D("2")).points, 10);
});
check("repeat healthy deployer (3 alive) -> +5", () => {
  seedDeployer(D("3"), ["alive", "alive", "alive"]);
  assert.strictEqual(mem.adjustmentForDeployer(D("3")).points, 5);
});
check("serial rugger (3 rugged) -> -15", () => {
  seedDeployer(D("4"), ["rugged", "rugged", "rugged"]);
  assert.strictEqual(mem.adjustmentForDeployer(D("4")).points, -15);
});
check("repeat rugger (2 rugged, 1 alive) -> -10", () => {
  seedDeployer(D("5"), ["rugged", "rugged", "alive"]);
  assert.strictEqual(mem.adjustmentForDeployer(D("5")).points, -10);
});
check("all-died deployer (3 abandoned) -> -5", () => {
  seedDeployer(D("6"), ["abandoned", "abandoned", "abandoned"]);
  assert.strictEqual(mem.adjustmentForDeployer(D("6")).points, -5);
});
check("mixed 1 rugged / 4 alive -> 0 (below thresholds)", () => {
  seedDeployer(D("7"), ["rugged", "alive", "alive", "alive", "alive"]);
  assert.strictEqual(mem.adjustmentForDeployer(D("7")).points, 0);
});
check("24h checkpoint outcome counts before 7d final", () => {
  const tok = "0x" + D("8").slice(2, 6) + "0".repeat(36);
  mem.recordEvaluation({ chainId: 4663, token: tok, deployer: D("8"), score: 40, decision: "watch", source: "test" });
  mem.recordOutcome(4663, tok, "24h", { price: 0.01, peak: 1, liquidityUsd: 5, trades24h: 0, status: "rugged" });
  const c = mem.outcomeCounts(D("8"));
  assert.strictEqual(c.rugged, 1);
  assert.strictEqual(c.launched, 1);
});
check("due-check windows (24h due, 72h not yet)", () => {
  const tok = "0x" + D("9").slice(2, 6) + "0".repeat(36);
  mem.recordEvaluation({ chainId: 4663, token: tok, deployer: D("9"), score: 10, decision: "watch", source: "test", firstSeenAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
  const due = mem.tokensDueForCheck(Date.now());
  const hit = due.find((t) => t.token === tok);
  assert.ok(hit, "token should be due");
  assert.deepStrictEqual(hit.checkpoints, ["24h"]);
});
check("recordEvaluation first-insert-wins for T+0 score", () => {
  const tok = "0x" + "a".repeat(40);
  mem.recordEvaluation({ chainId: 4663, token: tok, deployer: D("1"), score: 10, decision: "watch", source: "test" });
  mem.recordEvaluation({ chainId: 4663, token: tok, deployer: D("1"), score: 45, decision: "would-buy", source: "test" });
  const s = mem.stats();
  assert.ok(s.tokens >= 1);
  // Direct read: T+0 score must still be 10.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(TEST_DB);
  const row = db.prepare("SELECT score, decision FROM tokens WHERE token = ?").get(tok);
  db.close();
  assert.strictEqual(row.score, 10);
  assert.strictEqual(row.decision, "watch");
});
check("updateDecision upgrades a recorded decision", () => {
  const tok = "0x" + "b".repeat(40);
  mem.recordEvaluation({ chainId: 4663, token: tok, deployer: D("1"), score: 45, decision: "would-buy", source: "test" });
  assert.strictEqual(mem.updateDecision(4663, tok, "buy", { buyTx: "0x1234" }), true);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(TEST_DB);
  const row = db.prepare("SELECT decision, buy_tx FROM tokens WHERE token = ?").get(tok);
  db.close();
  assert.strictEqual(row.decision, "buy");
  assert.strictEqual(row.buy_tx, "0x1234");
});
check("fail-open: unwritable DB path -> neutral, no throw", () => {
  mem._resetForTest();
  // Bad path = a FILE as the parent dir: mkdir/open throws ENOTDIR fast.
  // (Do NOT use /proc — recursive mkdir hangs on procfs.)
  const blocker = "/tmp/memory-test-blocker-" + process.pid;
  fs.writeFileSync(blocker, "x");
  process.env.MEMORY_DB_PATH = blocker + "/memory.sqlite";
  const a = mem.adjustmentForDeployer(D("1"));
  assert.strictEqual(a.points, 0);
  assert.strictEqual(mem.recordEvaluation({ chainId: 4663, token: "0x" + "c".repeat(40), score: 1 }), false);
  assert.deepStrictEqual(mem.tokensDueForCheck(), []);
  mem._resetForTest();
  process.env.MEMORY_DB_PATH = TEST_DB;
  try { fs.unlinkSync(blocker); } catch { /* ignore */ }
});

console.log(`== ${passed} checks passed ==`);
try { fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + "-wal"); fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
