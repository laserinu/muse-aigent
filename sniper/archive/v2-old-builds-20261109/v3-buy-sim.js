// v3-buy-sim.js — V3 buy-path proof (DRY-RUN ONLY, eth_call simulation).
//
// Proves (or disproves) that a V3 buy can be executed on Robinhood Chain
// from the agent wallet, WITHOUT sending any transaction. Two candidate
// paths are simulated via eth_call from the agent address:
//   A. SwapRouter02 (Robinhood) 0xCaf681a66D020601342297493863E78C959E5cb2
//      exactInputSingle — the dedicated V3 router.
//   B. Universal Router (Robinhood fork) 0x8876789976dEcBfCbBbe364623C63652db8C0904
//      execute() with V3_SWAP_EXACT_IN (command 0x00) — the same router
//      the v1/v2 snipers use for V4_SWAP.
//
// Interpretation (same logic as the V4 eth_call proofs in DRY-RUN-TEST.md):
//   - Revert AFTER the pool interaction (allowance / transfer failure,
//     e.g. "STF", allowance, or a router-level error mentioning the
//     transfer) = the swap path EXECUTED and only the missing allowance
//     stopped it -> path PROVEN, needs only approve + balance to go live.
//   - Bare-empty revert, unknown-command revert, or revert BEFORE any
//     pool interaction = the path is NOT proven (router may not support
//     V3 on this fork, wrong encoding, or wrong addresses).
//   - Success (no revert) would mean the call fully simulated —
//     unexpected here (no allowance), but would also prove the path.
//
// Test pool: DELTA/WETH 1% (0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94),
// buy 0.00001 WETH, minOut = spot * 0.80 (20% buffer, same as trade.js
// spot fallback). Spot is read live from slot0.
//
// Usage: node v3-buy-sim.js   (read-only; 0 txs sent)

const { createPublicClient, http, parseAbi, encodeFunctionData, encodeAbiParameters } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const v3 = require("./v3.js");

const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DELTA = "0xe8ffd7e24187f72afb08d75b1bb13088a989a791";
const DELTA_POOL = "0xD64FbdA67E1015dF43Fa5e49F02cA844729E5F94";
const UNIVERSAL_ROUTER_RH = "0x8876789976dEcBfCbBbe364623C63652db8C0904";

const router02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)",
]);
const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

async function main() {
  const cfg = chains.loadConfig();
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const client = chains.makeClient(chain);

  const st = await v3.readV3PoolState(client, DELTA_POOL);
  console.log("DELTA pool: fee", st.fee, "tick", st.tick, "liquidity", st.liquidity.toString());
  const amountIn = 10n ** 13n; // 0.00001 WETH
  const spot = v3.v3PriceFromSqrt(st.sqrtPriceX96, 18, 18); // raw DELTA per raw WETH
  const spotOut = BigInt(Math.floor(Number(amountIn) * spot));
  const minOut = (spotOut * 80n) / 100n;
  console.log("spot DELTA per WETH (raw):", spot, "spotOut:", spotOut.toString(), "minOut (80%):", minOut.toString());
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  // ---- Path A: SwapRouter02 exactInputSingle ----
  const dataA = encodeFunctionData({
    abi: router02Abi, functionName: "exactInputSingle",
    args: [{ tokenIn: WETH, tokenOut: DELTA, fee: 10000, recipient: AGENT, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  });
  console.log("\n--- Path A: SwapRouter02 exactInputSingle ---");
  try {
    const out = await client.call({ account: AGENT, to: v3.V3_SWAPROUTER02_RH, data: dataA });
    console.log("RESULT: call SUCCEEDED, return data:", out.data, "(unexpected — no allowance; path still PROVEN)");
  } catch (e) {
    console.log("RESULT: reverted.");
    console.log("  shortMessage:", (e.shortMessage || e.message || "").slice(0, 300));
    const msg = (e.message || "") + (e.details || "") + (e.metaMessages || []).join(" ");
    console.log("  full:", msg.slice(0, 600));
  }

  // ---- Path B: Universal Router V3_SWAP_EXACT_IN (command 0x00) ----
  // V3_SWAP_EXACT_IN input: (address recipient, uint256 amountIn,
  //   uint256 amountOutMinimum, bytes path, bool payerIsUser)
  // path: tokenIn (20B) + fee (3B) + tokenOut (20B).
  const pathBytes = "0x" + WETH.slice(2) + (10000).toString(16).padStart(6, "0") + DELTA.slice(2);
  const v3SwapInput = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [AGENT, amountIn, minOut, pathBytes, true],
  );
  const dataB = encodeFunctionData({
    abi: urAbi, functionName: "execute",
    args: ["0x00", [v3SwapInput], deadline],
  });
  console.log("\n--- Path B: Universal Router V3_SWAP_EXACT_IN (0x00) ---");
  try {
    const out = await client.call({ account: AGENT, to: UNIVERSAL_ROUTER_RH, data: dataB });
    console.log("RESULT: call SUCCEEDED, return data:", out.data, "(unexpected — no allowance; path still PROVEN)");
  } catch (e) {
    console.log("RESULT: reverted.");
    console.log("  shortMessage:", (e.shortMessage || e.message || "").slice(0, 300));
    const msg = (e.message || "") + (e.details || "") + (e.metaMessages || []).join(" ");
    console.log("  full:", msg.slice(0, 600));
  }
  console.log("\nDone. 0 transactions sent.");
}

main().catch((e) => { console.error("BUY-SIM ERROR:", e.message.slice(0, 300)); process.exit(1); });
