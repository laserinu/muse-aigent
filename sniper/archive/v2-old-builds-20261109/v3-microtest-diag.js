// v3-microtest-diag.js — DIAGNOSTIC, one targeted test (not a blind retry).
//
// Situation after two failed execute attempts (minOut 0.99, then 0.80):
// the router execute reverts bare BOTH live (Privy broadcast) and in
// eth_call — but the PROVEN V4 path ALSO reverts bare in eth_call on this
// RPC, so eth_call cannot tell us the revert reason. The dry-run sim
// proved the dispatcher routes command 0x00 to the pool (amountIn=0
// reverts "AS" = the pool's amountSpecified check), and the router
// bytecode contains the uniswapV3SwapCallback selector, so the swap logic
// and callback exist. The remaining failure is therefore in the callback
// PAYMENT step.
//
// Hypothesis under test: the Robinhood UR fork's V3 callback pays the
// pool with a DIRECT ERC20 transferFrom(user -> pool) — which needs an
// ERC20 allowance from the agent TO THE ROUTER — instead of (or in
// addition to) the canonical Permit2 transferFrom. The V4 path only
// needs Permit2 (SETLLE_ALL), so this would explain why V4 works and V3
// does not, despite identical Permit2 approvals.
//
// This script: (1) sends ONE ERC20 approve, agent -> Universal Router,
// WETH, exact 1e13 (0.00001 WETH — the same tiny amount, the same router
// already trusted with Permit2 allowances for V4); (2) retries the V3
// execute ONCE with minOut = spot x 0.80. If it succeeds, Path B is
// PROVEN (with the direct-approval requirement documented). If it
// reverts bare again, STOP — Path B is DEAD for EOAs on this fork and
// the remaining option is a deployed helper contract (out of scope).
//
// Usage: node v3-microtest-diag.js
// Writes: v3-MICROTEST-20261108-0305-diag.json (results; NOT live state).

const fs = require("fs");
const { parseAbi, encodeFunctionData } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const v3 = require("./v3.js");
const trade = require("./trade.js");
const v3trade = require("./v3-trade.js");

const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DELTA = "0xe8ffd7e24187f72afb08d75b1bb13088a989a791";
const DELTA_POOL = "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const AMOUNT_IN = 10n ** 13n; // 0.00001 WETH — same as attempts 1-2, NEVER more

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

async function balances(client) {
  const [eth, weth, delta, allowRouter] = await Promise.all([
    client.getBalance({ address: AGENT }),
    client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] }),
    client.readContract({ address: DELTA, abi: erc20Abi, functionName: "balanceOf", args: [AGENT] }),
    client.readContract({ address: WETH, abi: erc20Abi, functionName: "allowance", args: [AGENT, ROUTER] }),
  ]);
  return { eth: eth.toString(), weth: weth.toString(), delta: delta.toString(), wethAllowanceToRouter: allowRouter.toString() };
}

async function main() {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);
  const results = { startedAt: new Date().toISOString(), hypothesis: "V3 callback pays via direct ERC20 transferFrom (needs agent->router allowance), not Permit2", legs: {} };

  console.log("=== V3 MICRO-TEST DIAGNOSTIC — direct WETH->router approval + execute ===");
  const before = await balances(client);
  console.log("balances BEFORE:", JSON.stringify(before));
  results.balancesBefore = before;
  if (BigInt(before.weth) < AMOUNT_IN) throw new Error("ABORT: agent WETH below 0.00001");

  // Step 1: direct ERC20 approve agent -> router, exact AMOUNT_IN.
  console.log("\n--- Step 1: approve WETH -> Universal Router (exact 0.00001) ---");
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, AMOUNT_IN] });
  const approveHash = trade.sendTx(cfg, chain, { to: WETH, value: "0x0", data: approveData });
  const approveRc = await trade.waitReceipt(client, approveHash);
  console.log(`approve: ${approveHash} block ${approveRc.blockNumber} gas ${approveRc.gasUsed} status ${approveRc.status}`);
  results.approveDirect = { hash: approveHash, block: Number(approveRc.blockNumber), gasUsed: approveRc.gasUsed.toString(), status: approveRc.status };
  if (approveRc.status !== "success") throw new Error("direct approve tx failed: " + approveHash);

  // Step 2: retry the V3 execute (fresh pool state, minOut 0.80).
  const st = await v3.readV3PoolState(client, DELTA_POOL);
  const spotOut = v3trade.v3SpotOut(AMOUNT_IN, st.sqrtPriceX96, true);
  const minOut = (spotOut * 80n) / 100n;
  console.log(`\n--- Step 2: V3 execute (minOut 80% = ${minOut}) ---`);
  console.log(`pool tick ${st.tick} spotOut ${spotOut}`);
  const { data: execData } = v3trade.buildV3RouterExecute({
    tokenIn: WETH, tokenOut: DELTA, fee: st.fee, recipient: AGENT,
    amountIn: AMOUNT_IN, amountOutMinimum: minOut, payerIsUser: true,
  });
  const hash = trade.sendTx(cfg, chain, { to: ROUTER, value: "0x0", data: execData });
  const receipt = await trade.waitReceipt(client, hash);
  console.log(`execute: ${hash} block ${receipt.blockNumber} gas ${receipt.gasUsed} status ${receipt.status}`);
  results.legs.buy = { tx: { label: "router execute V3_SWAP (buy, diagnostic)", hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() }, amountIn: AMOUNT_IN.toString(), amountOutMinimum: minOut.toString() };
  if (receipt.status !== "success") throw new Error("DIAGNOSTIC BUY execute reverted onchain: " + hash + " — Path B is DEAD for EOAs on this fork (direct-approval hypothesis disproven)");
  const afterBuy = await balances(client);
  console.log("balances AFTER BUY:", JSON.stringify(afterBuy));
  results.balancesAfterBuy = afterBuy;
  const deltaReceived = BigInt(afterBuy.delta) - BigInt(before.delta);
  console.log(`DELTA received: ${deltaReceived} raw (${Number(deltaReceived) / 1e18} DELTA)`);
  results.legs.buy.deltaReceived = deltaReceived.toString();
  if (deltaReceived <= 0n) throw new Error("DIAGNOSTIC BUY produced 0 DELTA");

  results.verdict = "PROVEN (diagnostic): Universal Router command 0x00 buys a V3 pool on Robinhood — BUT only with a direct ERC20 approval agent->router in addition to the Permit2 bundle";
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync("v3-MICROTEST-20261108-0305-diag.json", JSON.stringify(results, null, 2));
  console.log("\n=== DIAGNOSTIC COMPLETE — BUY PROVEN ===");
  console.log("DELTA bought:", deltaReceived.toString());
  console.log("Results written to v3-MICROTEST-20261108-0305-diag.json");
  console.log("NOTE: the sell leg still needs doing (see the report) — the sell will need the same direct-approval pattern for DELTA.");
}

main().catch((e) => {
  console.error("\n!!! DIAGNOSTIC FAILED (stopped, no further attempts) !!!");
  console.error("Error:", (e.message || String(e)).slice(0, 800));
  process.exit(1);
});
