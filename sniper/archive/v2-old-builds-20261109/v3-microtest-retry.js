// v3-microtest-retry.js — ONE retry of the V3 micro-test buy (execute-only).
//
// The first attempt (v3-microtest.js) failed ONLY on the router execute
// tx: bare revert at broadcast. Onchain state proved the wrap + both
// approvals HAD landed (WETH 1e13, WETH->Permit2 allowance 1e13,
// Permit2 allowance (agent,WETH,router) 1e13). The failure is consistent
// with amountOutMinimum too tight: minOut was spot x 0.99, but the pool
// charges a 1% LP fee, so expected output is ~spot x 0.99 — right at the
// boundary, and any rounding pushes it below minOut (the router's
// V3TooLittleReceived is a custom error, i.e. a bare revert with no
// reason string — exactly what Privy reported).
//
// This script is the ONE allowed retry, with minOut = spot x 0.80 (the
// sniper's standard 20% buffer, same as the V4 spot fallback). It sends
// ONLY the execute tx (wrap + approvals already exist — do not re-wrap).
// If the execute succeeds, it proceeds to the SELL leg (full 3-tx bundle,
// also at 0.80) to close the loop. If the execute reverts again, STOP —
// that proves a structural path failure, not a minOut problem.
//
// Usage: node v3-microtest-retry.js
// Writes: v3-MICROTEST-20261108-0305-retry.json (results; NOT live state).

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
const AMOUNT_IN = 10n ** 13n; // 0.00001 WETH — same as attempt 1, NEVER more

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
  const results = { startedAt: new Date().toISOString(), retryOf: "v3-microtest.js attempt 1 (execute reverted bare; wrap+approvals landed)", minOutBuffer: "spot x 0.80", legs: {} };

  console.log("=== V3 MICRO-TEST RETRY (LIVE) — execute-only buy at spot x 0.80 ===");
  const before = await balances(client);
  console.log("balances BEFORE RETRY:", JSON.stringify(before));
  results.balancesBeforeRetry = before;
  if (BigInt(before.weth) < AMOUNT_IN) throw new Error("ABORT: agent WETH below 0.00001 — the wrap from attempt 1 is missing");

  const st = await v3.readV3PoolState(client, DELTA_POOL);
  console.log(`pool: fee ${st.fee} tick ${st.tick} liquidity ${st.liquidity}`);
  const spotOut = v3trade.v3SpotOut(AMOUNT_IN, st.sqrtPriceX96, true);
  const minOut = (spotOut * 80n) / 100n;
  console.log(`spotOut ${spotOut} minOut (80%) ${minOut}`);
  results.spotOut = spotOut.toString(); results.amountOutMinimum = minOut.toString();

  // ---- RETRY BUY: execute-only ----
  console.log("\n--- RETRY BUY: router execute V3_SWAP only ---");
  const { data: execData, deadline } = v3trade.buildV3RouterExecute({
    tokenIn: WETH, tokenOut: DELTA, fee: st.fee, recipient: AGENT,
    amountIn: AMOUNT_IN, amountOutMinimum: minOut, payerIsUser: true,
  });
  const hash = trade.sendTx(cfg, chain, { to: chain.universalRouter, value: "0x0", data: execData });
  const receipt = await trade.waitReceipt(client, hash);
  console.log(`execute: ${hash} block ${receipt.blockNumber} gas ${receipt.gasUsed} status ${receipt.status}`);
  results.legs.buy = { tx: { label: "router execute V3_SWAP (buy, retry)", hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() }, amountIn: AMOUNT_IN.toString(), amountOutMinimum: minOut.toString(), deadline };
  if (receipt.status !== "success") throw new Error("RETRY BUY execute reverted onchain: " + hash + " — structural path failure, not minOut");
  const afterBuy = await balances(client);
  console.log("balances AFTER BUY:", JSON.stringify(afterBuy));
  results.balancesAfterBuy = afterBuy;
  const deltaReceived = BigInt(afterBuy.delta) - BigInt(before.delta);
  console.log(`DELTA received: ${deltaReceived} raw (${Number(deltaReceived) / 1e18} DELTA)`);
  results.legs.buy.deltaReceived = deltaReceived.toString();
  if (deltaReceived <= 0n) throw new Error("RETRY BUY produced 0 DELTA");

  // ---- LEG 2: SELL (close the loop) at spot x 0.80 ----
  console.log("\n--- LEG 2: SELL all received DELTA -> WETH (spot x 0.80) ---");
  const sell = await v3trade.buildV3Sell(cfg, chain, DELTA_POOL, DELTA, 18, quote, deltaReceived, { slippageBps: 2000 });
  console.log(`sell: amountIn ${sell.amountIn} spotOut ${sell.spotOut} minOut ${sell.amountOutMinimum} (spot x 0.80)`);
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
  if (wethReceived <= 0n) throw new Error("SELL produced 0 WETH");

  results.verdict = "PROVEN: Universal Router command 0x00 buys AND sells a V3 pool on Robinhood (attempt 1 failed only on minOut: 1% buffer == 1% pool fee)";
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync("v3-MICROTEST-20261108-0305-retry.json", JSON.stringify(results, null, 2));
  console.log("\n=== MICRO-TEST RETRY COMPLETE ===");
  console.log("DELTA bought:", deltaReceived.toString(), "| WETH back from sell:", wethReceived.toString());
  console.log("Results written to v3-MICROTEST-20261108-0305-retry.json");
}

main().catch((e) => {
  console.error("\n!!! MICRO-TEST RETRY FAILED (stopped, no further retry) !!!");
  console.error("Error:", (e.message || String(e)).slice(0, 800));
  process.exit(1);
});
