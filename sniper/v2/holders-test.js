// holders-test.js — tests for the holder-concentration + bundle check.
//
// Usage:
//   node holders-test.js
//   (the raised cap below lets the $MUSE/$RMUSE controls scan their full
//   history; live T+0 windows are tiny, so the default 100k cap in
//   holders.js never binds there. A bare run without the raised cap fails
//   the "$RMUSE complete data" check — that is why two independent re-runs
//   showed 37/38 while the builder's env-var run showed 38/38. Part 51:
//   the cap is now baked in so a bare invocation is the correct one.
//   Override with HOLDERS_RPC_MAX_BLOCKS=<n> if ever needed.)
//
// Sections:
//   A. Pure scoring (scoreFromData) — no network.
//   B. Bundle clustering (findBundleClusters) — no network.
//   C. Live RPC controls — $MUSE (Arc) + $RMUSE (Robinhood) via the
//      Transfer-log reconstruction. Read-only: no txs, no STATE writes.
//   D. Outage sims (child processes) — disabled flag, dead RPC, indexer
//      failure falling back to the RPC tier.
//
// Exit non-zero on any failure.
// Part 51: raise the RPC log-scan cap BEFORE requiring holders.js (it reads
// the env var at require time). 2M blocks covers the $RMUSE control (~910k
// blocks of history and growing) and $MUSE on Arc with headroom. An
// explicit caller-provided value is respected.
if (!process.env.HOLDERS_RPC_MAX_BLOCKS) process.env.HOLDERS_RPC_MAX_BLOCKS = "2000000";
const { execFileSync } = require("child_process");
const holders = require("./holders.js");
const chains = require("./chains.js");
const cfg = require("./config.json");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  check(name, got === want, `(got ${got}, want ${want})`);
}

// ---------- A. Pure scoring ----------
console.log("--- A. scoreFromData ---");
const base = { top1: 0.02, top10: 0.1, devShare: 0.01, bundleShare: 0.02, holderCount: 500, complete: true, source: "test" };
eq("clean token +5", holders.scoreFromData(base).points, 5);
eq("top1 20% -> -5", holders.scoreFromData({ ...base, top1: 0.2 }).points, -5);
eq("top1 8% -> -2", holders.scoreFromData({ ...base, top1: 0.08 }).points, -2);
eq("top10 45% -> -5", holders.scoreFromData({ ...base, top10: 0.45 }).points, -5);
eq("top10 30% -> -2", holders.scoreFromData({ ...base, top10: 0.3 }).points, -2);
eq("dev 8% -> -5", holders.scoreFromData({ ...base, devShare: 0.08 }).points, -5);
eq("dev 3% -> -2", holders.scoreFromData({ ...base, devShare: 0.03 }).points, -2);
eq("bundle 30% -> -5", holders.scoreFromData({ ...base, bundleShare: 0.3 }).points, -5);
eq("bundle 15% -> -2", holders.scoreFromData({ ...base, bundleShare: 0.15 }).points, -2);
eq("multiple negatives clamp at -10", holders.scoreFromData({ ...base, top1: 0.2, top10: 0.45, devShare: 0.08, bundleShare: 0.3 }).points, -10);
eq("$LAPTOP-style (top10 68.2% + bundle) -> -10", holders.scoreFromData({ ...base, top1: 0.2, top10: 0.682, devShare: 0.01, bundleShare: 0.25 }).points, -10);
eq("all nulls -> 0, no bonus", holders.scoreFromData({ top1: null, top10: null, devShare: null, bundleShare: null, holderCount: 0, complete: false, source: "test" }).points, 0);
eq("incomplete data -> no clean bonus", holders.scoreFromData({ ...base, complete: false }).points, 0);
eq("unknown dev share blocks bonus", holders.scoreFromData({ ...base, devShare: null }).points, 0);
eq("zero holders -> no bonus", holders.scoreFromData({ ...base, holderCount: 0 }).points, 0);

