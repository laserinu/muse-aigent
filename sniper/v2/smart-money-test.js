// smart-money-test.js — tests for smart-money.js (read-only, no transactions).
//
// Usage:
//   node smart-money-test.js
//
// Test 1 — watchlist: loads 8 wallets, valid lowercase addresses, #1
//   present with its deployer-adjacent flag (kept, guarded per-token).
// Test 2 — synthetic: scoreFromBuys mapping (points, decay, hold guard,
//   deployer exclusion) — no network.
// Test 3 — stubbed client: scoreSmartMoney against a fake viem client +
//   a monkey-patched chains.rawGetLogs — V4 + V3 detection, hold guard,
//   deployer exclusion, fail-open on RPC error, disabled via config.
// Test 4 — env escape: SMART_MONEY_ENABLED=0 in a child process returns
//   0 points and never throws.
// Test 5 — batched tx fetching + both-ends sampling: a local stub RPC
//   answers batched eth_getTransactionByHash; a 404-log busy pool whose
//   watchlisted buy is the OLDEST log must still be detected (Debtcat
//   pattern — a newest-only cap drops exactly the birth buy).
// Live replay (PUSSYCOIN / MCAT / Debtcat on Robinhood) is separate:
//   node smart-money-replay.js
const { scoreSmartMoney, scoreFromBuys, loadWatchlist, reloadWatchlist } = require("./smart-money.js");
const chains = require("./chains.js");

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log((ok ? "  PASS" : "  FAIL") + " " + name + " — got " + got + ", want " + want);
}

const NOW = Date.now();
const H = 3600000;
const W1 = "0xc5606cde16fb8c39cc68d1d97700883ae951ff56";
const W2 = "0xc77b5585ca3cd4beec6051cca89921a2f01d9a5c";
const W3 = "0xe1d160682d30b761402136333809d610a6507f57";

function watchlistTests() {
  console.log("== Test 1: watchlist loads ==");
  const wl = reloadWatchlist();
  check("8 wallets", wl.wallets.length, 8);
  check("all addresses lowercase 0x + 40 hex",
    wl.wallets.every((w) => /^0x[0-9a-f]{40}$/.test(w.address)) ? 1 : 0, 1);
  check("ranks 1-8 unique",
    new Set(wl.wallets.map((w) => w.rank)).size, 8);
  const w1 = wl.byAddress.get(W1.toLowerCase());
  check("#1 present, rank 1", w1 && w1.rank, 1);
  check("#1 deployer-adjacent flag recorded",
    w1 && w1.flags.some((f) => f.includes("created 11 tokens")) ? 1 : 0, 1);
  check("#1 still included (kept, guarded per-token)",
    w1 ? 1 : 0, 1);
  check("rankedAt 2026-11-09", wl.rankedAt, "2026-11-09");
}

