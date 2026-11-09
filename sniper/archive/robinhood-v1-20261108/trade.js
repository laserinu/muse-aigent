// trade.js — Build + execute V4 swaps on Robinhood (4663) via the Privy CLI.
// Reuses the PROVEN pattern from ~/workspace/tokens/robin-muse/mainnet/FIRST-SWAP.md:
//   wrap ETH->WETH, approve WETH->Permit2, Permit2 approve WETH->Router,
//   router execute V4_SWAP (PoolKey as nested TUPLE, NOT bytes).
// The same pattern, reversed, sells a token back to WETH.
// NEVER run a real buy/sell unless the caller has already decided to do so.
// This module only builds calldata and, when asked, sends it via the Privy CLI.
const { execSync } = require("child_process");
const fs = require("fs");
const {
  encodeFunctionData, encodeAbiParameters, parseAbi, keccak256, toHex,
  createPublicClient, http,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const AGENT = "0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904"; // Robinhood-modified fork
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // F6B
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V4_QUOTER = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";

const client = createPublicClient({ transport: http(RPC) });
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const routerAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmountIn, bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)"
]);
const pmAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);

function privyRpc(jsonObj) {
  // Restore the pinned machine identity FIRST (session breaks on VM replacement otherwise).
  execSync("bash /home/hatch/workspace/privy/restore-privy-machine-identity.sh", { stdio: "pipe" });
  const body = JSON.stringify(jsonObj);
  const out = execSync(
    `cd /home/hatch/workspace/privy/agent-cli && ./node_modules/.bin/privy-agent-wallet rpc --json '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

async function sendTx(tx) {
  // tx = { to, value (hex string), data }
  const body = {
    method: "eth_sendTransaction",
    caip2: "eip155:4663",
    params: { transaction: { from: AGENT, to: tx.to, value: tx.value || "0x0", data: tx.data } },
  };
  const res = privyRpc(body);
  const hash = res?.data?.hash;
  if (!hash) throw new Error("Privy CLI did not return a tx hash: " + JSON.stringify(res).slice(0, 300));
  return hash;
}

async function waitReceipt(hash, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const rc = await client.getTransactionReceipt({ hash });
      if (rc) return rc;
    } catch (e) {
      // viem THROWS TransactionReceiptNotFoundError when the tx is not yet mined,
      // instead of returning null. That just means "not ready yet" — keep waiting.
      // Any other error is real and should propagate.
      const msg = String((e && e.message) || e);
      if (!/could not be found|not found|TransactionReceiptNotFound/i.test(msg)) throw e;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("no receipt for " + hash + " after " + timeoutMs + "ms");
}

async function readPoolState(poolId) {
  const slot0 = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
  const raw = await client.readContract({ address: POOL_MANAGER, abi: pmAbi, functionName: "extsload", args: [slot0] });
  const v = BigInt(raw);
  const sqrtP = v & ((1n << 160n) - 1n);
  const tickRaw = (v >> 160n) & ((1n << 24n) - 1n);
  const tick = tickRaw >= (1n << 23n) ? Number(tickRaw - (1n << 24n)) : Number(tickRaw);
  const lpFee = Number((v >> 208n) & ((1n << 24n) - 1n));
  return { sqrtPriceX96: sqrtP, tick, lpFee };
}

async function quoteBuy(poolKey, zeroForOne, amountIn) {
  // Returns the quoter output, or null if the quoter reverts (hooked pool).
  try {
    const [out] = await client.readContract({
      address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, "0x"],
    });
    return BigInt(out);
  } catch (e) {
    return null;
  }
}

function spotOutput(amountIn, sqrtP, tokenDecimals, zeroForOne) {
  // Spot-price estimate: price = (sqrtP/2^96)^2, adjusted for decimals.
  // WETH has 18 decimals. tokenOut per WETH-in (if WETH is currency0 and zeroForOne):
  //   price (token per WETH) = (sqrtP/2^96)^2 * 10^(18 - tokenDecimals)
  // This ignores fees/impact; the caller applies a slippage buffer.
  const ratio = Number(sqrtP) / 2 ** 96;
  const price = ratio * ratio; // token1 per token0 in raw units (before decimal adjustment)
  // amountIn is in WETH wei (18 dec). Output in token base units:
  //   out = amountIn * price * 10^(tokenDecimals-18)
  const out = (Number(amountIn) * price * 10 ** (tokenDecimals - 18));
  return BigInt(Math.floor(out));
}

function buildRouterExecute(poolKey, zeroForOne, amountIn, amountOutMinimum, inputCurrency, outputCurrency) {
  const swapParams = encodeAbiParameters(
    [{ type: "tuple", name: "params", components: [
      { type: "tuple", name: "poolKey", components: [
        { type: "address", name: "currency0" },
        { type: "address", name: "currency1" },
        { type: "uint24", name: "fee" },
        { type: "int24", name: "tickSpacing" },
        { type: "address", name: "hooks" },
      ]},
      { type: "bool", name: "zeroForOne" },
      { type: "uint128", name: "amountIn" },
      { type: "uint128", name: "amountOutMinimum" },
      { type: "uint256", name: "minHopPriceX36" },
      { type: "bytes", name: "hookData" },
    ]}],
    [{ poolKey: { currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks }, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: "0x" }]
  );
  const settleParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inputCurrency, amountIn]);
  const takeParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outputCurrency, amountOutMinimum]);
  const actions = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const v4SwapInput = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]]
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = nowSec + 1800; // 30 min, rebuilt fresh every time
  const executeData = encodeFunctionData({
    abi: routerAbi, functionName: "execute",
    args: ["0x10", [v4SwapInput], BigInt(deadline)],
  });
  return { data: executeData, deadline };
}

// ---- BUY: 0.00001 ETH (WETH) -> token ----
async function buildBuy(poolKey, token, tokenDecimals) {
  const amountIn = 10000000000000n; // 0.00001 ETH = 1e13 wei
  const zeroForOne = poolKey.currency0.toLowerCase() === WETH.toLowerCase();
  // amountOutMinimum: prefer the quoter; fall back to spot price minus 20%.
  const { sqrtPriceX96 } = await readPoolState(poolKey.poolId);
  let expected = await quoteBuy(poolKey, zeroForOne, amountIn);
  let minOut;
  if (expected !== null && expected > 0n) {
    minOut = (expected * 98n) / 100n; // 2% slippage
  } else {
    const spot = spotOutput(amountIn, sqrtPriceX96, tokenDecimals, zeroForOne);
    minOut = (spot * 80n) / 100n; // 20% buffer (covers LP fee + hook fee + impact)
    if (minOut <= 0n) throw new Error("computed amountOutMinimum is 0 — pool too thin or price unreadable");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const expiration = nowSec + 365 * 24 * 3600;
  const wrapData = "0xd0e30db0"; // deposit()
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amountIn] });
  const permit2Data = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [WETH, ROUTER, amountIn, expiration] });
  const { data: execData, deadline } = buildRouterExecute(poolKey, zeroForOne, amountIn, minOut, WETH, token);
  return {
    amountIn: amountIn.toString(), amountOutMinimum: minOut.toString(), deadline,
    txs: [
      { label: "wrap ETH->WETH", to: WETH, value: toHex(amountIn), data: wrapData },
      { label: "approve WETH->Permit2", to: WETH, value: "0x0", data: approveData },
      { label: "Permit2 approve WETH->Router", to: PERMIT2, value: "0x0", data: permit2Data },
      { label: "router execute V4_SWAP (buy)", to: ROUTER, value: "0x0", data: execData },
    ],
  };
}

// ---- SELL: token -> WETH ----
async function buildSell(poolKey, token, tokenDecimals, amountToken) {
  const zeroForOne = poolKey.currency0.toLowerCase() === token.toLowerCase();
  const { sqrtPriceX96 } = await readPoolState(poolKey.poolId);
  // For the sell, the output is WETH. Spot price (WETH per token) = 1 / (token per WETH).
  // Compute token-per-WETH first, then invert.
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const tokenPerWeth = ratio * ratio * 10 ** (tokenDecimals - 18);
  const wethPerToken = tokenPerWeth > 0 ? 1 / tokenPerWeth : 0;
  const spotOut = BigInt(Math.floor(Number(amountToken) * wethPerToken));
  let expected = null;
  try {
    const [out] = await client.readContract({
      address: V4_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountToken, "0x"],
    });
    expected = BigInt(out);
  } catch (e) { expected = null; }
  let minOut;
  if (expected !== null && expected > 0n) minOut = (expected * 98n) / 100n;
  else {
    minOut = (spotOut * 80n) / 100n;
    if (minOut <= 0n) throw new Error("computed sell amountOutMinimum is 0");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const expiration = nowSec + 365 * 24 * 3600;
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amountToken] });
  const permit2Data = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, ROUTER, amountToken, expiration] });
  const { data: execData, deadline } = buildRouterExecute(poolKey, zeroForOne, amountToken, minOut, token, WETH);
  return {
    amountIn: amountToken.toString(), amountOutMinimum: minOut.toString(), deadline,
    txs: [
      { label: "approve token->Permit2", to: token, value: "0x0", data: approveData },
      { label: "Permit2 approve token->Router", to: PERMIT2, value: "0x0", data: permit2Data },
      { label: "router execute V4_SWAP (sell)", to: ROUTER, value: "0x0", data: execData },
    ],
  };
}

async function executeTxs(txs) {
  // Sends each tx via the Privy CLI and waits for its receipt. Returns [{label, hash, receipt}].
  const results = [];
  for (const tx of txs) {
    const hash = await sendTx(tx);
    const receipt = await waitReceipt(hash);
    if (receipt.status !== "success") throw new Error(`tx ${tx.label} failed: ${hash} status ${receipt.status}`);
    results.push({ label: tx.label, hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() });
  }
  return results;
}

module.exports = { buildBuy, buildSell, executeTxs, sendTx, waitReceipt, readPoolState, client, AGENT, WETH, ROUTER, PERMIT2, POOL_MANAGER };
