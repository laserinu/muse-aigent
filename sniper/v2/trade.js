// trade.js — Sniper v2 execution STUB (chain-agnostic).
//
// Calldata building reuses the PROVEN v1 pattern (robinhood/trade.js):
//   wrap native -> wrapped native (only when the quote IS the wrapped
//   native), approve quote -> Permit2, Permit2 approve quote -> Router,
//   router execute V4_SWAP (PoolKey as nested TUPLE, NOT bytes).
// The same pattern, reversed, sells a token back to the quote token.
//
// LIVE SAFETY — this module NEVER sends a transaction unless ALL of:
//   1. config.live === true (master default: false)
//   2. chain.live === true (per-chain, default false)
//   3. chain.enabled === true
//   4. chain.executionBlocked is NOT set (Polygon was blocked until the
//      sign+broadcast path below was built + dry-run proven, 2026-11-07;
//      it stays blocked in live config until Polygon is funded — see the
//      POLYGON guards. The old "blocked FOREVER" note is superseded.)
//   5. the caller passes { liveConfirm: true } explicitly
// Otherwise executeTxs THROWS and nothing is sent. Dry-run callers use
// buildBuy/buildSell (pure calldata, no send) and log "would BUY".
//
// POLYGON execution path (chain 137 only): the Privy CLI `rpc` broadcast
// FAILS on Polygon (proven). Fallback, proven for setAgentURI (2026-11-06):
// sign via eth_signTransaction, broadcast the raw tx via a public RPC.
// Shape: body = { method: "eth_signTransaction", params: { transaction: {
// from, to, value, data, chain_id: 137, nonce, gas_limit,
// max_fee_per_gas, max_priority_fee_per_gas } } } — NO top-level caip2;
// chain_id INSIDE params.transaction; gas/fee fields ONLY snake_case;
// max_priority_fee_per_gas = 25 gwei (Polygon min tip); max_fee_per_gas =
// base fee + 25 gwei tip + ~20% headroom, hex. Broadcast via
// eth_sendRawTransaction on the chain's public RPC, then waitReceipt.
// Polygon guards (this path only): POLYGON_MAX_GAS_GWEI (refuse above it)
// and POLYGON_RESERVE_WEI — the 0.16 POL setAgentURI reserve is a FLOOR:
// before EVERY tx, balance minus this tx's value + worst-case gas cost
// must stay >= reserve, otherwise the tx is refused (RESERVE-SKIP) and
// the bundle stops. No Polygon tx can ever spend the reserve.
//
// Per-chain router encoding: buildRouterExecute (v1, 6-field
// ExactInputSingleParams incl. minHopPriceX36) is used on Robinhood (fork
// router) and Arc (0x4fcA…), where it is PROVEN live. Base and Polygon
// point at Universal Router V2 (Base 0x6ff5…, Polygon 0x1095…) and use
// buildRouterExecuteV2 (5-field params, no minHopPriceX36) — PROVEN
// 2026-11-07 ~19:22–19:35 GMT+7 via eth_call on liquid pools
// (AllowanceExpired = swap executed; V1 encoding reverts bare-empty on V2).
// The selector is chain.routerVersion === 2 (see buildRouterExecuteFor).
// Polygon encoding proof (dry-run 2026-11-07, see DRY-RUN-TEST.md
// "Polygon" and "Router V2 encoding"): eth_call of the built router
// execute calldata from the agent address — see Test 11 for the
// revert-reason interpretation.

const { execSync } = require("child_process");
const {
  encodeFunctionData, encodeAbiParameters, parseAbi, toHex,
  createPublicClient, http,
} = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");

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
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmountIn, bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)",
]);

// APPROXIMATE USD prices — used ONLY to convert the $0.02 buy size into
// quote units. NEVER use these for live sizing; replace with a live price
// feed (CoinGecko / DexScreener) before any live buy.
// Per-quote approxUsdPrice in config.json takes PRECEDENCE over this map
// (every expanded quote carries one, incl. all 203 Robinhood stocks + 7 B20).
// Prices refreshed 2026-11-07: BTC $75,905, ETH $2,243 (CoinGecko).
// POL/WPOL refreshed 2026-11-07 ~19:05 GMT+7: $0.0905 (live onchain — Uniswap
// WPOL/USDT0 $0.09054, Dooar $0.09143, QuickSwap $0.09072; CoinGecko's
// $0.126 lags). The old 0.2 was badly stale: at 0.2 a $0.02 buy sized to
// 0.1 POL = only ~$0.009 of real value. POL is Polygon's buy principal, so
// this number decides whether a Polygon buy fits the budget at all.
const APPROX_USD_PRICE = { ETH: 2243, WETH: 2243, WPOL: 0.0905, POL: 0.0905, BNB: 1100, WBNB: 1100, USDC: 1, EURC: 1.15, USDG: 1, USDT: 1, USDT0: 1, DAI: 1, WBTC: 75905, cbBTC: 75905, BTCB: 75905 };