// ---------- B. Bundle clustering ----------
console.log("--- B. findBundleClusters ---");
const SUPPLY = 1000000n;
const bal = (m) => { const map = new Map(); for (const [a, v] of Object.entries(m)) map.set(a.toLowerCase(), BigInt(v)); return map; };
const excl = new Set(["0xpool"]);
const mk = (addr, block, amount) => ({ address: addr, block, amount: BigInt(amount) });
{
  // 4 wallets, same block, near-identical amounts -> one cluster, share = their balances.
  const fr = [mk("0xa1", 100, 1000), mk("0xa2", 100, 1010), mk("0xa3", 100, 990), mk("0xa4", 100, 1005)];
  const r = holders.findBundleClusters(fr, bal({ "0xa1": 1000, "0xa2": 1010, "0xa3": 990, "0xa4": 1005 }), SUPPLY, excl, "0xdeployer", 100);
  eq("4-wallet cluster found", r.clusters.length, 1);
  check("cluster share ~0.4%", Math.abs(r.share - 0.004005) < 0.0001, `(got ${r.share})`);
}
{
  // Amounts differing >10% -> no cluster.
  const fr = [mk("0xa1", 100, 1000), mk("0xa2", 100, 1200), mk("0xa3", 100, 1500)];
  const r = holders.findBundleClusters(fr, bal({ "0xa1": 1000, "0xa2": 1200, "0xa3": 1500 }), SUPPLY, excl, "0xdeployer", 100);
  eq("amounts differ >10% -> no cluster", r.clusters.length, 0);
}
{
  // Only 2 members -> no cluster.
  const fr = [mk("0xa1", 100, 1000), mk("0xa2", 100, 1000)];
  const r = holders.findBundleClusters(fr, bal({ "0xa1": 1000, "0xa2": 1000 }), SUPPLY, excl, "0xdeployer", 100);
  eq("2 members -> no cluster", r.clusters.length, 0);
}
{
  // Deployer excluded from clusters even with identical amounts.
  const fr = [mk("0xdeployer", 100, 1000), mk("0xa1", 100, 1000), mk("0xa2", 100, 1000)];
  const r = holders.findBundleClusters(fr, bal({ "0xdeployer": 1000, "0xa1": 1000, "0xa2": 1000 }), SUPPLY, excl, "0xdeployer", 100);
  eq("deployer excluded -> no cluster", r.clusters.length, 0);
}
{
  // First receipt 10 blocks after pool creation -> outside the window.
  const fr = [mk("0xa1", 110, 1000), mk("0xa2", 110, 1000), mk("0xa3", 110, 1000)];
  const r = holders.findBundleClusters(fr, bal({ "0xa1": 1000, "0xa2": 1000, "0xa3": 1000 }), SUPPLY, excl, "0xdeployer", 100);
  eq("late first receipts -> no cluster", r.clusters.length, 0);
}

// ---------- C. Live RPC controls ----------
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
async function poolCreationBlock(chainId, poolId, window = null) {
  const chain = { chainId, ...cfg.chains[String(chainId)] };
  const client = chains.makeClient(chain);
  const latest = await client.getBlockNumber();
  // Robinhood blocks run ~10/s (1,202 blocks in a 2-min watcher window),
  // so a 24h-old pool is ~864k blocks back — it needs a 1.2M window.
  // Arc is ~2/s, so 500k covers ~3 days. Paced so the Robinhood RPC's
  // 429 throttle is not tripped.
  const win = window !== null ? window : (chainId === 4663 ? 1200000 : 500000);
  const logs = await holders.fetchLogsPaced(client, {
    address: chain.poolManager,
    topics: [chains.INITIALIZE_TOPIC0, poolId],
    fromBlock: Number(latest - BigInt(win)), toBlock: Number(latest),
  });
  if (logs.length === 0) throw new Error("pool Initialize log not found");
  return { chain, client, block: Number(logs[0].blockNumber) };
}

