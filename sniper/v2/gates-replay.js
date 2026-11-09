// gates-replay.js — replay a real pool through the evaluator with the
// Part 51 gates ON vs OFF, to show the before/after verdict + score delta
// on live data.
//
// Usage:
//   node gates-replay.js v3 <poolAddress>
//   node gates-replay.js v2 <chainId> <poolId>
//
// Runs the evaluator twice in-process (gates on, then gates off via
// TOKEN_AGE_ENABLED=0 + MIN500_ENABLED=0) and prints both verdicts, the
// two gate checks, and every score-component delta.
//
// Read-only: runs the evaluator only. No transactions, no STATE writes.
// (The evaluator does record its evaluation to memory.sqlite, like the
// other replay scripts.)
const cfg = require("./config.json");
const chains = require("./chains.js");
const holders = require("./holders.js");
const v3mod = require("./v3.js");

function gateChecks(r) {
  const out = {};
  for (const c of (r.checks || [])) {
    // fail() stores `reason`, pass() stores `detail` — print whichever exists.
    if (c.check === "token-age" || c.check === "min-500-tokens") out[c.check] = (c.pass ? "PASS" : "FAIL") + " — " + (c.detail || c.reason || "");
  }
  return out;
}

function printResult(label, r) {
  console.log(`--- ${label}: ${r.symbol || "?"} ${r.token} ---`);
  console.log(`  VERDICT: ${r.verdict} score ${r.score} size ${r.size} - ${r.reason}`);
  const g = gateChecks(r);
  console.log(`  token-age: ${g["token-age"] || "(not reached)"}`);
  console.log(`  min-500-tokens: ${g["min-500-tokens"] || "(not reached)"}`);
  if (r.tokenAge) console.log(`  age: known=${r.tokenAge.known} firstPool=${r.tokenAge.firstPoolAtMs ? new Date(r.tokenAge.firstPoolAtMs).toISOString() : null} ageH=${r.tokenAge.ageHours !== null ? r.tokenAge.ageHours.toFixed(1) : null} sources=${(r.tokenAge.sources || []).join("+")}`);
  if (r.expectedBuyTokensWhole !== undefined) console.log(`  expectedBuyTokensWhole: ${r.expectedBuyTokensWhole.toFixed(2)}`);
  for (const s of r.scores || []) console.log(`  SCORE ${s.component} ${s.points}/${s.max} - ${s.detail}`);
}

async function runBoth(label, fn) {
  delete process.env.TOKEN_AGE_ENABLED;
  delete process.env.MIN500_ENABLED;
  const on = await fn();
  process.env.TOKEN_AGE_ENABLED = "0";
  process.env.MIN500_ENABLED = "0";
  const off = await fn();
  printResult(label + "  [gates ON]", on);
  printResult(label + "  [gates OFF]", off);
  const delta = on.score - off.score;
  const verdictChanged = on.verdict !== off.verdict;
  console.log(`=== ${(on.symbol || off.symbol || "?")}: score ${off.score} -> ${on.score} (${delta >= 0 ? "+" : ""}${delta}) | verdict ${off.verdict} -> ${on.verdict}${verdictChanged ? "  <-- CHANGED" : ""} ===\n`);
}

async function findPoolCreatedTx(client, token0, token1, fee) {
  // 10M-block windows, Robinhood RPC allows them (proven in the Pools.xyz
  // trace + registries-replay.js). DELTA's PoolCreated sits ~84M blocks
  // back, so up to 12 windows are scanned.
  const latest = Number(await client.getBlockNumber());
  for (let i = 0; i < 12; i++) {
    const to = latest - i * 10000000;
    const from = Math.max(0, to - 9999999);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(client.transport.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_getLogs",
            params: [{
              address: v3mod.V3_FACTORY_RH,
              topics: [
                v3mod.POOLCREATED_TOPIC0,
                "0x000000000000000000000000" + token0.slice(2),
                "0x000000000000000000000000" + token1.slice(2),
                "0x" + fee.toString(16).padStart(64, "0"),
              ],
              fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
            }],
          }),
        });
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        const json = await res.json();
        if (json.error) throw new Error(JSON.stringify(json.error));
        if ((json.result || []).length > 0) return json.result[0].transactionHash;
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  return "0x" + "0".repeat(64);
}

async function replayV3(poolAddress) {
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const state = await v3mod.readV3PoolState(client, poolAddress);
  let txHash = "0x" + "0".repeat(64);
  let blockNumber = 0;
  try {
    const fs = require("fs");
    const st = JSON.parse(fs.readFileSync(__dirname + "/v3-STATE.json", "utf8"));
    const hit = (st.evaluated || []).find((e) => (e.pool || "").toLowerCase() === poolAddress.toLowerCase());
    if (hit && hit.txHash) { txHash = hit.txHash; blockNumber = hit.blockNumber || 0; }
  } catch { /* no state entry — fall through to the log lookup */ }
  if (txHash === "0x" + "0".repeat(64)) {
    console.log("  (txHash not in state — recovering from V3 factory logs…)");
    txHash = await findPoolCreatedTx(client, state.token0, state.token1, state.fee);
  }
  const pool = {
    token0: state.token0, token1: state.token1, fee: state.fee,
    tickSpacing: state.tickSpacing, pool: poolAddress.toLowerCase(),
    blockNumber, txHash, logIndex: 0,
  };
  await runBoth("v3 " + poolAddress, () => v3mod.evaluateV3Pool(cfg, chain, pool));
}

async function replayV2(chainId, poolId) {
  const chain = { chainId: Number(chainId), ...cfg.chains[String(chainId)] };
  const client = chains.makeClient(chain);
  const latest = await client.getBlockNumber();
  const logs = await holders.fetchLogsPaced(client, {
    address: chain.poolManager,
    topics: [chains.INITIALIZE_TOPIC0, poolId],
    fromBlock: Number(latest - 500000n), toBlock: Number(latest),
  });
  if (logs.length === 0) { console.log("pool not found in last 500k blocks"); process.exit(1); }
  const pool = chains.decodeInitialize(logs[0]);
  await runBoth("v2 " + chainId + " " + poolId.slice(0, 18) + "…", () => require("./evaluate.js").evaluatePool(cfg, chain, pool));
}

(async () => {
  const kind = process.argv[2];
  if (kind === "v3") await replayV3(process.argv[3]);
  else if (kind === "v2") await replayV2(process.argv[3], process.argv[4]);
  else { console.log("usage: node gates-replay.js v3 <poolAddress> | v2 <chainId> <poolId>"); process.exit(1); }
})().catch((e) => { console.error("REPLAY ERROR:", e.message); process.exit(1); });
