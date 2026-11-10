// v3-helper-trade.js — V3 execution via the V3SwapHelper contract
// (Robinhood Chain only). Built 2026-11-08 ~03:38 GMT+7 for the live V3
// wiring (separate V3 cap of 5, user delegated the decision to the parent).
//
// The PROVEN V3 path (report ~/workspace/research_notes/v3-helper-contract-20261108-0326/report.md,
// tools-and-sites Part 42): V3SwapHelper
// 0x3ecc88CBaD515D4F34dD365A109Cb7bB71a2FfcF (Sourcify exact_match, owner =
// agent wallet) calls pool.swap() directly and pays the pool in
// uniswapV3SwapCallback. Funding is transfer-first — NO approvals anywhere:
//   buy:  [wrap ETH->WETH if short] -> transfer quote -> helper
//         -> helper.swapExactInputSingle(pool, quote, token, amountIn, minOut)
//   sell: transfer token -> helper
//         -> helper.swapExactInputSingle(pool, token, quote, amount, minOut)
// The helper sends the full output straight back to the owner in the same
// tx and never holds funds beyond a single in-flight swap.
//
// ⚠️ Do NOT use the Universal Router builders in v3-trade.js — that path is
// DEAD for EOAs on the Robinhood fork (Part 40: router execute reverts bare
// at broadcast). The helper replaces it.
//
// LIVE SAFETY — executeV3HelperTxs NEVER sends unless ALL of:
//   1. config.live === true (master, already true for v2)
//   2. chain.live === true (Robinhood 4663, already true)
//   3. chain.enabled === true
//   4. opts.v3Live === true (v3-STATE.json live — the V3-only switch)
//   5. opts.liveConfirm === true (caller passes it explicitly)
// Otherwise it THROWS and nothing is sent. Dry-run callers use
// buildV3HelperBuy/buildV3HelperSell (pure calldata + view reads) and log
// "would BUY".
//
// HARD LIMITS: never more than 0.00001 ETH (1e13 wei) of quote per buy
// (MAX_BUY_WEI — enforced here, throws above it); never more than 5 V3
// positions (enforced by the runner's v3SnipesDone in v3-STATE.json).
// Robinhood only; V3 pools only.