(async () => {
  console.log("--- C. live RPC controls ---");
  // $RMUSE on Robinhood — the pool holds ~90% (must be excluded); the
  // agent wallet (deployer) holds ~8.8% and is the top non-contract holder.
  {
    const { chain, client, block } = await poolCreationBlock(4663, "0x7763e960970e50d5c7a4208fc3e0004055ea2b0fe47a944e10abdcc7e7be6fc1");
    const r = await holders.scoreHolders(chain, "0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36", {
      client, deployer: AGENT, poolBlock: block, excludeAddresses: [chain.poolManager],
      timeoutMs: 300000, // Part 51: old-pool reconstruction needs ~1.2M-block scans; the 12s default times out
    });
    console.log("  $RMUSE: " + r.detail);
    console.log("  $RMUSE raw: " + JSON.stringify(r.raw));
    check("$RMUSE source is rpc-logs", r.raw && r.raw.source === "rpc-logs");
    check("$RMUSE complete data", r.raw && r.raw.complete === true);
    check("$RMUSE pool 90% excluded (top1 < 15%)", r.raw && r.raw.top1 !== null && r.raw.top1 < 0.15, `(top1=${r.raw && r.raw.top1})`);
    check("$RMUSE top1 is the agent wallet ~8.8%", r.raw && r.raw.top1 > 0.05 && r.raw.top1 < 0.15, `(top1=${r.raw && r.raw.top1})`);
    // Dev share = the agent EOA's own balance PLUS any deployer-owned
    // contracts (the RMUSE factory holds 1T and its owner() is the agent).
    check("$RMUSE dev share = agent EOA + deployer-owned contracts", r.raw && r.raw.devShare !== null && Math.abs(r.raw.devShare - r.raw.top1 - (r.raw.devControlled || []).reduce((s, c) => s + c.share, 0)) < 0.001, `(dev=${r.raw && r.raw.devShare}, top1=${r.raw && r.raw.top1}, controlled=${JSON.stringify(r.raw && r.raw.devControlled)})`);
    check("$RMUSE owner-check caught the deployer factory (1T)", r.raw && (r.raw.devControlled || []).some((c) => c.address === "0x2b2a411cf14d2d63395f2950333342cb3135926b" && Math.abs(c.share - 0.01) < 0.001));
    check("$RMUSE scores negative (concentrated by design)", r.points < 0, `(points=${r.points})`);
  }
  // $MUSE on Arc — agent ~1.1%, airdrop spread over 1,850 EOAs. The
  // deployer factory holds ~95T; whether the owner-check catches it is
  // printed (not hard-asserted — it depends on the factory's owner()).
  {
    const { chain, client, block } = await poolCreationBlock(5042, "0x5a14e63c9943a180d24b31f45964bc11e24639e9f055f88f33a3ac58b6b27ff1");
    const r = await holders.scoreHolders(chain, "0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198", {
      client, deployer: AGENT, poolBlock: block, excludeAddresses: [chain.poolManager],
      timeoutMs: 300000, // Part 51: same as $RMUSE — old-pool scan, 12s default times out
    });
    console.log("  $MUSE: " + r.detail);
    console.log("  $MUSE raw: " + JSON.stringify(r.raw));
    check("$MUSE source is rpc-logs", r.raw && r.raw.source === "rpc-logs");
    check("$MUSE pool excluded (top1 < 5%)", r.raw && r.raw.top1 !== null && r.raw.top1 < 0.05, `(top1=${r.raw && r.raw.top1})`);
    check("$MUSE airdrop bundle under the 10% line", r.raw && r.raw.bundleShare !== null && r.raw.bundleShare < 0.1, `(bundle=${r.raw && r.raw.bundleShare})`);
    console.log(`  $MUSE devShare=${r.raw && r.raw.devShare} devControlled=${JSON.stringify(r.raw && r.raw.devControlled)} points=${r.points}`);
  }
  // Indexer failure falls back to the RPC tier: dummy key + dead base URL
  // on a FRESH pool (APU, Robinhood — tiny window, fast).
  // Window 300k (was 100k): APU's pool is now ~6h old (~210k blocks back
  // at ~10 blocks/s), so the 100k window no longer reaches its creation
  // block and poolCreationBlock threw "pool Initialize log not found"
  // (2026-11-08 ~10:55 WIB). 300k still keeps the scan fast.
  // timeoutMs 120000 (was the 12s default): APU's pool is now ~210k
  // blocks back, and the Transfer-log reconstruction over that range
  // exceeds 12s — the control timed out (fail-open) on 2026-11-08 ~11:05 WIB.
  {
    const { chain, client, block } = await poolCreationBlock(4663, "0x4070354baee808ec2b0953ef4b96841a013fb2b209c9185d9240d80f3f8c716c", 300000);
    const r = await holders.scoreHolders(chain, "0x712cc5141a1d10109fee62e8d61e175fe5ef96bf", {
      client, deployer: null, poolBlock: block, excludeAddresses: [chain.poolManager],
      timeoutMs: 120000,
    });
    console.log("  APU (no key, RPC tier): " + r.detail);
    check("APU scores via rpc-logs without a key", r.raw && r.raw.source === "rpc-logs");
  }

  // ---------- D. Outage sims (child processes) ----------
  console.log("--- D. outage sims ---");
  const runChild = (envExtra, code, timeoutMs) =>
    execFileSync(process.execPath, ["-e", code], {
      env: { ...process.env, ...envExtra },
      encoding: "utf8",
      timeout: timeoutMs || 180000, // 180s cap: the fallback child now scans ~210k blocks (APU pool aged) and needs >60s
    });
  {
    const out = runChild({ HOLDERS_ENABLED: "0" }, `
      const h = require("/home/hatch/workspace/tokens/sniper/v2/holders.js");
      h.scoreHolders({ chainId: 4663, poolManager: "0x0" }, "0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36", {}).then((r) => { console.log(JSON.stringify(r)); process.exit(0); });
    `);
    const r = JSON.parse(out.trim().split("\n").pop());
    eq("HOLDERS_ENABLED=0 -> 0 points", r.points, 0);
    check("disabled detail mentions disabled", /disabled/.test(r.detail));
  }
  {
    const out = runChild({}, `
      const h = require("/home/hatch/workspace/tokens/sniper/v2/holders.js");
      const { createPublicClient, http } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
      const client = createPublicClient({ transport: http("http://127.0.0.1:9") });
      h.scoreHolders({ chainId: 4663, poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" }, "0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36", { client, poolBlock: 108700000 }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); });
    `);
    const r = JSON.parse(out.trim().split("\n").pop());
    eq("dead RPC -> 0 points, no throw", r.points, 0);
    check("dead RPC detail is fail-open", /fail-open/.test(r.detail));
  }
  {
    // Dummy Blockscout key + dead base URL -> indexer fails, RPC tier serves.
    const out = runChild(
      { BLOCKSCOUT_API_KEY: "dummy-key-for-test", BLOCKSCOUT_BASE_URL: "http://127.0.0.1:9", HOLDERS_RPC_MAX_BLOCKS: "1000000" },
      `
      const h = require("/home/hatch/workspace/tokens/sniper/v2/holders.js");
      const chains = require("/home/hatch/workspace/tokens/sniper/v2/chains.js");
      const cfg = require("/home/hatch/workspace/tokens/sniper/v2/config.json");
      (async () => {
        const chain = { chainId: 4663, ...cfg.chains["4663"] };
        const client = chains.makeClient(chain);
        const latest = await client.getBlockNumber();
        const logs = await h.fetchLogsPaced(client, { address: chain.poolManager, topics: [chains.INITIALIZE_TOPIC0, "0x4070354baee808ec2b0953ef4b96841a013fb2b209c9185d9240d80f3f8c716c"], fromBlock: Number(latest - 300000n), toBlock: Number(latest) });
        const block = Number(logs[0].blockNumber);
        const r = await h.scoreHolders(chain, "0x712cc5141a1d10109fee62e8d61e175fe5ef96bf", { client, poolBlock: block, excludeAddresses: [chain.poolManager], timeoutMs: 120000 });
        console.log(JSON.stringify(r));
        process.exit(0);
      })();
    `,
    );
    const r = JSON.parse(out.trim().split("\n").pop());
    check("dead indexer falls back to rpc-logs", r.raw && r.raw.source === "rpc-logs", `(source=${r.raw && r.raw.source})`);
    check("fallback noted in detail", /blockscout indexer failed/.test(r.detail));
  }

  console.log(`\n=== holders-test: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
