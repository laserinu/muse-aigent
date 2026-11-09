// v3-run.js — V3 dry-run watcher (Robinhood Chain only, DRY-RUN ONLY).
//
// Scans the Robinhood V3 factory for new PoolCreated events, evaluates each
// pool with the v2 legit checks adapted for V3 (v3.js), and reports what
// WOULD have been bought at threshold 45. Sends ZERO transactions, touches
// NO live state: it reads config.json (quotes/thresholds only) and writes
// ONLY v3-STATE-DRYRUN.json + v3-DRYRUN-LOG.md in this directory.
// NEVER import trade.js here — there is no execution path in this file.
//
// Usage:
//   node v3-run.js                          # dry-run, last 50,000 blocks
//   node v3-run.js --window-blocks 5000    # dry-run, last 5,000 blocks
//   node v3-run.js --from-block 108611601 --to-block 108661601
//   node v3-run.js --control-delta         # also evaluate DELTA's V3 pool
//                                            (default: control runs always)

const fs = require("fs");
const path = require("path");
const chains = require("./chains.js");
const v3 = require("./v3.js");

const DIR = "/home/hatch/workspace/tokens/sniper/v2";
const STATE_PATH = path.join(DIR, "v3-STATE-DRYRUN.json");
const LOG_PATH = path.join(DIR, "v3-DRYRUN-LOG.md");
const MAX_EVALS_PER_RUN = 30;

const DELTA_TOKEN = "0xe8ffd7e24187f72afb08d75b1bb13088a989a791";
const DELTA_POOL = "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94";
const WETH_RH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  return { version: 1, poolType: "V3", chainId: 4663, lastScannedBlock: null, evaluated: [], wouldBuys: [] };
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

function parseArgs() {
  const args = { windowBlocks: 50000, fromBlock: null, toBlock: null, controlDelta: true };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--window-blocks" && process.argv[i + 1]) args.windowBlocks = Number(process.argv[++i]);
    else if (a.startsWith("--window-blocks=")) args.windowBlocks = Number(a.slice(16));
    else if (a === "--from-block" && process.argv[i + 1]) args.fromBlock = Number(process.argv[++i]);
    else if (a === "--to-block" && process.argv[i + 1]) args.toBlock = Number(process.argv[++i]);
    else if (a === "--no-control-delta") args.controlDelta = false;
  }
  return args;
}

function verdictLine(chainName, res) {
  const sym = res.symbol || res.token?.slice(0, 10) || "?";
  const scoreLine = (res.scores || []).map((s) => `${s.component}:${s.points}`).join(" ");
  if (res.verdict === "SKIP") return `[${chainName}] SKIP ${sym} ${res.token} pool ${res.poolAddress} — ${res.reason}`;
  if (res.size === "watch") return `[${chainName}] WATCH ${sym} ${res.token} pool ${res.poolAddress} — score ${res.score}/100 (${scoreLine}) — below threshold, no buy`;
  return `[${chainName}] would BUY ${sym} ${res.token} pool ${res.poolAddress} — score ${res.score}/100 size ${res.size} (${scoreLine}) — DRY-RUN, no tx sent`;
}