const {
  encodeFunctionData, parseAbi, toHex,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const trade = require("./trade.js");

const HELPER = "0x3ecc88CBaD515D4F34dD365A109Cb7bB71a2FfcF"; // V3SwapHelper, Sourcify exact_match, owner = agent
const WETH_RH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MAX_BUY_WEI = 10000000000000n; // 0.00001 ETH — NEVER more per buy

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const helperAbi = parseAbi([
  "function swapExactInputSingle(address pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)",
  "function rescueToken(address token, uint256 amount)",
  "function owner() view returns (address)",
]);

// Exact spot output, BigInt only (same formula as the micro-test):
// inputIsToken0 -> out = amountIn * sqrt^2 / 2^192; else the inverse.
function v3SpotOut(amountIn, sqrtPriceX96, inputIsToken0) {
  const q = BigInt(sqrtPriceX96);
  const Q192 = 2n ** 192n;
  if (inputIsToken0) return (BigInt(amountIn) * q * q) / Q192;
  return (BigInt(amountIn) * Q192) / (q * q);
}

// ---- BUY: quote -> token via the helper. Pure calldata + view reads. ----
// amountIn: $0.02 in the quote (trade.buyAmountInQuote), hard-capped at
// MAX_BUY_WEI for WETH. minOut = spot x 0.80 (same 20% buffer as v2's
// spot fallback — LP fee + impact). The wrap step only covers the WETH
// shortfall against the agent's held WETH balance.
async function buildV3HelperBuy(cfg, chain, pool, token, tokenDecimals, quote) {
  const client = chains.makeClient(chain);
  const amountIn = await trade.buyAmountInQuote(cfg, chain, quote, client);
  const isWeth = quote.address.toLowerCase() === WETH_RH.toLowerCase();
  if (isWeth && amountIn > MAX_BUY_WEI) throw new Error(`V3 buy amount ${amountIn} exceeds the 0.00001 ETH cap (${MAX_BUY_WEI}) — refusing`);
  if (amountIn <= 0n) throw new Error("V3 buy amount is 0 — cannot size the buy");

  const state = await require("./v3.js").readV3PoolState(client, pool);
  const inputIsToken0 = quote.address.toLowerCase() === state.token0;
  const spot = v3SpotOut(amountIn, state.sqrtPriceX96, inputIsToken0);
  const minOut = (spot * 80n) / 100n;
  if (minOut <= 0n) throw new Error("computed V3 buy amountOutMinimum is 0 — pool too thin or price unreadable");

  const txs = [];
  if (isWeth) {
    const held = await client.readContract({ address: WETH_RH, abi: erc20Abi, functionName: "balanceOf", args: [cfg.agent] });
    const shortfall = amountIn - held;
    if (shortfall > 0n) {
      txs.push({ label: "wrap ETH->WETH", to: WETH_RH, value: toHex(shortfall), data: "0xd0e30db0" }); // deposit()
    }
  }
  const fundData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HELPER, amountIn] });
  const swapData = encodeFunctionData({
    abi: helperAbi, functionName: "swapExactInputSingle",
    args: [pool, quote.address, token, amountIn, minOut],
  });
  txs.push(
    { label: "fund helper (transfer quote->helper)", to: quote.address, value: "0x0", data: fundData },
    { label: "helper swapExactInputSingle (buy)", to: HELPER, value: "0x0", data: swapData },
  );
  return { amountIn: amountIn.toString(), amountOutMinimum: minOut.toString(), txs };
}

// ---- SELL: token -> quote via the helper. Pure calldata + view reads. ----
async function buildV3HelperSell(cfg, chain, pool, token, tokenDecimals, quote, amountToken) {
  const client = chains.makeClient(chain);
  if (amountToken <= 0n) throw new Error("V3 sell amount is 0");
  const state = await require("./v3.js").readV3PoolState(client, pool);
  const inputIsToken0 = token.toLowerCase() === state.token0;
  const spot = v3SpotOut(amountToken, state.sqrtPriceX96, inputIsToken0);
  const minOut = (spot * 80n) / 100n;
  if (minOut <= 0n) throw new Error("computed V3 sell amountOutMinimum is 0 — pool too thin or price unreadable");
  const fundData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [HELPER, amountToken] });
  const swapData = encodeFunctionData({
    abi: helperAbi, functionName: "swapExactInputSingle",
    args: [pool, token, quote.address, amountToken, minOut],
  });
  return {
    amountIn: amountToken.toString(), amountOutMinimum: minOut.toString(),
    txs: [
      { label: "fund helper (transfer token->helper)", to: token, value: "0x0", data: fundData },
      { label: "helper swapExactInputSingle (sell)", to: HELPER, value: "0x0", data: swapData },
    ],
  };
}

// ---- THE LIVE GATE (V3). Refuses unless every condition holds. ----
function assertV3LiveAllowed(cfg, chain, opts) {
  if (cfg.live !== true) throw new Error("V3 LIVE REFUSED: config.live is false (master dry-run)");
  if (chain.live !== true) throw new Error(`V3 LIVE REFUSED: chain ${chain.name} (${chain.chainId}) live flag is false`);
  if (chain.enabled !== true) throw new Error(`V3 LIVE REFUSED: chain ${chain.name} (${chain.chainId}) is disabled in config`);
  if (!opts || opts.v3Live !== true) throw new Error("V3 LIVE REFUSED: v3-STATE.json live is false (V3 dry-run mode)");
  if (!opts || opts.liveConfirm !== true) throw new Error("V3 LIVE REFUSED: caller must pass { liveConfirm: true }");
}

