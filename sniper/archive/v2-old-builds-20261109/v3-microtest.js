// v3-microtest.js — LIVE micro-test of the V3 execution path (Robinhood).
//
// User-approved 2026-11-08 ~03:04 WIB ("Yes, build the V3 execution
// path + micro-test"). Buys a TINY amount of DELTA (0.00001 ETH, the
// normal sniper buy size — NEVER more) through the V3 pool via Universal
// Router command 0x00, then sells it back through the same path.
// This proves the buy AND sell directions of buildV3Buy/buildV3Sell.
//
// Safety: ONE attempt per leg. On any revert, STOP immediately — no
// automatic retry. A failed leg is a result, not a reason to try again
// with different params (at most one manual retry is allowed, by a human
// decision, after reading the revert).
//
// Usage: node v3-microtest.js
// Writes: v3-MICROTEST-20261108-0305.json (results; NOT live state).

const fs = require("fs");
const { parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const v3 = require("./v3.js");
const trade = require("./trade.js");
const v3trade = require("./v3-trade.js");

const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DELTA = "0xe8ffd7e24187f72afb08d75b1bb13088a989a791";
const DELTA_POOL = "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94";
const AMOUNT_IN = 10n ** 13n; // 0.00001 WETH — normal sniper buy size, NEVER more
const MIN_ETH_WEI = 50000000000000n; // 0.00005 ETH floor (wrap + 7 txs gas)

const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function balances(client) {
  const [eth, weth, delta] = await Promise.all([
    client.getBalance({ address: AGENT }),
    client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] }),
    client.readContract({ address: DELTA, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] }),
  ]);
  return { eth: eth.toString(), weth: weth.toString(), delta: delta.toString() };
}

async function main() {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const quote = chain.quotes.find((q) => q.address.toLowerCase() === WETH.toLowerCase());
  const results = { startedAt: new Date().toISOString(), token: "DELTA", pool: DELTA_POOL, amountInWei: AMOUNT_IN.toString(), legs: {} };

  console.log("=== V3 MICRO-TEST (LIVE) — DELTA buy + sell, 0.00001 ETH ===");
  const before = await balances(client);
  console.log("balances BEFORE:", JSON.stringify(before));
  results.balancesBefore = before;
  if (BigInt(before.eth) < MIN_ETH_WEI) throw new Error(`ABORT: agent ETH ${before.eth} below the 0.00005 floor — not enough for wrap + gas`);

  const st = await v3.readV3PoolState(client, DELTA_POOL);
  console.log(`pool: fee ${st.fee} tick ${st.tick} liquidity ${st.liquidity} unlocked ${st.unlocked}`);
  results.poolState = { fee: st.fee, tick: st.tick, liquidity: st.liquidity.toString(), sqrtPriceX96: st.sqrtPriceX96.toString() };
  const spotNum = v3.v3PriceFromSqrt(st.sqrtPriceX96, 18, 18);
  console.log(`spot (Number cross-check): ${spotNum} DELTA per WETH`);

  // ---- LEG 1: BUY ----
  console.log("\n--- LEG 1: BUY 0.00001 WETH -> DELTA (slippage 1%) ---");
  const buy = await v3trade.buildV3Buy(cfg, chain, DELTA_POOL, DELTA, 18, quote, { amountIn: AMOUNT_IN, slippageBps: 100 });
  console.log(`buy: amountIn ${buy.amountIn} spotOut ${buy.spotOut} minOut ${buy.amountOutMinimum} (spot x 0.99)`);
  results.legs.buy = { amountIn: buy.amountIn, spotOut: buy.spotOut, amountOutMinimum: buy.amountOutMinimum };
  const buyReceipts = await trade.executeTxs(cfg, chain, buy.txs, { liveConfirm: true });
  for (const r of buyReceipts) console.log(`  ${r.label}: ${r.hash} block ${r.block} gas ${r.gasUsed}`);
  results.legs.buy.txs = buyReceipts;
  const afterBuy = await balances(client);
  console.log("balances AFTER BUY:", JSON.stringify(afterBuy));
  results.balancesAfterBuy = afterBuy;
  const deltaReceived = BigInt(afterBuy.delta) - BigInt(before.delta);
  console.log(`DELTA received: ${deltaReceived} raw (${Number(deltaReceived) / 1e18} DELTA)`);
  results.legs.buy.deltaReceived = deltaReceived.toString();
  if (deltaReceived <= 0n) throw new Error("BUY produced 0 DELTA — path did not deliver tokens");

  // ---- LEG 2: SELL (close the loop) ----
  console.log("\n--- LEG 2: SELL all received DELTA -> WETH (slippage 1%) ---");
  const sell = await v3trade.buildV3Sell(cfg, chain, DELTA_POOL, DELTA, 18, quote, deltaReceived, { slippageBps: 100 });
  console.log(`sell: amountIn ${sell.amountIn} spotOut ${sell.spotOut} minOut ${sell.amountOutMinimum} (spot x 0.99)`);
  results.legs.sell = { amountIn: sell.amountIn, spotOut: sell.spotOut, amountOutMinimum: sell.amountOutMinimum };
  const sellReceipts = await trade.executeTxs(cfg, chain, sell.txs, { liveConfirm: true });
  for (const r of sellReceipts) console.log(`  ${r.label}: ${r.hash} block ${r.block} gas ${r.gasUsed}`);
  results.legs.sell.txs = sellReceipts;
  const afterSell = await balances(client);
  console.log("balances AFTER SELL:", JSON.stringify(afterSell));
  results.balancesAfterSell = afterSell;
  const wethReceived = BigInt(afterSell.weth) - BigInt(afterBuy.weth);
  console.log(`WETH received from sell: ${wethReceived} raw`);
  results.legs.sell.wethReceived = wethReceived.toString();
  if (wethReceived <= 0n) throw new Error("SELL produced 0 WETH — sell path did not deliver");

  results.verdict = "PROVEN: Universal Router command 0x00 buys AND sells a V3 pool on Robinhood";
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync("v3-MICROTEST-20261108-0305.json", JSON.stringify(results, null, 2));
  console.log("\n=== MICRO-TEST COMPLETE ===");
  console.log("DELTA bought:", deltaReceived.toString(), "| WETH back from sell:", wethReceived.toString());
  console.log("Net WETH spent (buy 0.00001 + fees/impact, minus sell proceeds):", (AMOUNT_IN - wethReceived).toString(), "raw WETH");
  console.log("Results written to v3-MICROTEST-20261108-0305.json");
}

main().catch((e) => {
  console.error("\n!!! MICRO-TEST FAILED (stopped, no retry) !!!");
  console.error("Error:", (e.message || String(e)).slice(0, 800));
  process.exit(1);
});