async function main() {
  const cfg = chains.loadConfig();
  const args = parseArgs();
  const state = loadState();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const latest = Number(await client.getBlockNumber());
  const toBlock = args.toBlock || latest;
  const fromBlock = args.fromBlock || Math.max(0, toBlock - args.windowBlocks);
  log(`=== v3 dry-run start (Robinhood only, blocks ${fromBlock}..${toBlock}, DRY-RUN — 0 txs) ===`);

  let pools;
  try {
    pools = await v3.scanV3Pools(chain, fromBlock, toBlock);
  } catch (e) {
    log(`[Robinhood] ERROR scanning PoolCreated events: ${e.message.slice(0, 200)}`);
    return;
  }
  log(`[Robinhood] scanned blocks ${fromBlock}..${toBlock}: ${pools.length} new V3 pool(s)`);
  state.lastScannedBlock = toBlock;

  const summary = { found: pools.length, evaluated: 0, skipped: 0, watch: 0, wouldBuys: 0, pons: 0 };
  const toEval = pools.slice(0, MAX_EVALS_PER_RUN);
  if (pools.length > toEval.length) log(`[Robinhood] ${pools.length - toEval.length} pool(s) left unevaluated (cap ${MAX_EVALS_PER_RUN})`);
  for (const pool of toEval) {
    let res;
    try {
      res = await v3.evaluateV3Pool(cfg, chain, pool);
    } catch (e) {
      log(`[Robinhood] ${pool.pool} EVALUATOR ERROR: ${e.message.slice(0, 200)}`);
      continue;
    }
    summary.evaluated++;
    if (res.pons && res.pons.pons) summary.pons++;
    if (res.verdict === "SKIP") summary.skipped++;
    else if (res.size === "watch") summary.watch++;
    else summary.wouldBuys++;
    log(verdictLine(chain.name, res));
    if (res.pons) log(`[Robinhood]   attribution: ${res.pons.evidence}`);
    state.evaluated.push({ pool: pool.pool, token: res.token, symbol: res.symbol, score: res.score, size: res.size, verdict: res.verdict, reason: res.reason, pons: !!(res.pons && res.pons.pons), blockNumber: pool.blockNumber, txHash: pool.txHash });
    if (res.verdict === "PASS" && res.size !== "watch") state.wouldBuys.push({ pool: pool.pool, token: res.token, symbol: res.symbol, score: res.score, size: res.size });
  }

  // DELTA control: evaluate DELTA's V3 pool via factory.getPool (it was
  // created ~2026-08-02, long before any scan window). Attribution uses
  // the PoolCreated tx found by the creation-tx search when available;
  // otherwise the control reports the pool + score with attribution
  // marked unproven (the pool itself is verified live via getPool/slot0).
  if (args.controlDelta) {
    log(`--- DELTA control ---`);
    try {
      const poolAddr = await client.readContract({ address: v3.V3_FACTORY_RH, abi: v3.V3_FACTORY_ABI, functionName: "getPool", args: [DELTA_TOKEN, WETH_RH, 10000] });
      log(`[control] DELTA V3 pool via factory.getPool(DELTA, WETH, 10000): ${poolAddr} (expected 0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94)`);
      const st = await v3.readV3PoolState(client, poolAddr);
      log(`[control] DELTA pool state: fee ${st.fee}, tick ${st.tick}, liquidity ${st.liquidity.toString()}, unlocked ${st.unlocked}`);
      // Creation tx proven by binary-search + PoolCreated log lookup
      // 2026-11-08: block 24555353, tx to the Pons v1 factory.
      const pool = { token0: st.token0, token1: st.token1, fee: st.fee, tickSpacing: st.tickSpacing, pool: poolAddr.toLowerCase(), blockNumber: 24555353, txHash: "0x301f5b492bdf3f985f7f0d37d1616b07df53f8325f03407be7805412be598e87", logIndex: 0 };
      const res = await v3.evaluateV3Pool(cfg, chain, pool);
      log(`[control] ` + verdictLine(chain.name, res));
      if (res.pons) log(`[control]   attribution: ${res.pons.evidence}`);
      state.evaluated.push({ pool: poolAddr.toLowerCase(), token: res.token, symbol: res.symbol, score: res.score, size: res.size, verdict: res.verdict, reason: res.reason, pons: !!(res.pons && res.pons.pons), control: "DELTA" });
      if (res.verdict === "PASS" && res.size !== "watch") state.wouldBuys.push({ pool: poolAddr.toLowerCase(), token: res.token, symbol: res.symbol, score: res.score, size: res.size, control: "DELTA" });
    } catch (e) {
      log(`[control] DELTA control FAILED: ${e.message.slice(0, 200)}`);
    }
  }

  log(`=== v3 dry-run end: found ${summary.found}, evaluated ${summary.evaluated}, skipped ${summary.skipped}, watch ${summary.watch}, would-buy ${summary.wouldBuys}, Pons-attributed ${summary.pons} ===`);
  saveState(state);
}

main().catch((e) => { console.error("V3 RUNNER ERROR:", e); process.exit(1); });
