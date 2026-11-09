// registries-replay.js — replay a real pool through the evaluator with the
// registries wired in, to show the launchpad-provenance + known-rug
// wiring on live data.
//
// Usage:
//   node registries-replay.js v3 <poolAddress>   (e.g. DELTA V3 pool)
//   node registries-replay.js v2 <chainId> <poolId>
//
// Read-only: runs the evaluator only. No transactions, no STATE writes.
// (The evaluator itself records the evaluation in memory.js, as every
// live watcher cycle does — same as goplus-replay.js / holders-replay.js.)
//
// V3 txHash recovery: the live runner's v3-STATE.json evaluated entries
// do not store txHash, so the PoolCreated tx is recovered from the V3
// factory logs (topics: token0/token1/fee), scanning backward in 10M
// block chunks. That is also how Pons attribution gets its receipt.
const cfg = require("./config.json");
const chains = require("./chains.js");
const v3mod = require("./v3.js");

async function findPoolCreatedTx(client, token0, token1, fee) {
  // One direct eth_getLogs call per 10M-block window (the Robinhood RPC
  // allows 10M-block topic-filtered queries — proven in the Pools.xyz
  // trace). Do NOT use rawGetLogsPaced here: it chunks at 5,000 blocks
  // with 400 ms pacing, so a 10M window would take ~13 minutes.
  const latest = Number(await client.getBlockNumber());
  // 12 windows x 10M blocks covers the whole Robinhood chain (~108M
  // blocks). DELTA's own PoolCreated sits ~84M blocks back (block
  // 24,555,353) — a 6-window scan missed it.
  for (let i = 0; i < 12; i++) {
    const to = latest - i * 10000000;
    const from = Math.max(0, to - 9999999); // inclusive range must stay <= 10,000,000 blocks
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
  const { evaluateV3Pool, readV3PoolState } = v3mod;
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const state = await readV3PoolState(client, poolAddress);
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
    if (txHash !== "0x" + "0".repeat(64)) {
      const rc = await client.getTransactionReceipt({ hash: txHash });
      blockNumber = Number(rc.blockNumber);
    }
  }
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
  // Paced fetch (holders.js): chains.rawGetLogs does not pace/retry and
  // the Robinhood RPC 429s bursts (known bug, fixed inside holders.js).
  const { fetchLogsPaced } = require("./holders.js");
  const logs = await fetchLogsPaced(client, {
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
  if (r.launchpad) console.log("launchpad: " + JSON.stringify(r.launchpad));
  if (r.pons) console.log("pons: " + JSON.stringify(r.pons));
  console.log("deployer: " + (r.deployer || "?") + " creatorContract: " + (r.creatorContract || "?"));
}

if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === "v3" && process.argv[3]) await replayV3(process.argv[3].toLowerCase());
    else if (cmd === "v2" && process.argv[3] && process.argv[4]) await replayV2(process.argv[3], process.argv[4].toLowerCase());
    else {
      console.log("usage: node registries-replay.js v3 <poolAddress> | node registries-replay.js v2 <chainId> <poolId>");
      console.log("  e.g. DELTA (Pons v1, V3): node registries-replay.js v3 0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94");
      process.exit(1);
    }
  })().catch((e) => { console.error("REPLAY ERROR:", e.message); process.exit(1); });
}

module.exports = { replayV3, replayV2 };
