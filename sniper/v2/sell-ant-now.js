// sell-ant-now.js — ONE-OFF sell of the agent wallet's 120,000 ANT (dust
// airdrop from the "Anthropic" impersonation token) via the proven V3SwapHelper.
// User order 2026-11-08 ~09:11 GMT+7: "Sell it all for ~$16".
//
// Route: transfer ANT -> helper -> helper.swapExactInputSingle(ANT/WETH 1%
// V3 pool) -> WETH straight back to the agent wallet in the same tx.
// NO approvals anywhere (transfer-first, per the helper design).
//
// SAFETY:
// - Sells the FULL agent ANT balance (read live, expected exactly 120,000e18).
// - minOut is a hard floor from the CPMM estimate (pool token balances),
//   NOT the spot price: selling 120k ANT is ~45% of the pool's ANT reserve,
//   so spot x 80% (what buildV3HelperSell uses) would be far too tight and
//   revert. minOut = 0.005 WETH (~$11); expected ~0.0074 WETH (~$16.50).
//   If the live CPMM estimate comes in under 0.005 WETH, ABORT — pool too thin.
// - If the swap reverts onchain, executeV3HelperTxs rescues the funded ANT
//   back via rescueToken; if the fund itself fails, nothing moved.
// - Live gates enforced by executeV3HelperTxs (config.live, chain.live,
//   chain.enabled, v3 live, liveConfirm).
// - Dry-run: node sell-ant-now.js --dry-run (builds + logs, sends nothing).

const { encodeFunctionData, parseAbi } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const trade = require("./trade.js");
const { HELPER, WETH_RH, executeV3HelperTxs, v3SpotOut } = require("./v3-helper-trade.js");
const { readV3PoolState } = require("./v3.js");

const ANT = "0xa0fbF6B10d2021167ED7b3d0F61C1d8305C7898E";
const POOL = "0xca47bcfc1ca4bfe4337b9b3877b545adcc07eb12"; // ANT/WETH 1% V3
const MIN_OUT_WEI = 5000000000000000n; // 0.005 WETH floor (~$11)

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const helperAbi = parseAbi([
  "function swapExactInputSingle(address pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)",
]);

const DRY = process.argv.includes("--dry-run");

async function main() {
  const cfg = require("./config.json");
  const chain = { chainId: 4663, ...cfg.chains["4663"] }; // chainId lives in the key, not the object (cf. v3-run.js:67)
  const client = chains.makeClient(chain);
  const agent = cfg.agent;

  const antBal = await client.readContract({ address: ANT, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
  const wethBefore = await client.readContract({ address: WETH_RH, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
  console.log(`agent ANT balance: ${antBal} (${Number(antBal) / 1e18} ANT)`);
  console.log(`agent WETH before: ${wethBefore} (${Number(wethBefore) / 1e18} WETH)`);
  if (antBal === 0n) { console.log("nothing to sell — ANT balance is 0"); return; }

  const state = await readV3PoolState(client, POOL);
  console.log(`pool slot0 tick=${state.tick} fee=${state.fee} token0=${state.token0} token1=${state.token1}`);
  const spot = v3SpotOut(antBal, state.sqrtPriceX96, ANT.toLowerCase() === state.token0);
  console.log(`spot output for full balance: ${spot} wei WETH (${Number(spot) / 1e18})`);

  // CPMM estimate from the pool's actual token balances (upper-bound-ish for
  // concentrated liquidity; the honest number for a trade this size).
  const poolAnt = await client.readContract({ address: ANT, abi: erc20Abi, functionName: "balanceOf", args: [POOL] });
  const poolWeth = await client.readContract({ address: WETH_RH, abi: erc20Abi, functionName: "balanceOf", args: [POOL] });
  const antInAfterFee = (antBal * 99n) / 100n; // 1% pool fee
  const cpmmOut = (poolWeth * antInAfterFee) / (poolAnt + antInAfterFee);
  console.log(`pool reserves: ANT ${Number(poolAnt) / 1e18} / WETH ${Number(poolWeth) / 1e18}`);
  console.log(`CPMM expected out: ${cpmmOut} wei WETH (${Number(cpmmOut) / 1e18})`);
  console.log(`minOut floor: ${MIN_OUT_WEI} wei WETH (0.005)`);
  if (cpmmOut < MIN_OUT_WEI) {
    throw new Error(`ABORT: CPMM estimate ${cpmmOut} < minOut floor ${MIN_OUT_WEI} — pool too thin to exit at a sane price; ANT stays put`);
  }
  if (MIN_OUT_WEI >= spot) throw new Error("sanity: minOut >= spot, refusing");

  const fundData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HELPER, antBal] });
  const swapData = encodeFunctionData({
    abi: helperAbi, functionName: "swapExactInputSingle",
    args: [POOL, ANT, WETH_RH, antBal, MIN_OUT_WEI],
  });
  const txs = [
    { label: "fund helper (transfer ANT->helper)", to: ANT, value: "0x0", data: fundData },
    { label: "helper swapExactInputSingle (sell ANT->WETH)", to: HELPER, value: "0x0", data: swapData },
  ];
  console.log("txs built:", txs.map(t => t.label).join(" | "));
  if (DRY) { console.log("DRY RUN — nothing sent"); return; }

  const v3State = require("./v3-STATE.json");
  const results = await executeV3HelperTxs(cfg, chain, txs, {
    v3Live: v3State.live === true, liveConfirm: true, fundToken: ANT, fundAmount: antBal,
  });
  for (const r of results) console.log(`OK ${r.label}: ${r.hash} block ${r.block} gas ${r.gasUsed}`);

  const antAfter = await client.readContract({ address: ANT, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
  const wethAfter = await client.readContract({ address: WETH_RH, abi: erc20Abi, functionName: "balanceOf", args: [agent] });
  const gained = wethAfter - wethBefore;
  console.log(`agent ANT after: ${antAfter}`);
  console.log(`agent WETH after: ${wethAfter} (gained ${gained} wei = ${Number(gained) / 1e18} WETH)`);
  if (antAfter !== 0n) throw new Error(`VERIFY FAILED: agent still holds ${antAfter} ANT`);
  if (gained < MIN_OUT_WEI) throw new Error(`VERIFY FAILED: WETH gained ${gained} < minOut ${MIN_OUT_WEI}`);
  console.log("SELL VERIFIED: all ANT sold, WETH received above the floor.");
}

main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