function syntheticTests() {
  console.log("== Test 2: synthetic scoreFromBuys mapping ==");
  const buy = (wallet, ageH, stillHolds = true, isDeployer = false) => ({
    wallet, boughtAtMs: NOW - ageH * H, stillHolds, isDeployer,
  });

  check("no buys -> 0", scoreFromBuys([], NOW).points, 0);
  check("1 fresh holding -> 10", scoreFromBuys([buy(W1, 1)], NOW).points, 10);
  check("2 fresh holding -> 15", scoreFromBuys([buy(W1, 1), buy(W2, 2)], NOW).points, 15);
  check("3 fresh holding -> 15 (cap)", scoreFromBuys([buy(W1, 1), buy(W2, 2), buy(W3, 3)], NOW).points, 15);
  check("1 fresh + 1 half -> 15", scoreFromBuys([buy(W1, 1), buy(W2, 30)], NOW).points, 15);
  check("1 half (30h) -> 5", scoreFromBuys([buy(W1, 30)], NOW).points, 5);
  check("2 half -> 10", scoreFromBuys([buy(W1, 30), buy(W2, 40)], NOW).points, 10);
  check("1 fresh + 2 half -> 15 (cap)", scoreFromBuys([buy(W1, 1), buy(W2, 30), buy(W3, 40)], NOW).points, 15);
  check("buy 50h old -> 0", scoreFromBuys([buy(W1, 50)], NOW).points, 0);
  check("buy 23h old -> 10 (still full)", scoreFromBuys([buy(W1, 23)], NOW).points, 10);
  check("buy 25h old -> 5 (half)", scoreFromBuys([buy(W1, 25)], NOW).points, 5);
  check("fresh but sold out -> 0 (hold guard)", scoreFromBuys([buy(W1, 1, false)], NOW).points, 0);
  check("fresh but is deployer -> 0", scoreFromBuys([buy(W1, 1, true, true)], NOW).points, 0);
  check("future timestamp -> 0 (clock skew)", scoreFromBuys([{ wallet: W1, boughtAtMs: NOW + H, stillHolds: true }], NOW).points, 0);
  check("same wallet fresh + half -> 10 (counted once, freshest wins)",
    scoreFromBuys([buy(W1, 1), buy(W1, 30)], NOW).points, 10);
  check("unknown wallet counts if passed in (caller filters by watchlist)",
    scoreFromBuys([buy("0x0000000000000000000000000000000000000001", 1)], NOW).points, 10);
  const r = scoreFromBuys([buy(W1, 1), buy(W2, 30)], NOW);
  check("buyers listed with buckets", r.buyers.length, 2);
  check("nFull=1 nHalf=1", r.nFull + "/" + r.nHalf, "1/1");
}

// Fake viem client for the stubbed tests. `scenario` controls what the
// chain returns: { txFrom, balance, blockTsOffsetMs, throwOn }.
function fakeClient(scenario) {
  return {
    getBlockNumber: async () => {
      if (scenario.throwOn === "getBlockNumber") throw new Error("boom");
      return 109600000n;
    },
    getBlock: async () => {
      if (scenario.throwOn === "getBlock") throw new Error("boom");
      return { timestamp: BigInt(Math.floor((Date.now() - (scenario.blockTsOffsetMs ?? H)) / 1000)) };
    },
    getTransaction: async () => {
      if (scenario.throwOn === "getTransaction") throw new Error("boom");
      return { from: scenario.txFrom };
    },
    readContract: async () => {
      if (scenario.throwOn === "readContract") throw new Error("boom");
      return BigInt(scenario.balance ?? 0);
    },
  };
}