// Execute a helper bundle (fund + swap, plus an optional wrap first).
// opts: { liveConfirm, v3Live, fundToken, fundAmount } — fundToken/Amount
// describe the input the fund tx moves into the helper, so a reverted swap
// can be followed by a best-effort rescueToken to pull it back. A swap tx
// that fails at BROADCAST (no hash) sent nothing, so no rescue is needed;
// a swap that MINES reverted leaves the input stranded in the helper.
async function executeV3HelperTxs(cfg, chain, txs, opts) {
  assertV3LiveAllowed(cfg, chain, opts);
  const client = chains.makeClient(chain);
  const results = [];
  let funded = null; // { token, amount } once a fund tx succeeds
  for (const tx of txs) {
    let hash;
    try {
      hash = trade.sendTx(cfg, chain, tx);
    } catch (e) {
      // Broadcast failure: nothing was sent. If the fund already went in
      // and this was the swap, the input is NOT stranded (no tx mined) —
      // but the fund DID land, so try the rescue anyway to be safe.
      if (funded && tx.label && tx.label.includes("swapExactInputSingle")) {
        try {
          const rData = encodeFunctionData({ abi: helperAbi, functionName: "rescueToken", args: [funded.token, funded.amount] });
          const rHash = trade.sendTx(cfg, chain, { label: "rescueToken (after broadcast failure)", to: HELPER, value: "0x0", data: rData });
          const rRc = await trade.waitReceipt(client, rHash);
          results.push({ label: "rescueToken (after broadcast failure)", hash: rHash, block: Number(rRc.blockNumber), gasUsed: rRc.gasUsed.toString() });
        } catch (re) {
          throw new Error(`tx ${tx.label} broadcast failed (${e.message.slice(0, 150)}) and rescue ALSO failed (${re.message.slice(0, 100)}) — input may be stranded in the helper ${HELPER}`);
        }
      }
      throw new Error(`tx ${tx.label} broadcast failed: ${e.message.slice(0, 200)}`);
    }
    const receipt = await trade.waitReceipt(client, hash);
    if (receipt.status !== "success") {
      // Mined-reverted: if this was the swap, the fund input is stranded
      // in the helper — best-effort rescue, then report both.
      if (funded && tx.label && tx.label.includes("swapExactInputSingle")) {
        try {
          const rData = encodeFunctionData({ abi: helperAbi, functionName: "rescueToken", args: [funded.token, funded.amount] });
          const rHash = trade.sendTx(cfg, chain, { label: "rescueToken (after reverted swap)", to: HELPER, value: "0x0", data: rData });
          const rRc = await trade.waitReceipt(client, rHash);
          results.push({ label: "rescueToken (after reverted swap)", hash: rHash, block: Number(rRc.blockNumber), gasUsed: rRc.gasUsed.toString() });
          throw new Error(`tx ${tx.label} reverted onchain: ${hash} — input rescued via rescueToken ${rHash}`);
        } catch (re) {
          if (re.message.includes("rescued via rescueToken")) throw re;
          throw new Error(`tx ${tx.label} reverted onchain: ${hash} status ${receipt.status} — rescue ALSO failed (${re.message.slice(0, 100)}) — input stranded in the helper ${HELPER}, rescue manually with rescueToken`);
        }
      }
      throw new Error(`tx ${tx.label} failed: ${hash} status ${receipt.status}`);
    }
    results.push({ label: tx.label, hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() });
    if (tx.label && tx.label.startsWith("fund helper")) {
      funded = { token: opts.fundToken, amount: BigInt(opts.fundAmount) };
    }
  }
  return results;
}

module.exports = {
  HELPER, WETH_RH, MAX_BUY_WEI,
  v3SpotOut, buildV3HelperBuy, buildV3HelperSell,
  assertV3LiveAllowed, executeV3HelperTxs,
};
