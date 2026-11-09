// holders-replay.js — replay a real pool through the evaluator with the
// holder-concentration check on vs off, to show the before/after score
// delta on live data.
//
// Usage:
//   HOLDERS_ENABLED=0 node holders-replay.js v3 <poolAddress>
//   HOLDERS_ENABLED=1 node holders-replay.js v3 <poolAddress>
//   HOLDERS_ENABLED=0 node holders-replay.js v2 <chainId> <poolId>
//   HOLDERS_ENABLED=1 node holders-replay.js v2 <chainId> <poolId>
//
// Read-only: runs the evaluator only. No transactions, no STATE writes.
const cfg = require("./config.json");
const chains = require("./chains.js");
const holders = require("./holders.js");

async function replayV3(poolAddress) {
  const { evaluateV3Pool, readV3PoolState } = require("./v3.js");
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const state = await readV3PoolState(client, poolAddress);
  const fs = require("fs");
  let txHash = "0x" + "0".repeat(64);
  let blockNumber = 0;
  try {
    const st = JSON.parse(fs.readFileSync(__dirname + "/v3-STATE.json", "utf8"));
    const hit = (st.evaluated || []).find((e) => (e.pool || "").toLowerCase() === poolAddress.toLowerCase());
    if (hit) { txHash = hit.txHash; blockNumber = hit.blockNumber; }
  } catch { /* no state entry — attribution will report the failure */ }
  const pool = {
    token0: state.token0, token1: state.token1, fee: state.fee,
    tickSpacing: state.tickSpacing, pool: poolAddress.toLowerCase(),
    blockNumber, txHash, logIndex: 0,
  };
  const r = await evaluateV3Pool(cfg, chain, pool);
  printResult("v3", r);
}

async function replayV2(chainId, poolId) {
  const { evaluatePool } = require("./evaluate.js");
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
  const r = await evaluatePool(cfg, chain, pool);
  printResult("v2", r);
}

function printResult(kind, r) {
  console.log(`--- ${kind} replay: ${r.symbol || "?"} ${r.token} ---`);
  for (const s of r.scores) console.log(`  SCORE ${s.component} ${s.points}/${s.max} - ${s.detail}`);
  console.log(`=== VERDICT: ${r.verdict} score ${r.score} size ${r.size} - ${r.reason} ===`);
  if (r.holders) console.log("holders raw: " + JSON.stringify(r.holders.raw));
  if (r.goplus) console.log("goplus raw: " + JSON.stringify(r.goplus.raw));
}

(async () => {
  const kind = process.argv[2];
  if (kind === "v3") await replayV3(process.argv[3]);
  else if (kind === "v2") await replayV2(process.argv[3], process.argv[4]);
  else { console.log("usage: node holders-replay.js v3 <poolAddress> | v2 <chainId> <poolId>"); process.exit(1); }
})().catch((e) => { console.error("REPLAY ERROR:", e.message); process.exit(1); });