async function stubbedTests() {
  console.log("== Test 3: stubbed-client scoreSmartMoney ==");
  const chain = { chainId: 4663, name: "Robinhood", poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" };
  const token = "0x81a4d02e6e1ca42c0c96e16defee145cfadcec20"; // MCAT
  const origRawGetLogs = chains.rawGetLogs;
  const stubLogs = (logs) => {
    chains.rawGetLogs = async () => logs;
  };
  const restore = () => { chains.rawGetLogs = origRawGetLogs; };

  try {
    // V4: one Swap log, tx from W1, W1 still holds, fresh -> +10.
    stubLogs([{ transactionHash: "0xaaa", blockNumber: 109599999n }]);
    let r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("V4 watchlisted buy + still holds -> 10", r.points, 10);
    check("V4 buyer recorded", r.buyers.length, 1);

    // V4: same buy, but the wallet sold out -> 0 (hold guard).
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 0n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("V4 buy but sold out -> 0 (hold guard)", r.points, 0);
    check("V4 sold-out buy still detected in buys[]", r.buys.length, 1);
    check("V4 sold-out buy stillHolds=false", r.buys[0].stillHolds, false);

    // V4: tx from a non-watchlisted wallet -> 0.
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: "0x0000000000000000000000000000000000000001", balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("V4 non-watchlisted buyer -> 0", r.points, 0);

    // V4: tx from W1 but W1 IS the deployer -> 0 (deployer exclusion).
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, deployer: W1.toLowerCase(), cfg: {},
    });
    check("V4 watchlisted buyer is deployer -> 0", r.points, 0);

    // V4: tx from W1 but W1 IS the GoPlus creator -> 0.
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, creator: W1.toLowerCase(), cfg: {},
    });
    check("V4 watchlisted buyer is creator -> 0", r.points, 0);

    // V4: two watchlisted buyers in two txs -> 15.
    stubLogs([
      { transactionHash: "0xaaa", blockNumber: 109599999n },
      { transactionHash: "0xbbb", blockNumber: 109599998n },
    ]);
    const twoTxClient = fakeClient({ txFrom: W1, balance: 1000n });
    twoTxClient.getTransaction = async ({ hash }) => ({
      from: hash === "0xaaa" ? W1 : W2,
    });
    r = await scoreSmartMoney(chain, {
      client: twoTxClient,
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("V4 two watchlisted buyers -> 15", r.points, 15);

    // V4: buy 30h old -> 5 (half decay).
    stubLogs([{ transactionHash: "0xaaa", blockNumber: 109599999n }]);
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n, blockTsOffsetMs: 30 * H }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("V4 buy 30h old -> 5 (half decay)", r.points, 5);

    // V4: no Swap events at all -> 0.
    stubLogs([]);
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("V4 no Swap events -> 0", r.points, 0);

    // V3: one Swap log on the pool contract, tx from W1, holds -> +10.
    stubLogs([{ transactionHash: "0xaaa", blockNumber: 109599999n }]);
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolAddress: "0x62ab521f71431f78ac374cdbadc6cda3c8916b6c",
      token: "0x2e0885d48cb931ca4bbcaad84332e028dd741e18",
      poolBlock: 109599000, cfg: {},
    });
    check("V3 watchlisted buy + still holds -> 10", r.points, 10);

    // Fail-open: RPC throws on getBlockNumber -> 0, no throw.
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ throwOn: "getBlockNumber" }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("RPC error -> 0 fail-open", r.points, 0);

    // Fail-open: rawGetLogs throws -> 0, no throw.
    chains.rawGetLogs = async () => { throw new Error("eth_getLogs HTTP 429"); };
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: {},
    });
    check("eth_getLogs 429 -> 0 fail-open", r.points, 0);

    // Missing poolBlock -> 0 (cannot scan).
    stubLogs([{ transactionHash: "0xaaa", blockNumber: 109599999n }]);
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 0, cfg: {},
    });
    check("no poolBlock -> 0", r.points, 0);

    // Disabled via config -> 0.
    r = await scoreSmartMoney(chain, {
      client: fakeClient({ txFrom: W1, balance: 1000n }),
      poolId: "0xddca8f9b0199cbd7915912f2f715c535fb14cb8722d7688b9a0f7125d3134de6",
      token, poolBlock: 109599000, cfg: { smartMoney: { enabled: false } },
    });
    check("config disabled -> 0", r.points, 0);
  } finally {
    restore();
  }
}

async function envEscapeTest() {
  console.log("== Test 4: env escape SMART_MONEY_ENABLED=0 ==");
  const { spawnSync } = require("child_process");
  const out = spawnSync(
    process.execPath,
    ["-e", "const {scoreSmartMoney}=require('./smart-money.js'); const c={getBlockNumber:async()=>{throw new Error('must not be called')}}; scoreSmartMoney({chainId:4663,poolManager:'0x0'}, {client:c, poolId:'0x00', token:'0x81a4d02e6e1ca42c0c96e16defee145cfadcec20', poolBlock:1, cfg:{}}).then(r=>console.log('points='+r.points+' detail='+r.detail)).catch(e=>{console.error('THREW: '+e.message); process.exit(2)})"],
    {
      cwd: __dirname,
      env: { ...process.env, SMART_MONEY_ENABLED: "0" },
      encoding: "utf8", timeout: 20000,
    },
  );
  console.log("  stdout: " + (out.stdout || "").trim());
  if (out.stderr) console.log("  stderr: " + out.stderr.trim());
  check("env disabled returns 0, exit 0, no throw",
    out.status === 0 && (out.stdout || "").includes("points=0") ? 0 : 1, 0);
}

