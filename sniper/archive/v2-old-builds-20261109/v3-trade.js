// v3-trade.js — V3 execution for sniper v2 (Robinhood Chain only).
//
// ⚠️ CORRECTION 2026-11-08 ~03:40 WIB: the Universal Router command 0x00
// path described below is DEAD for EOAs on the Robinhood fork — the live
// micro-test (report ~/workspace/research_notes/pons-v3-execution-microtest-20261108-0305/report.md,
// tools-and-sites Part 40) proved the router execute reverts bare at
// broadcast. Do NOT use buildV3Buy/buildV3Sell in this file.
// The PROVEN V3 path is the V3SwapHelper contract
// 0x3ecc88CBaD515D4F34dD365A109Cb7bB71a2FfcF (deployed 2026-11-08 ~03:33 WIB,
// Sourcify exact_match; report ~/workspace/research_notes/v3-helper-contract-20261108-0326/report.md,
// tools-and-sites Part 42): it calls pool.swap() directly and pays the
// pool in uniswapV3SwapCallback. Use the helper, not the UR builders here.
// The SwapRouter02 path is DEAD (no V3 swap selectors in its bytecode —
// see the dry-run report); direct pool.swap() is impossible from an EOA
// (needs a swap callback). Do NOT use the canonical Quoter/QuoterV2/
// SwapRouter02/SwapRouter-v1 addresses on Robinhood — they are forwarder
// decoys or silent no-ops.
//
// Execution shape mirrors the PROVEN V4 pattern in trade.js:
//   buy:  wrap ETH->WETH (only when quote is the wrapped native),
//         approve quote->Permit2, Permit2 approve quote->Router,
//         router execute V3_SWAP_EXACT_IN (command 0x00).
//   sell: approve token->Permit2, Permit2 approve token->Router,
//         router execute V3_SWAP_EXACT_IN (reversed path).
// Price comes from the pool's slot0 sqrtPriceX96 (v3.readV3PoolState),
// computed in exact BigInt math — NO Number() float for the minOut.
// minOut default = spot x 0.80 (the sniper's normal 20% buffer);
// the micro-test passes 0.99 (1% slippage).
//
// LIVE SAFETY — the builders below are pure calldata (no send). Sending
// goes through trade.executeTxs, which enforces the same live gate as V4
// (config.live, chain.live, chain.enabled, no executionBlocked,
// caller passes { liveConfirm: true }). V3 is NOT wired into the live
// watcher (run.js) — that needs a separate user Go + cap decision.
// Do NOT flip any live flag from this module.

const {
  encodeFunctionData, encodeAbiParameters, parseAbi, toHex,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const v3 = require("./v3.js");
const trade = require("./trade.js");

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

// Exact spot output for a V3 pool, in raw units, BigInt math only.
// sqrtPriceX96^2 / 2^192 = raw token1 per raw token0 (trade.js spotOutput
// note — verified against the known-good first $MUSE swap; no decimal
// factor, because sqrtPriceX96 is already in raw units).
// inputIsToken0=true: amountIn is token0 -> out is token1.
// inputIsToken0=false: amountIn is token1 -> out is token0.
function v3SpotOut(amountIn, sqrtPriceX96, inputIsToken0) {
  const q = BigInt(sqrtPriceX96);
  const Q192 = 2n ** 192n;
  if (inputIsToken0) return (BigInt(amountIn) * q * q) / Q192;
  return (BigInt(amountIn) * Q192) / (q * q);
}

// Build the Universal Router execute() calldata for V3_SWAP_EXACT_IN
// (command 0x00). Input struct: (recipient, amountIn, amountOutMinimum,
// path, payerIsUser). Path: tokenIn (20B) + fee (3B, big-endian uint24)
// + tokenOut (20B). payerIsUser=true: the router pulls the input token
// from the caller via Permit2 (needs the approve -> Permit2 bundle first).
function buildV3RouterExecute({ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, payerIsUser = true }) {
  const pathBytes = "0x" + tokenIn.slice(2) + Number(fee).toString(16).padStart(6, "0") + tokenOut.slice(2);
  const input = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [recipient, BigInt(amountIn), BigInt(amountOutMinimum), pathBytes, payerIsUser],
  );
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 min, rebuilt fresh
  const data = encodeFunctionData({
    abi: routerAbi, functionName: "execute",
    args: ["0x00", [input], BigInt(deadline)],
  });
  return { data, deadline, path: pathBytes };
}

