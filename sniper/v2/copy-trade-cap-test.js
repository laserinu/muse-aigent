// copy-trade-cap-test.js — prove the copy-trader's cap of 5 blocks a 6th position.
// Composition test: verifyCandidate is stubbed to return a REAL debtdog
// verified object (built from live onchain data); the gates, cap check,
// buy build and fee logging all run for real. The receipt verification
// itself is proven separately on 3 real watchlist buys (MCAT, Debtcat,
// PUSSYCOIN). Dry-run only (live=false); state is in-memory, nothing
// is written to disk and no transaction is sent.
// Usage: node copy-trade-cap-test.js
const chains = require("./chains.js");
const ct = require("./copy-trade.js");
const runner = require("./copy-trade-run.js");
const { parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const ERC20_MIN = parseAbi(["function decimals() view returns (uint8)"]);

(async () => {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const latest = await client.getBlockNumber();
  const weth = chain.quotes.find((q) => q.symbol === "USDG");
  // FOBO (V4, USDG quote, fee 40000, no hook) — GoPlus-clean, 1,839
  // holders, and the sniper itself bought + sold it, so it passes the
  // gates. (debtdog was the first pick but its deployer holds 43.5%,
  // so the holders gate hard-fails it — correct behavior, wrong test token.)
  const token = "0x000de658153f47f23e92973c8eb1e89762703676";
  const poolId = "0x296aefc6d09d703ae59a511bd90a3917e272dd6df26783d3251b7b825fb55b4a";
  const poolKey = { poolId, currency0: token, currency1: weth.address, fee: 40000, tickSpacing: 400, hooks: "0x0000000000000000000000000000000000000000" };
  const poolBlock = 109000000;
  const dec = { blockNumber: poolBlock, txHash: "0x" + "00".repeat(32) };
  const decimals = 18;
  let deployer = "0xd7e538e98a208fd19e46bc549ff4710c33664e18"; // GoPlus creator for FOBO
  const verified = {
    ok: true, direction: "buy", netReceivedRaw: 1n,
    token, symbol: "FOBO", decimals, poolType: "v4",
    poolId, txHash: "0x" + "ab".repeat(32), wallet: "0xe1d160682d30b761402136333809d610a6507f57",
    poolKey,
    pool: { id: poolId, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks, currency0: poolKey.currency0, currency1: poolKey.currency1, txHash: dec.txHash },
    poolBlock, hooks: poolKey.hooks, deployer,
    quote: weth.address, quoteInfo: weth,
  };
  // Stub ONLY the receipt verification (proven separately); gates/cap/build run for real.
  const realVerify = ct.verifyCandidate;
  ct.verifyCandidate = async () => verified;

  const cand = { txHash: "0x" + "ab".repeat(32), wallet: "0xe1d160682d30b761402136333809d610a6507f57", token, symbol: "FOBO", amountUsd: 100, tokenAmount: 0, priceUsd: 0, makerBalanceAfter: 0, timestamp: 0, source: "cap-test" };
  const mkState = (nOpen) => ({
    live: false, cap: 5, copySnipesDone: 0, seenTxHashes: [], candidates: [],
    positions: Array.from({ length: nOpen }, (_, i) => ({ token: "0x" + "00".repeat(19) + String(i + 1).padStart(2, "0"), symbol: "DUMMY" + i, soldAll: false })),
    sells: [],
  });

  console.log("== TEST 1: 5 open positions -> expect cap-skip, NO buy ==");
  const st5 = mkState(5);
  const r5 = await runner.handleCandidate(client, st5, cand, false);
  console.log("outcome:", r5, "| positions still:", st5.positions.length, "| candidates recorded:", JSON.stringify(st5.candidates.map((c) => c.outcome)));

  console.log("== TEST 2: 4 open positions -> expect would-buy (real build, dry-run) ==");
  const st4 = mkState(4);
  const r4 = await runner.handleCandidate(client, st4, cand, false);
  console.log("outcome:", r4, "| positions still:", st4.positions.length, "| candidates recorded:", JSON.stringify(st4.candidates.map((c) => c.outcome)));

  ct.verifyCandidate = realVerify;
  console.log("cap test done. live gate still refuses (state.live=false):");
  try { ct.assertCopyLiveAllowed({ live: false }, {}); console.log("  LIVE GATE FAILURE — allowed!"); }
  catch (e) { console.log("  ", e.message.slice(0, 70)); }
})().catch((e) => { console.error("CAP ERR", e.message.slice(0, 300)); process.exit(1); });