// Test 5 — batched tx fetching + both-ends sampling on a busy pool.
// A local stub RPC answers batched eth_getTransactionByHash. The pool has
// 404 Swap logs; the watchlisted buy is the OLDEST (minute 0, the Debtcat
// pattern). With a newest-only cap it would be dropped; both-ends sampling
// + batching must find it.
async function batchAndSamplingTest() {
  console.log("== Test 5: batched fetch + both-ends sampling (busy pool) ==");
  const http = require("http");
  const { fetchTxSenders } = require("./smart-money.js");
  const chain = { chainId: 4663, name: "Robinhood", poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" };
  const token = "0x1938c8ec9373c8c0e1e289668fc838c47fcd3f22"; // Debtcat

  // 404 logs, newest first (block 109604339 down to 109603936). The OLDEST
  // log is #4's buy tx; the other 403 are random non-watchlisted txs.
  const logs = [];
  for (let i = 0; i < 404; i++) {
    const blockNumber = 109604339 - i;
    const txHash = i === 403
      ? "0xe0b27b6cf03998ba54b17e0f1bbb39ade6628613036cec29fd34855fca66e338"
      : "0x" + String(i).padStart(64, "0");
    logs.push({ transactionHash: txHash, blockNumber, logIndex: 0 });
  }

  // Stub RPC: batched eth_getTransactionByHash only; everything else 404s.
  // The batch path is exercised because the client HAS a transport.url.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const batch = JSON.parse(body);
      const out = batch.map((q) => ({
        jsonrpc: "2.0",
        id: q.id,
        result: {
          hash: q.params[0],
          from: q.params[0] === "0xe0b27b6cf03998ba54b17e0f1bbb39ade6628613036cec29fd34855fca66e338"
            ? W3
            : "0x0000000000000000000000000000000000000001",
        },
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    // fetchTxSenders directly: 59 newest hashes + #4's birth-buy tx
    // (the oldest log, index 403 — outside the first 60), across 2
    // batches of 50/10.
    const hashes = [
      ...logs.slice(0, 59).map((l) => l.transactionHash),
      "0xe0b27b6cf03998ba54b17e0f1bbb39ade6628613036cec29fd34855fca66e338",
    ];
    const senders = await fetchTxSenders(
      { transport: { url: `http://127.0.0.1:${port}` } },
      hashes,
      50,
    );
    check("batched fetch returns all 60 senders", senders.size, 60);
    check("batched fetch maps #4 buy tx to W3",
      senders.get("0xe0b27b6cf03998ba54b17e0f1bbb39ade6628613036cec29fd34855fca66e338"), W3.toLowerCase());

    // Full scoreSmartMoney path: client with transport.url (batch) +
    // getBlock/getBlockNumber/readContract stubs. The oldest buy must be
    // found despite 404 logs; #4 sold Debtcat, so points stay 0 but the
    // buy must appear in buys[] with stillHolds=false.
    const origRawGetLogs = chains.rawGetLogs;
    chains.rawGetLogs = async () => logs;
    try {
      const client = {
        transport: { url: `http://127.0.0.1:${port}` },
        getBlockNumber: async () => 109604340n,
        getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - H) }),
        getTransaction: async () => { throw new Error("batch path must be used, not sequential"); },
        readContract: async () => 0n, // #4 sold Debtcat
      };
      const r = await scoreSmartMoney(chain, {
        client,
        poolId: "0xf1c11369d9f53fa9188dcd492577111f270edbf9e232073349e2404146ffac4d",
        token, poolBlock: 109603936,
        // Small caps force the both-ends sampling path: 10 newest + 10
        // oldest of the 404 logs. The oldest 10 include #4's birth buy.
        cfg: { smartMoney: { maxSwapLogs: 20, maxTxFetches: 20, txBatchSize: 50 } },
      });
      check("busy pool: oldest (birth) buy detected", r.buys.length >= 1 ? 1 : 0, 1);
      check("busy pool: birth buy is #4", r.buys.length && r.buys[0].wallet, W3.toLowerCase());
      check("busy pool: #4 sold -> 0 points (hold guard)", r.points, 0);
    } finally {
      chains.rawGetLogs = origRawGetLogs;
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  watchlistTests();
  syntheticTests();
  await stubbedTests();
  await envEscapeTest();
  await batchAndSamplingTest();
  console.log(failures === 0 ? "=== ALL SMART-MONEY TESTS PASSED ===" : `=== ${failures} SMART-MONEY TEST(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST HARNESS ERROR:", e.message); process.exit(1); });