// ---- BUY: quote -> token on a V3 pool. Pure calldata builder (no send). ----
// opts: { amountIn (BigInt, raw quote units — default: $0.02 of quote via
//   trade.buyAmountInQuote), slippageBps (default 2000 = minOut spot x 0.80) }
async function buildV3Buy(cfg, chain, poolAddress, token, tokenDecimals, quote, opts = {}) {
  const client = chains.makeClient(chain);
  const st = await v3.readV3PoolState(client, poolAddress);
  const amountIn = opts.amountIn !== undefined ? BigInt(opts.amountIn) : await trade.buyAmountInQuote(cfg, chain, quote, client);
  const slippageBps = opts.slippageBps !== undefined ? opts.slippageBps : 2000;
  const quoteIsToken0 = st.token0 === quote.address.toLowerCase();
  const tokenIsToken1 = st.token1 === token.toLowerCase();
  if (!quoteIsToken0 && st.token1 !== quote.address.toLowerCase()) throw new Error("quote is neither token0 nor token1 of the V3 pool");
  if (!tokenIsToken1 && st.token0 !== token.toLowerCase()) throw new Error("token is neither token0 nor token1 of the V3 pool");
  const inputIsToken0 = quoteIsToken0;
  const spotOut = v3SpotOut(amountIn, st.sqrtPriceX96, inputIsToken0);
  const minOut = (spotOut * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut <= 0n) throw new Error("computed V3 buy amountOutMinimum is 0 — pool too thin or price unreadable");
  const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const txs = [];
  const isWrappedNative = chain.wrappedNative && chain.wrappedNative.address.toLowerCase() === quote.address.toLowerCase();
  if (isWrappedNative) {
    txs.push({ label: `wrap ${chain.nativeSymbol}->${quote.symbol}`, to: quote.address, value: toHex(amountIn), data: "0xd0e30db0" }); // deposit()
  }
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.permit2, amountIn] });
  const permit2Data = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [quote.address, chain.universalRouter, amountIn, expiration] });
  const { data: execData, deadline } = buildV3RouterExecute({
    tokenIn: quote.address, tokenOut: token, fee: st.fee, recipient: cfg.agent,
    amountIn, amountOutMinimum: minOut, payerIsUser: true,
  });
  txs.push(
    { label: `approve ${quote.symbol}->Permit2`, to: quote.address, value: "0x0", data: approveData },
    { label: `Permit2 approve ${quote.symbol}->Router`, to: chain.permit2, value: "0x0", data: permit2Data },
    { label: "router execute V3_SWAP (buy)", to: chain.universalRouter, value: "0x0", data: execData },
  );
  return {
    pool: poolAddress, fee: st.fee, tick: st.tick,
    amountIn: amountIn.toString(), spotOut: spotOut.toString(),
    amountOutMinimum: minOut.toString(), slippageBps, deadline, txs,
  };
}

// ---- SELL: token -> quote on a V3 pool. Pure calldata builder (no send). ----
// opts: { slippageBps (default 2000 = minOut spot x 0.80) }
async function buildV3Sell(cfg, chain, poolAddress, token, tokenDecimals, quote, amountToken, opts = {}) {
  const client = chains.makeClient(chain);
  const st = await v3.readV3PoolState(client, poolAddress);
  const slippageBps = opts.slippageBps !== undefined ? opts.slippageBps : 2000;
  const tokenIsToken0 = st.token0 === token.toLowerCase();
  const quoteIsToken1 = st.token1 === quote.address.toLowerCase();
  if (!tokenIsToken0 && st.token1 !== token.toLowerCase()) throw new Error("token is neither token0 nor token1 of the V3 pool");
  if (!quoteIsToken1 && st.token0 !== quote.address.toLowerCase()) throw new Error("quote is neither token0 nor token1 of the V3 pool");
  const inputIsToken0 = tokenIsToken0;
  const spotOut = v3SpotOut(amountToken, st.sqrtPriceX96, inputIsToken0);
  const minOut = (spotOut * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut <= 0n) throw new Error("computed V3 sell amountOutMinimum is 0 — pool too thin or price unreadable");
  const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.permit2, amountToken] });
  const permit2Data = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, chain.universalRouter, amountToken, expiration] });
  const { data: execData, deadline } = buildV3RouterExecute({
    tokenIn: token, tokenOut: quote.address, fee: st.fee, recipient: cfg.agent,
    amountIn: amountToken, amountOutMinimum: minOut, payerIsUser: true,
  });
  return {
    pool: poolAddress, fee: st.fee, tick: st.tick,
    amountIn: BigInt(amountToken).toString(), spotOut: spotOut.toString(),
    amountOutMinimum: minOut.toString(), slippageBps, deadline,
    txs: [
      { label: "approve token->Permit2", to: token, value: "0x0", data: approveData },
      { label: "Permit2 approve token->Router", to: chain.permit2, value: "0x0", data: permit2Data },
      { label: "router execute V3_SWAP (sell)", to: chain.universalRouter, value: "0x0", data: execData },
    ],
  };
}

module.exports = { buildV3Buy, buildV3Sell, buildV3RouterExecute, v3SpotOut };