// ERC-8056: for stock quotes, balanceOf() is NOT the economic balance.
// Economic balance = balanceOf * uiMultiplier / 1e18, in the token's decimals.
// Verified onchain 2026-11-07: uiMultiplier() responds on all 203 Robinhood
// stock tokens and all 7 Base B20 tokens; it REVERTS on Ondo/xStocks (they are
// NOT ERC-8056) — a revert means plain ERC-20, multiplier 1e18.
// Fetch live at buy time (the multiplier drifts slowly with the stock price).
const UI_MULTIPLIER_ABI = parseAbi(["function uiMultiplier() view returns (uint256)"]);
async function quoteMultiplier(client, quote) {
  if (!quote.stock) return 10n ** 18n;
  try {
    return BigInt(await client.readContract({ address: quote.address, abi: UI_MULTIPLIER_ABI, functionName: "uiMultiplier" }));
  } catch (e) {
    return 10n ** 18n; // not ERC-8056 (Ondo/xStocks) — plain ERC-20
  }
}

// $0.02 (config.buySizeUsd) -> quote RAW units.
// Price: quote.approxUsdPrice (config) first, else APPROX_USD_PRICE.
// Stock quotes: raw = usd * 10^dec * 1e18 / (price * uiMultiplier), because
// USD value = raw * mult / 1e18 / 10^dec * price. Worked example (NVDA):
// $0.02 / $188.16 * 1e18 * 1e18 / 1.000775e18 = ~1.062e14 raw units, whose
// UI balance is 1.0628e-4 shares = $0.02. Plain quotes: mult = 1e18, so the
// formula reduces to the old (usd / price) * 10^dec.
async function buyAmountInQuote(cfg, chain, quote, client) {
  const usd = cfg.buySizeUsd || 1;
  const price = quote.approxUsdPrice ?? APPROX_USD_PRICE[quote.symbol];
  if (!price) throw new Error("no approximate USD price for quote " + quote.symbol + " — cannot size the buy");
  const c = client || chains.makeClient(chain);
  const mult = await quoteMultiplier(c, quote);
  const raw = (usd / price) * 10 ** quote.decimals * 1e18 / Number(mult);
  return BigInt(Math.floor(raw));
}

// Pre-buy balance guard (added 2026-11-07, expanded quotes): the agent holds
// 0 of every new quote (DAI/WBTC/stock tokens...). Without this, a passing
// pool would burn gas on an approve that must revert. Both sides are RAW
// units, so the comparison needs no multiplier conversion. Returns
// { ok, balance, amountIn } — the caller logs BALANCE-SKIP and never sends.
async function checkQuoteBalance(cfg, chain, quote) {
  const client = chains.makeClient(chain);
  const amountIn = await buyAmountInQuote(cfg, chain, quote, client);
  let balance;
  const isWrappedNative = chain.wrappedNative && chain.wrappedNative.address.toLowerCase() === quote.address.toLowerCase();
  if (isWrappedNative) {
    balance = await client.getBalance({ address: cfg.agent });
  } else if (quote.address === "0x3600000000000000000000000000000000000000") {
    // Arc native USDC: ERC-20 face (6 dec) == native balance (18 dec) / 1e12.
    balance = (await client.getBalance({ address: cfg.agent })) / 10n ** 12n;
  } else {
    balance = await client.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.agent] });
  }
  return { ok: balance >= amountIn, balance: balance.toString(), amountIn: amountIn.toString() };
}

function privyRpc(jsonObj) {
  // Restore the pinned machine identity FIRST (session breaks on VM replacement otherwise).
  execSync("bash /home/hatch/workspace/privy/restore-privy-machine-identity.sh", { stdio: "pipe" });
  const body = JSON.stringify(jsonObj);
  const out = execSync(
    `cd /home/hatch/workspace/privy/agent-cli && ./node_modules/.bin/privy-agent-wallet rpc --json '${body.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function sendTx(cfg, chain, tx) {
  const body = {
    method: "eth_sendTransaction",
    caip2: `eip155:${chain.chainId}`,
    params: { transaction: { from: cfg.agent, to: tx.to, value: tx.value || "0x0", data: tx.data } },
  };
  const res = privyRpc(body);
  const hash = res?.data?.hash;
  if (!hash) throw new Error("Privy CLI did not return a tx hash: " + JSON.stringify(res).slice(0, 300));
  return hash;
}

async function waitReceipt(client, hash, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await client.getTransactionReceipt({ hash });
      if (r) return r;
    } catch (e) {
      // viem THROWS TransactionReceiptNotFoundError when the tx is not yet
      // mined instead of returning null — keep polling (v1 fix, 2026-11-07).
      if (!String(e.message).includes("TransactionReceiptNotFoundError") && !String(e.name).includes("TransactionReceiptNotFoundError")) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("waitReceipt timed out for " + hash);
}

function buildRouterExecute(chain, poolKey, zeroForOne, amountIn, amountOutMinimum, inputCurrency, outputCurrency) {
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
    [{ poolKey: { currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks }, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: "0x" }],
  );
  const settleParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inputCurrency, amountIn]);
  const takeParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outputCurrency, amountOutMinimum]);
  const actions = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const v4SwapInput = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]],
  );
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 min, rebuilt fresh every time
  const executeData = encodeFunctionData({
    abi: routerAbi, functionName: "execute",
    args: ["0x10", [v4SwapInput], BigInt(deadline)],
  });
  return { data: executeData, deadline };
}

// V2 router encoding (Universal Router V2: Base 0x6ff5…, Polygon 0x1095…).
// PROVEN 2026-11-07 ~19:22–19:35 GMT+7 (see DRY-RUN-TEST.md "Router V2
// encoding"): the ONLY structural difference from v1 is that V2's
// ExactInputSingleParams has NO minHopPriceX36 field (5 fields, not 6).
// Everything else is identical: same execute() selector, command 0x10,
// actions 0x060c0f, SETTLE/TAKE params. eth_call proof on liquid pools
// (Polygon GRT/USDT0, Base USDC/PEPE) reaches AllowanceExpired — the swap
// EXECUTED, only the dry-run funds step failed. V1 encoding on the V2
// router reverts bare-empty (the hookData offset lands on minHopPriceX36).
// Selected automatically when chain.routerVersion === 2.
function buildRouterExecuteV2(chain, poolKey, zeroForOne, amountIn, amountOutMinimum, inputCurrency, outputCurrency) {
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
      { type: "bytes", name: "hookData" },
    ]}],
    [{ poolKey: { currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks }, zeroForOne, amountIn, amountOutMinimum, hookData: "0x" }],
  );
  const settleParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inputCurrency, amountIn]);
  const takeParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outputCurrency, amountOutMinimum]);
  const actions = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const v4SwapInput = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]],
  );
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 min, rebuilt fresh every time
  const executeData = encodeFunctionData({
    abi: routerAbi, functionName: "execute",
    args: ["0x10", [v4SwapInput], BigInt(deadline)],
  });
  return { data: executeData, deadline };
}

// Router-encoding selector: V2 builder when the chain points at a
// Universal Router V2 (chain.routerVersion === 2), else the v1 builder.
function buildRouterExecuteFor(chain, poolKey, zeroForOne, amountIn, amountOutMinimum, inputCurrency, outputCurrency) {
  if (chain.routerVersion === 2) return buildRouterExecuteV2(chain, poolKey, zeroForOne, amountIn, amountOutMinimum, inputCurrency, outputCurrency);
  return buildRouterExecute(chain, poolKey, zeroForOne, amountIn, amountOutMinimum, inputCurrency, outputCurrency);
}

async function quoteBuy(chain, poolKey, zeroForOne, amountIn) {
  const client = chains.makeClient(chain);
  try {
    const [out] = await client.readContract({
      address: chain.v4Quoter, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountIn, "0x"],
    });
    return BigInt(out);
  } catch {
    return null; // quoter reverts on hooked pools — caller falls back to spot
  }
}

function spotOutput(amountIn, sqrtP, tokenDecimals, quoteDecimals, zeroForOne) {
  // Spot-price estimate, ignoring fees/impact; caller applies a slippage buffer.
  // sqrtPriceX96 is already in RAW token units: price = ratio^2 is raw
  // token1 per raw token0, so NO decimal adjustment is needed. An earlier
  // version multiplied by 10^(tokenDec-quoteDec), overstating mixed-decimal
  // outputs by that factor (1e12 for an 18-dec token vs 6-dec USDC) — every
  // spot-fallback buy then reverted V4TooLittleReceived. Verified against
  // the known-good first $MUSE swap: 50000 raw USDC * 2e13 = 1e18 raw MUSE
  // = 1e9 MUSE, vs the actual 986,590,874.86 gross (fees + impact).
  // tokenDecimals/quoteDecimals are kept for call-site compatibility.
  const ratio = Number(sqrtP) / 2 ** 96;
  const price = ratio * ratio; // raw token1 per raw token0
  const out = zeroForOne
    ? (Number(amountIn) * price)
    : (Number(amountIn) / price);
  return BigInt(Math.floor(out));
}

// ---- NATIVE-ETH BUY: ETH -> token (V4). Pure calldata builder (no send). ----
// Part 58 (2026-11-09): ~67% of Robinhood launches pair the token with
// NATIVE ETH (currency 0x0), not WETH. The Universal Router settles a
// native input from msg.value — so the native buy is a SINGLE router
// execute tx carrying value=amountIn. No wrap, no approve, no Permit2.
// minOut: quoter (4-arg) -> 2% slippage, else spot x 80% (same fallback
// as buildBuy). NOTE: the Robinhood fork quoter reverts on every pool
// type tested (Part 58 probes: native + non-native, hookless + liquid),
// so the spot fallback is the real path there. The buy size uses a LIVE
// ETH price (passed in) — trade.js's APPROX_USD_PRICE.ETH (2243) is
// stale (+6% vs live ~$2109) and would undersize a native buy.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
function nativeEthQuote(ethUsdPrice) {
  return { address: ZERO_ADDRESS, symbol: "ETH", decimals: 18, approxUsdPrice: ethUsdPrice };
}

async function buildBuyNative(cfg, chain, poolKey, token, tokenDecimals, ethUsdPrice) {
  const client = chains.makeClient(chain);
  const quote = nativeEthQuote(ethUsdPrice);
  const amountIn = await buyAmountInQuote(cfg, chain, quote, client);
  const zeroForOne = poolKey.currency0.toLowerCase() === ZERO_ADDRESS;
  const { sqrtPriceX96 } = await chains.readPoolState(client, chain.poolManager, poolKey.poolId);
  let expected = await quoteBuy(chain, poolKey, zeroForOne, amountIn);
  let minOut, minOutSource;
  if (expected !== null && expected > 0n) {
    minOut = (expected * 98n) / 100n; // 2% slippage
    minOutSource = "quoter";
  } else {
    const spot = spotOutput(amountIn, sqrtPriceX96, tokenDecimals, quote.decimals, zeroForOne);
    minOut = (spot * 80n) / 100n; // 20% buffer (LP fee + hook fee + impact)
    minOutSource = "spot";
    if (minOut <= 0n) throw new Error("computed native amountOutMinimum is 0 — pool too thin or price unreadable");
  }
  const { data: execData, deadline } = buildRouterExecuteFor(chain, poolKey, zeroForOne, amountIn, minOut, ZERO_ADDRESS, token);
  return {
    amountIn: amountIn.toString(), amountOutMinimum: minOut.toString(), minOutSource, deadline, isNative: true,
    txs: [{ label: "router execute V4_SWAP (buy, native ETH)", to: chain.universalRouter, value: toHex(amountIn), data: execData }],
  };
}

// ---- NATIVE-ETH SELL: token -> ETH (V4). Pure calldata builder. ----
// Same as buildSell but the output currency is native ETH (0x0): the
// router's TAKE_ALL sends ETH to the caller. The approve/Permit2 steps
// are for the TOKEN (unchanged). Thin wrapper so the intent is explicit.
async function buildSellNative(cfg, chain, poolKey, token, tokenDecimals, amountToken) {
  const built = await buildSell(cfg, chain, poolKey, token, tokenDecimals, { address: ZERO_ADDRESS, symbol: "ETH", decimals: 18 }, amountToken);
  return { ...built, isNative: true };
}

// ---- BUY: quote -> token. Pure calldata builder (no send). ----
async function buildBuy(cfg, chain, poolKey, token, tokenDecimals, quote) {
  const client = chains.makeClient(chain);
  const amountIn = await buyAmountInQuote(cfg, chain, quote, client);
  const zeroForOne = poolKey.currency0.toLowerCase() === quote.address.toLowerCase();
  const { sqrtPriceX96 } = await chains.readPoolState(client, chain.poolManager, poolKey.poolId);
  let expected = await quoteBuy(chain, poolKey, zeroForOne, amountIn);
  let minOut;
  if (expected !== null && expected > 0n) {
    minOut = (expected * 98n) / 100n; // 2% slippage
  } else {
    const spot = spotOutput(amountIn, sqrtPriceX96, tokenDecimals, quote.decimals, zeroForOne);
    minOut = (spot * 80n) / 100n; // 20% buffer (LP fee + hook fee + impact)
    if (minOut <= 0n) throw new Error("computed amountOutMinimum is 0 — pool too thin or price unreadable");
  }
  const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const txs = [];
  // Wrap step ONLY when the quote is the wrapped native (WETH/WPOL/WBNB).
  // Stablecoin quotes (USDC/EURC/USDg) and Arc's native USDC need no wrap.
  const isWrappedNative = chain.wrappedNative && chain.wrappedNative.address.toLowerCase() === quote.address.toLowerCase();
  if (isWrappedNative) {
    txs.push({ label: `wrap ${chain.nativeSymbol}->${quote.symbol}`, to: quote.address, value: toHex(amountIn), data: "0xd0e30db0" }); // deposit()
  }
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.permit2, amountIn] });
  const permit2Data = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [quote.address, chain.universalRouter, amountIn, expiration] });
  const { data: execData, deadline } = buildRouterExecuteFor(chain, poolKey, zeroForOne, amountIn, minOut, quote.address, token);
  txs.push(
    { label: `approve ${quote.symbol}->Permit2`, to: quote.address, value: "0x0", data: approveData },
    { label: `Permit2 approve ${quote.symbol}->Router`, to: chain.permit2, value: "0x0", data: permit2Data },
    { label: "router execute V4_SWAP (buy)", to: chain.universalRouter, value: "0x0", data: execData },
  );
  return { amountIn: amountIn.toString(), amountOutMinimum: minOut.toString(), deadline, txs };
}

// ---- SELL: token -> quote. Pure calldata builder (no send). ----
async function buildSell(cfg, chain, poolKey, token, tokenDecimals, quote, amountToken) {
  const client = chains.makeClient(chain);
  const zeroForOne = poolKey.currency0.toLowerCase() === token.toLowerCase();
  const { sqrtPriceX96 } = await chains.readPoolState(client, chain.poolManager, poolKey.poolId);
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const price = ratio * ratio; // raw token1 per raw token0 — no decimal factor (see spotOutput note)
  const spotOut = BigInt(Math.floor(zeroForOne ? Number(amountToken) * price : Number(amountToken) / price));
  let expected = null;
  try {
    const [out] = await client.readContract({
      address: chain.v4Quoter, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks], zeroForOne, amountToken, "0x"],
    });
    expected = BigInt(out);
  } catch { expected = null; }
  let minOut;
  if (expected !== null && expected > 0n) minOut = (expected * 98n) / 100n;
  else {
    minOut = (spotOut * 80n) / 100n;
    if (minOut <= 0n) throw new Error("computed sell amountOutMinimum is 0");
  }
  const expiration = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [chain.permit2, amountToken] });
  const permit2Data = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, chain.universalRouter, amountToken, expiration] });
  const { data: execData, deadline } = buildRouterExecuteFor(chain, poolKey, zeroForOne, amountToken, minOut, token, quote.address);
  return {
    amountIn: amountToken.toString(), amountOutMinimum: minOut.toString(), deadline,
    txs: [
      { label: "approve token->Permit2", to: token, value: "0x0", data: approveData },
      { label: "Permit2 approve token->Router", to: chain.permit2, value: "0x0", data: permit2Data },
      { label: "router execute V4_SWAP (sell)", to: chain.universalRouter, value: "0x0", data: execData },
    ],
  };
}

// ---- THE LIVE GATE. Refuses unless every condition holds. ----
function assertLiveAllowed(cfg, chain, opts) {
  if (cfg.live !== true) throw new Error("LIVE REFUSED: config.live is false (dry-run mode)");
  if (chain.live !== true) throw new Error(`LIVE REFUSED: chain ${chain.name} (${chain.chainId}) live flag is false`);
  if (chain.enabled !== true) throw new Error(`LIVE REFUSED: chain ${chain.name} (${chain.chainId}) is disabled in config`);
  if (chain.executionBlocked) throw new Error(`LIVE REFUSED: ${chain.name} execution is blocked — ${chain.executionBlockedReason || ""}`);
  if (!opts || opts.liveConfirm !== true) throw new Error("LIVE REFUSED: caller must pass { liveConfirm: true }");
}

// ---- POLYGON execution path (chain 137 ONLY) ----
// Privy CLI broadcast fails on Polygon; sign via eth_signTransaction and
// broadcast the raw tx via the chain's public RPC (proven shape from the
// 2026-11-06 setAgentURI run — see the header comment).
const POLYGON_CHAIN_ID = 137;
const POLYGON_MAX_GAS_GWEI = 100n; // refuse to send above this gas price
const POLYGON_RESERVE_WEI = 160000000000000000n; // 0.16 POL setAgentURI reserve (floor)
const POLYGON_MIN_TIP_WEI = 25000000000n; // 25 gwei, Polygon minimum tip
const POLYGON_ROUTER_EXECUTE_GAS_FALLBACK = 600000n; // router execute reverts
// under eth_estimateGas without a live allowance, so estimation cannot
// price it — use this fixed limit (V4 swaps run ~200-450k) instead.

function hexBig(n) { return "0x" + BigInt(n).toString(16); }

// Current base fee + tip, with ~20% headroom, for the sign params.
async function polygonFeeParams(client) {
  let baseFee;
  try {
    const fh = await client.getFeeHistory({ blockCount: 1, blockTag: "latest", rewardPercentiles: [25] });
    baseFee = BigInt(fh.baseFeePerGas[fh.baseFeePerGas.length - 1]);
  } catch {
    baseFee = await client.getGasPrice(); // fallback: effective gas price
  }
  const maxFee = ((baseFee + POLYGON_MIN_TIP_WEI) * 120n) / 100n;
  return { baseFee, maxFeePerGas: maxFee, maxPriorityFeePerGas: POLYGON_MIN_TIP_WEI };
}

// Sign ONE tx via the Privy CLI (eth_signTransaction). Returns the signed
// raw transaction hex (0x...). Signs only — NEVER broadcasts. The CLI
// response shape is read defensively: data.rawTransaction, data.raw, or
// data.signedTransaction, else a bare string payload.
function signTxPolygon(cfg, chain, tx, nonce, feeParams, gasLimit) {
  const body = {
    method: "eth_signTransaction",
    params: { transaction: {
      from: cfg.agent,
      to: tx.to,
      value: tx.value || "0x0",
      data: tx.data,
      chain_id: chain.chainId,
      nonce,
      gas_limit: hexBig(gasLimit),
      max_fee_per_gas: hexBig(feeParams.maxFeePerGas),
      max_priority_fee_per_gas: hexBig(feeParams.maxPriorityFeePerGas),
    } },
  };
  const res = privyRpc(body);
  const d = res?.data;
  // CLI returns data.signed_transaction (snake_case) — observed 2026-11-07.
  const raw = (d && (d.signed_transaction || d.rawTransaction || d.raw || d.signedTransaction)) || (typeof d === "string" ? d : null);
  if (!raw || typeof raw !== "string" || !raw.startsWith("0x")) {
    throw new Error("Privy eth_signTransaction did not return a raw tx: " + JSON.stringify(res).slice(0, 300));
  }
  return raw;
}

// Broadcast a signed raw tx via the chain's public RPC. Returns the hash.
async function broadcastRawPolygon(client, rawTx) {
  return client.sendRawTransaction({ serializedTransaction: rawTx });
}

// Polygon guards, checked per tx BEFORE signing. Throws (nothing sent) when
// the tx must not go out. `valueWei` is the tx's native value (wrap
// principal); gas cost is priced at maxFeePerGas (worst case).
async function polygonGuardCheck(cfg, chain, client, valueWei, gasLimit, feeParams) {
  const gasPrice = await client.getGasPrice();
  if (gasPrice > POLYGON_MAX_GAS_GWEI * 1000000000n) {
    throw new Error(`POLYGON GAS-SKIP: gas price ${gasPrice} wei exceeds ${POLYGON_MAX_GAS_GWEI} gwei ceiling — not sending`);
  }
  const balance = await client.getBalance({ address: cfg.agent });
  const worstCost = BigInt(valueWei) + BigInt(gasLimit) * BigInt(feeParams.maxFeePerGas);
  if (balance - worstCost < POLYGON_RESERVE_WEI) {
    throw new Error(`POLYGON RESERVE-SKIP: balance ${balance} minus this tx (value ${valueWei} + gas ${BigInt(gasLimit) * BigInt(feeParams.maxFeePerGas)}) would fall below the 0.16 POL setAgentURI reserve — not sending`);
  }
  return { balance: balance.toString(), gasPrice: gasPrice.toString() };
}

// Polygon execute: sign each tx via Privy, broadcast raw via public RPC.
// Only reachable when assertLiveAllowed passes (live flags on AND
// executionBlocked removed). Any guard failure throws before that tx is
// signed, and the bundle stops — a failed tx never counts as a snipe.
async function executeTxsPolygon(cfg, chain, txs, opts) {
  const client = chains.makeClient(chain);
  const feeParams = await polygonFeeParams(client);
  let nonce = await client.getTransactionCount({ address: cfg.agent, blockTag: "pending" });
  const results = [];
  for (const tx of txs) {
    const valueWei = BigInt(tx.value || "0x0");
    let gasLimit;
    try {
      const est = await client.estimateGas({ account: cfg.agent, to: tx.to, data: tx.data, value: valueWei });
      gasLimit = (est * 120n) / 100n; // 20% headroom
    } catch (e) {
      if (tx.label && tx.label.includes("router execute")) {
        gasLimit = POLYGON_ROUTER_EXECUTE_GAS_FALLBACK; // estimation reverts without allowance
      } else {
        throw new Error(`gas estimation failed for ${tx.label}: ${e.message.slice(0, 150)}`);
      }
    }
    await polygonGuardCheck(cfg, chain, client, valueWei, gasLimit, feeParams);
    const raw = signTxPolygon(cfg, chain, tx, nonce, feeParams, gasLimit);
    const hash = await broadcastRawPolygon(client, raw);
    nonce += 1;
    const receipt = await waitReceipt(client, hash);
    if (receipt.status !== "success") throw new Error(`tx ${tx.label} failed: ${hash} status ${receipt.status}`);
    results.push({ label: tx.label, hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(), via: "polygon-sign-broadcast" });
  }
  return results;
}

async function executeTxs(cfg, chain, txs, opts) {
  assertLiveAllowed(cfg, chain, opts);
  if (chain.chainId === POLYGON_CHAIN_ID) return executeTxsPolygon(cfg, chain, txs, opts);
  const client = chains.makeClient(chain);
  const results = [];
  for (const tx of txs) {
    const hash = sendTx(cfg, chain, tx);
    const receipt = await waitReceipt(client, hash);
    if (receipt.status !== "success") throw new Error(`tx ${tx.label} failed: ${hash} status ${receipt.status}`);
    results.push({ label: tx.label, hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString() });
  }
  return results;
}

module.exports = { buildBuy, buildBuyNative, buildSell, buildSellNative, nativeEthQuote, ZERO_ADDRESS, buildRouterExecute, buildRouterExecuteV2, buildRouterExecuteFor, executeTxs, sendTx, waitReceipt, buyAmountInQuote, quoteMultiplier, checkQuoteBalance, assertLiveAllowed, APPROX_USD_PRICE, signTxPolygon, broadcastRawPolygon, polygonGuardCheck, polygonFeeParams, executeTxsPolygon, POLYGON_CHAIN_ID, POLYGON_MAX_GAS_GWEI, POLYGON_RESERVE_WEI, POLYGON_MIN_TIP_WEI, POLYGON_ROUTER_EXECUTE_GAS_FALLBACK, spotOutput };
