// copy-trade.js — real copy-trader for the sniper (Part 57, 2026-11-09).
//
// Mirrors the 8 watchlisted smart-money wallets' buys on Robinhood Chain
// (chainId 4663). $0.02 per copy-buy. Safety-first is the top rule.
//
// Design (decided after the Part 54/55 research and live tests):
//   * Detection PRIMARY: GMGN read-only API /v1/user/smartmoney (chain=
//     robinhood). Proven live from this VM (HTTP 200, ~100 trades / 69 min
//     window, newest 43s old). Gives maker, side, token, USD amount and the
//     maker's remaining balance directly — V4 and V3 in one feed. The
//     wallet_address filter is IGNORED by GMGN (Part 54), so we pull the
//     unfiltered feed and filter client-side against the watchlist.
//   * Detection FALLBACK: onchain V4 Swap scan (PoolManager, fork Swap
//     topic 0x40e9cecb...). Proven live: 1,435 Swap logs / 1,169 unique txs
//     per 2-min window, ~24 batched RPC calls/cycle. Used only when GMGN
//     is down — V4 only (V3 swaps emit on individual pool contracts, no
//     central log; GMGN is the only cheap V3 route).
//   * NEVER trust GMGN attribution on its own (the ACTUARY case — GMGN
//     once attributed a buy to the wrong wallet): every candidate is
//     verified ONCHAIN before any buy — the tx receipt's `from` must equal
//     the watchlisted maker, and Transfer events must show the maker
//     NET-RECEIVED the token (a buy, not a sell).
//   * Copies are NOT subject to the sniper's token-age / min-500 / score
//     gates — they mirror a human's pick. They ARE subject to the safety
//     gates (GoPlus, holders, known-rug, transfer-sim, quoter sell-sim).
//     Any gate failure = NO buy, no matter who bought it.
//   * Sells: the sniper's proven price rules (sell 50% at +100%, all at
//     -50%) manage positions by default. Mirror-sells (exit when a
//     watchlisted wallet sells a token we hold) are BUILT in Part 59:
//     a verified sell of a held token sells our FULL position via the
//     same proven builders. Gated behind state.mirrorExit (default
//     false, NEVER flipped by this module) — the runner logs
//     SELL-SIGNAL-SKIP while it is off. A sell signal ATTEMPTS the
//     sell even on a sellBlocked position: the flag used to false-positive
//     (simSellRoute reverted on a fresh position with no allowances —
//     TAFO/FAWBO/BANK were flagged but sold fine for real). Fixed
//     2026-11-11: the sim now checks allowances/helper funding first and
//     returns inconclusive instead of flagging, so only a revert WITH the
//     preconditions in place proves the hook really blocks.
//   * HARD LIMIT: no live transaction leaves this module unless
//     state.live === true AND opts.liveConfirm === true. The runner
//     (copy-trade-run.js) defaults to DRY-RUN. The live cron is NOT
//     created by this build — the parent activates it. The buy size is
//     read from cfg.buySizeUsd and is ASSERTED to be 0.02.
//
// Safety gates that live here (all run BEFORE any buy):
//   1. GoPlus honeypot/tax check (fail-open on API failure, HARD fail on
//      is_honeypot / tax > 5% / hidden owner / proxy / take-back /
//      deployer-with-honeypot-history). GoPlus's creator is also the
//      deployer fallback for the known-rug check (V3 pools have no cheap
//      onchain deployer lookup).
//   2. Known-rug veto (registries.checkKnownRugLive) — scammer deployer
//      0x333089e0... + fake-POL token 0xe174c72d... (Part 50).
//   3. Holder-concentration check (holders.scoreHolders). HARD fail only
//      at the worst band (points <= -10, i.e. multiple severe flags);
//      anything milder is a logged warning, not a block (fresh pools are
//      concentrated by construction).
//   4. Transfer simulation (eth_call transfer from the pool holder) —
//      the ANT lesson: ANT's transfer is OWNER-GATED, so a transfer sim
//      from any holder reverts. If it reverts, the token is unmovable.
//   5. Quoter buy+sell sim (V4 only) — the token must be quotable both
//      ways with sell returning >= 50% of buy input. If the quoter reverts
//      (hook), the transfer sim (4) is the fallback, as in evaluate.js.
//   The debtdog lesson (hook blocks OUR Universal Router sell while
//   others sell fine) CANNOT be caught pre-buy: a router execute sim
//   needs the agent to hold the token + have allowances, which only
//   exists AFTER a buy. So v1 runs a POST-BUY sell-route sim
//   (simSellRoute) seconds after each copy-buy, with the agent's real
//   balance and allowances; a revert there flags the position
//   sellBlocked immediately. Max loss from that gap is one $0.02 buy +
//   its gas (~$0.013). This is documented honestly in the report.
//
// Fee accounting: every buy/sell is costed net of gas + LP fee + hook
// fee. Real Robinhood gas (from mined receipts, 2026-11-09, 0.02 gwei,
// ETH $2,094.61): V4 buy = 4 txs (wrap 53,365 + approve 46,161 +
// permit2 47,662 + execute ~150,000-171,000) ≈ $0.0124-0.0133; V4 sell
// = 3 txs ≈ $0.0111. Round trip ≈ $0.0235-0.0244 — ~118% of a $0.02
// buy. Break-even is ~2.4x (no hook) / ~2.5x (3% hook). A 2x winner
// still LOSES ~$0.004. The report states this plainly.
//
// Part 58 (2026-11-09) — native-ETH path (Gap 1), holders retry (Gap 2),
// quoter ABI fix, live-gate verification (Gap 3):
//   * Native-ETH V4 pools (currency 0x0) are now VERIFIED (isNative)
//     and BUILT (trade.buildBuyNative: one router execute with
//     msg.value; trade.buildSellNative: token -> ETH). The path is
//     gated behind state.nativeEthLive (default false, NEVER flipped
//     by this module) — a native buy needs state.live AND --live AND
//     liveConfirm AND nativeEthLive. The runner logs NATIVE-SKIP and
//     records outcome "native-skip" while the flag is off.
//   * V3 has no native path: V3 pools are ERC-20 pairs by
//     construction, and V3SwapHelper has no receive/fallback and
//     reverts ZeroAddress on a 0x0 token. The existing wrap-then-helper
//     path IS the V3 native-equivalent (WETH side).
//   * Quoter ABI fixed (2-arg -> canonical 4-arg); the Robinhood fork
//     quoter still reverts on every pool type, so the gate quoter
//     check warns and the transfer-sim is the backstop.
//   * Holders check retries once (doubled timeout) on inconclusive;
//     a timeout is UNKNOWN, never clean, never a hard block.

const { createPublicClient, http, parseAbi, encodeFunctionData } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const trade = require("./trade.js");
const v3helper = require("./v3-helper-trade.js");
const v3mod = require("./v3.js");
const { scoreGoPlus } = require("./goplus.js");
const { scoreHolders } = require("./holders.js");
const { checkKnownRugLive } = require("./registries.js");
const sm = require("./smart-money.js");
const cfg = require("./config.json");

const GMGN_BASE = "https://openapi.gmgn.ai";
const GMGN_KEY = process.env.GMGN_API_KEY || "gmgn_solbscbaseethmonadtron";
const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V4_SWAP_TOPIC0_FORK = sm.V4_SWAP_TOPIC0_FORK;
const V4_SWAP_TOPIC0_CANON = sm.V4_SWAP_TOPIC0_CANON;
const V3_SWAP_TOPIC0 = sm.V3_SWAP_TOPIC0;
const INITIALIZE_TOPIC0 = chains.INITIALIZE_TOPIC0;
// Quoter ABI (Part 58 fix): chains.QUOTER_ABI is a 2-arg shape
// (poolKey, amountIn) that NO V4 quoter implements — the canonical
// quoteExactInputSingle is 4-arg (poolKey, zeroForOne, exactAmountIn,
// hookData), the same ABI trade.js and evaluate.js use. Passing 4 args
// to the 2-arg ABI throws a CLIENT-SIDE encoding error in viem
// ("params/values length mismatch"), so the gate's quoter check NEVER
// reached the contract — it always warned. This local 4-arg ABI makes
// the check well-formed. NOTE (Part 58, proven live): even with the
// correct ABI, the Robinhood fork quoter 0x8Dc178eF... reverts
// quoteExactInputSingle on EVERY pool type tested (native + non-native,
// hookless + liquid, bare empty revert) — so on Robinhood the quoter
// check will still WARN, and the transfer-sim is the real backstop.
// The fix matters for correctness, not for a live ratio.
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmountIn, bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const ERC20_MIN_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const PERMIT2_ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const HELPER_SWAP_ABI = parseAbi([
  "function swapExactInputSingle(address pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)",
]);

const lc = (a) => (a || "").toLowerCase();
const COPY_BUY_USD = 0.02; // asserted before every build

// --- native ETH (Part 58) ---------------------------------------------
// ~67% of Robinhood launches pair the token with NATIVE ETH (currency
// 0x0), not WETH. The native pseudo-quote is NOT in config.json's
// allowlist (there is no ERC-20 to verify) — it is constructed here
// and accepted explicitly in verifyCandidate. The buy size needs a
// LIVE ETH price: CoinGecko (keyless, 5s timeout), falling back to
// $2095 (last measured 2026-11-09). trade.js's APPROX_USD_PRICE.ETH
// (2243) is stale (+6%) and is NOT used for native sizing. Cached
// per-process so one runner cycle fetches at most once.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NATIVE_ETH_QUOTE = { address: ZERO_ADDRESS, symbol: "ETH", decimals: 18 };
const ETH_USD_FALLBACK = 2095;
let _ethUsdCache = null;
async function getEthUsd() {
  if (_ethUsdCache) return _ethUsdCache;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json();
    const p = j && j.ethereum && Number(j.ethereum.usd);
    if (p && p > 0) { _ethUsdCache = p; return p; }
  } catch { /* fall through to the fallback */ }
  return ETH_USD_FALLBACK;
}

// The raw config chain has no chainId field (enabledChains adds it).
// This helper returns the Robinhood chain object the sniper uses.
function getChain() {
  const c = chains.loadConfig().chains["4663"];
  return { chainId: 4663, ...c };
}

// --- fee model (measured, not assumed) -------------------------------
// Robinhood gas price is ~0.02 gwei. Gas per tx from mined receipts
// (2026-11-09): wrap 53,365 | approve 46,161 | permit2 47,662 |
// V4 execute 149,882-170,844. ETH price at measurement: $2,094.61.
const MEASURED_GAS = {
  wrap: 53365,
  approve: 46161,
  permit2: 47662,
  v4Execute: 160000, // midpoint of the two mined executes
  nativeV4Execute: 124829, // Part 58: eth_call ESTIMATE for a native
  // buy execute (single tx, no Permit2 pull) on a live Robinhood pool
  // — NOT a mined receipt yet. The native buy is cheaper than the
  // WETH execute because there is no wrap/approve/Permit2 and the
  // settle pulls from msg.value. Re-measure from a mined receipt
  // after the first live native buy.
  v3HelperFund: 60000,
  v3HelperSwap: 300000,
};
const ROBINHOOD_GAS_GWEI = 0.02;

function gasUsd(gas, ethUsd, gwei = ROBINHOOD_GAS_GWEI) {
  return Number(gas) * gwei * 1e-9 * ethUsd;
}

// --- GMGN feed --------------------------------------------------------
// GET /v1/user/smartmoney?chain=robinhood&limit=100&timestamp=...
// Returns data.list[] with { transaction_hash, maker, side,
// base_address, base_token: {symbol}, quote_amount, token_amount,
// amount_usd, price_usd, timestamp, balance, is_open_or_close }.
// The `chain` param is REQUIRED (no chain -> HTTP 400). The
// wallet_address filter is IGNORED by GMGN — filter client-side.
async function fetchGmgnFeed(chainName = "robinhood", limit = 100) {
  const ts = String(Date.now());
  const url =
    `${GMGN_BASE}/v1/user/smartmoney?chain=${encodeURIComponent(chainName)}` +
    `&limit=${limit}&timestamp=${ts}&client_id=copy-trade`;
  const res = await fetch(url, {
    headers: { "X-APIKEY": GMGN_KEY, "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`GMGN feed HTTP ${res.status}`);
  const j = await res.json();
  const list = j && j.data && Array.isArray(j.data.list) ? j.data.list : [];
  return list;
}

// Filter a GMGN feed list to new watchlist BUYS. `seen` is a Set of
// tx hashes already processed (from state). Returns candidate objects.
function detectCandidates(feedTrades, watchSet, seen) {
  const out = [];
  for (const t of feedTrades || []) {
    const hash = lc(t.transaction_hash);
    const maker = lc(t.maker);
    if (!hash || !maker) continue;
    if (!watchSet.has(maker)) continue;
    if (seen && seen.has(hash)) continue;
    if (lc(t.side) !== "buy") continue; // sells go through detectSellCandidates (Part 59)
    out.push({
      txHash: hash,
      wallet: maker,
      token: lc(t.base_address),
      symbol: (t.base_token && t.base_token.symbol) || "?",
      amountUsd: Number(t.amount_usd || 0),
      tokenAmount: Number(t.token_amount || 0),
      priceUsd: Number(t.price_usd || 0),
      makerBalanceAfter: Number(t.balance || 0),
      timestamp: Number(t.timestamp || 0),
      source: "gmgn",
    });
  }
  return out;
}

// Filter a GMGN feed list to new watchlist SELLS (Part 59, mirror-exit).
// Same shape as detectCandidates. A sell is actionable only when we
// HOLD a copy position in the token — the runner checks that
// (handleSellSignal); this function only filters side + watchlist +
// unseen. Sells of tokens we do not hold are noted-only, never acted on.
function detectSellCandidates(feedTrades, watchSet, seen) {
  const out = [];
  for (const t of feedTrades || []) {
    const hash = lc(t.transaction_hash);
    const maker = lc(t.maker);
    if (!hash || !maker) continue;
    if (!watchSet.has(maker)) continue;
    if (seen && seen.has(hash)) continue;
    if (lc(t.side) !== "sell") continue;
    out.push({
      txHash: hash,
      wallet: maker,
      token: lc(t.base_address),
      symbol: (t.base_token && t.base_token.symbol) || "?",
      amountUsd: Number(t.amount_usd || 0),
      tokenAmount: Number(t.token_amount || 0),
      priceUsd: Number(t.price_usd || 0),
      makerBalanceAfter: Number(t.balance || 0),
      timestamp: Number(t.timestamp || 0),
      source: "gmgn",
    });
  }
  return out;
}

// --- Initialize lookup (V4 PoolKey) -----------------------------------
// The PoolKey (fee, tickSpacing, hooks, currencies) lives only in the
// Initialize event. Search backwards from `toBlock` in stages (50k ->
// 500k -> 2M blocks). Stops at the first hit. Returns the decoded
// Initialize log or null. Pools older than ~2M blocks (~2.3 days) are
// NOT copyable in v1 — documented limitation; the v2 fix is a
// persistent PoolKey registry fed by the sniper's own pool discovery.
async function findInitialize(client, chain, poolId, toBlock) {
  const stages = [50000n, 500000n];
  for (const span of stages) {
    const from = BigInt(toBlock) - span > 0n ? BigInt(toBlock) - span : 0n;
    try {
      const logs = await chains.rawGetLogs(client, {
        address: chain.poolManager,
        topics: [INITIALIZE_TOPIC0, poolId],
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + BigInt(toBlock).toString(16),
      });
      if (logs && logs.length > 0) return chains.decodeInitialize(logs[0]);
    } catch (e) {
      // A stage failing (RPC hiccup) is not fatal — try the next stage.
      continue;
    }
  }
  // 2M-block stage, CHUNKED in 400k pieces: a single 2M-block
  // eth_getLogs call 429s on the Robinhood RPC (proven 2026-11-09), so
  // the unchunked stage never worked — the effective window was ~500k
  // blocks (~14h), not the documented ~2M (~2.3 days). Chunks scan
  // newest-first and stop at the first hit (one Initialize per poolId).
  // Each chunk retries 3x with backoff: the RPC 429s wide scans
  // intermittently, and a single 429 must not kill the whole lookup.
  const CHUNK = 400000n;
  const floor = BigInt(toBlock) - 2000000n > 0n ? BigInt(toBlock) - 2000000n : 0n;
  let end = BigInt(toBlock) - 500000n;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (end > floor) {
    const start = end - CHUNK > floor ? end - CHUNK : floor;
    let logs = null;
    for (let attempt = 0; attempt < 3 && logs === null; attempt++) {
      try {
        logs = await chains.rawGetLogs(client, {
          address: chain.poolManager,
          topics: [INITIALIZE_TOPIC0, poolId],
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
        });
      } catch (e) {
        if (attempt < 2) await sleep(3000 * (attempt + 1));
      }
    }
    if (logs && logs.length > 0) return chains.decodeInitialize(logs[0]);
    end = start;
  }
  return null;
}

// --- onchain verification --------------------------------------------
// Verifies a GMGN candidate against the mined receipt. Never trust GMGN
// attribution alone: the receipt's `from` must equal the watchlisted
// maker, and Transfer events must show the maker NET-RECEIVED the token.
// Returns { ok, ... } with poolType 'v4'|'v3', poolKey (V4) or pool
// (V3), quote, deployer, poolBlock, direction — or { ok:false, reason }.
async function verifyCandidate(client, chain, cand) {
  const base = { ok: false, txHash: cand.txHash, wallet: cand.wallet, token: cand.token };
  let rc;
  try {
    rc = await client.getTransactionReceipt({ hash: cand.txHash });
  } catch (e) {
    return { ...base, reason: "receipt fetch failed: " + e.message.slice(0, 80) };
  }
  if (!rc) return { ...base, reason: "no receipt (tx not mined yet)" };
  if (rc.status !== "success") return { ...base, reason: "tx reverted onchain" };
  const from = lc(rc.from);
  if (from !== cand.wallet) {
    return { ...base, reason: `receipt from ${from} != watchlisted maker ${cand.wallet} (GMGN misattribution)` };
  }
  // Direction from Transfer events on the token (net received = buy).
  let received = 0n, sent = 0n;
  let swapLog = null;
  for (const log of rc.logs || []) {
    const t0 = lc(log.topics && log.topics[0]);
    if (t0 === TRANSFER_TOPIC0 && lc(log.address) === cand.token) {
      const fromAddr = "0x" + (log.topics[1] || "").slice(-40);
      const toAddr = "0x" + (log.topics[2] || "").slice(-40);
      const val = BigInt(log.data || "0x0");
      if (lc(toAddr) === cand.wallet) received += val;
      if (lc(fromAddr) === cand.wallet) sent += val;
    }
    if ((t0 === lc(V4_SWAP_TOPIC0_FORK) || t0 === lc(V4_SWAP_TOPIC0_CANON)) && lc(log.address) === lc(chain.poolManager)) {
      swapLog = { kind: "v4", poolId: log.topics[1] };
    }
    if (t0 === lc(V3_SWAP_TOPIC0) && lc(log.address) !== lc(chain.poolManager) && !swapLog) {
      swapLog = { kind: "v3", pool: lc(log.address) };
    }
  }
  const net = received - sent;
  if (net < 0n) {
    // SELL (Part 59, mirror-exit): the maker net-sent the token. A
    // sell is a real signal, not a reject — but only the runner can
    // act on it (it needs a HELD copy position, and the pool comes
    // from the position, not this tx). Require a Swap event so a plain
    // Transfer (gift, consolidation) is not mistaken for a sell. No
    // hold guard / deployer / quote checks here: the maker just sold
    // (balance may be 0) and the position supplies the pool.
    if (!swapLog) {
      return { ...base, reason: "maker NET-SENT the token but no V4/V3 Swap event in the receipt (plain transfer, not a sell)" };
    }
    return {
      ...base, ok: true, direction: "sell", netSentRaw: -net,
      poolId: swapLog.poolId || null, poolAddress: swapLog.pool || null,
      poolType: swapLog.kind, poolBlock: Number(rc.blockNumber),
      symbol: cand.symbol, amountUsd: cand.amountUsd,
    };
  }
  if (net === 0n) {
    return { ...base, reason: "no net Transfer to the maker on this token — cannot confirm a buy" };
  }
  if (!swapLog) {
    return { ...base, reason: "no V4 (PoolManager) or V3 Swap event in the receipt" };
  }

  const out = {
    ...base, ok: true, direction: "buy", netReceivedRaw: net,
    poolType: swapLog.kind, poolBlock: Number(rc.blockNumber),
    symbol: cand.symbol, amountUsd: cand.amountUsd,
  };

  if (swapLog.kind === "v4") {
    const poolId = swapLog.poolId;
    out.poolId = poolId;
    const dec = await findInitialize(client, chain, poolId, rc.blockNumber);
    if (!dec) {
      return { ...base, reason: "no Initialize event for poolId " + poolId + " in the last 2M blocks (cannot build PoolKey safely)" };
    }
    out.poolKey = {
      poolId: dec.poolId, currency0: dec.currency0, currency1: dec.currency1,
      fee: dec.fee, tickSpacing: dec.tickSpacing, hooks: dec.hooks,
    };
    out.pool = {
      id: dec.poolId, fee: dec.fee, tickSpacing: dec.tickSpacing, hooks: dec.hooks,
      currency0: dec.currency0, currency1: dec.currency1, txHash: dec.txHash,
    };
    out.poolBlock = dec.blockNumber;
    out.hooks = dec.hooks;
    // POOL/TOKEN MEMBERSHIP (fix 2026-11-09): the receipt can be a
    // multi-hop tx whose LAST V4 Swap is a different leg than the one
    // where the candidate token was bought — proven live on PUSSYCOIN
    // tx 0xed72728f… (V3 WETH/NVDA pool + V4 PUSSYCOIN leg in one tx).
    // Without this check the ternary below silently treats the wrong
    // currency as the quote and the buy build would buy the WRONG
    // token. A mismatch is a REJECT (safe direction: a missed copy,
    // never a wrong buy).
    if (lc(dec.currency0) !== lc(cand.token) && lc(dec.currency1) !== lc(cand.token)) {
      return { ...base, reason: `token ${cand.token} is not a currency of V4 pool ${poolId.slice(0, 18)}… (multi-hop tx — pool/token mismatch, refusing to build)` };
    }
    // Deployer = the Initialize tx sender.
    try {
      const rcInit = await client.getTransactionReceipt({ hash: dec.txHash });
      out.deployer = lc(rcInit.from);
    } catch { out.deployer = null; }
    const quoteAddr = lc(dec.currency0) === cand.token ? dec.currency1 : dec.currency0;
    out.quote = lc(quoteAddr);
  } else {
    // V3: pool contract is the Swap log address. Read its identity.
    out.poolAddress = swapLog.pool;
    let st;
    try {
      st = await v3mod.readV3PoolState(client, swapLog.pool);
    } catch (e) {
      return { ...base, reason: "pool at " + swapLog.pool + " does not read as a V3 pool: " + e.message.slice(0, 80) };
    }
    out.pool = {
      pool: swapLog.pool, fee: st.fee, tickSpacing: st.tickSpacing,
      token0: st.token0, token1: st.token1, sqrtPriceX96: st.sqrtPriceX96,
      liquidity: st.liquidity, tick: st.tick,
    };
    out.hooks = null;
    // POOL/TOKEN MEMBERSHIP (fix 2026-11-09, same as the V4 path):
    // a multi-hop tx can carry a V3 Swap on a pool that does not
    // contain the candidate token (proven live: PUSSYCOIN tx
    // 0xed72728f… pairs the token with the WETH/NVDA V3 pool
    // 0x62ab521f…). Without this check the quote ternary below
    // defaults wrongly and the build would buy the wrong token.
    if (lc(st.token0) !== lc(cand.token) && lc(st.token1) !== lc(cand.token)) {
      return { ...base, reason: `token ${cand.token} is not a currency of V3 pool ${swapLog.pool} (multi-hop tx — pool/token mismatch, refusing to build)` };
    }
    out.quote = st.token0 === cand.token ? st.token1 : st.token0;
    // V3 deployer: no cheap onchain lookup (PoolCreated scan is a wide
    // window). Leave null; gateToken falls back to GoPlus's creator.
    out.deployer = null;
  }

  // Quote must be a verified quote in the chain config (else skip) —
  // EXCEPT native ETH (0x0), which is the native-ETH path (Part 58).
  // A native pool is accepted here and flagged isNative; the runner
  // still refuses to build it unless state.nativeEthLive is true.
  // V3 pools can never have a native currency (ERC-20 pairs only), so
  // a 0x0 quote on V3 is a reject, not a native buy.
  const quotes = (chain.quotes || []).map((q) => lc(q.address));
  if (lc(out.quote) === ZERO_ADDRESS) {
    if (swapLog.kind === "v3") {
      return { ...base, ok: false, reason: "V3 pool quote is native ETH (0x0) — V3 pools are ERC-20 pairs only, refusing (pool/token mismatch or bad decode)" };
    }
    out.isNative = true;
    const ethUsd = await getEthUsd();
    out.quoteInfo = { ...NATIVE_ETH_QUOTE, approxUsdPrice: ethUsd };
  } else if (!quotes.includes(out.quote)) {
    return { ...base, ok: false, reason: `quote ${out.quote} is not in the verified quote allowlist for chain ${chain.chainId}` };
  } else {
    out.quoteInfo = chain.quotes.find((q) => lc(q.address) === out.quote);
  }

  // Token decimals (needed by the buy builders).
  try {
    out.decimals = Number(await client.readContract({ address: cand.token, abi: ERC20_MIN_ABI, functionName: "decimals" }));
  } catch {
    return { ...base, reason: "decimals() unreadable — token is not a readable ERC-20" };
  }

  // Hold guard: the wallet must still hold the token.
  try {
    const bal = await client.readContract({ address: cand.token, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [cand.wallet] });
    out.makerBalanceRaw = BigInt(bal);
    if (BigInt(bal) === 0n) return { ...base, ok: false, reason: "wallet no longer holds the token (sold out before we verified)" };
  } catch (e) {
    return { ...base, reason: "balanceOf(maker) unreadable: " + e.message.slice(0, 80) };
  }
  // Maker must not be the deployer (self-buy).
  if (out.deployer && out.deployer === cand.wallet) {
    return { ...base, ok: false, reason: "maker IS the deployer (self-buy, not a signal)" };
  }
  return out;
}

// --- onchain V4 Swap scan (GMGN fallback, V4 only) -------------------
// Scans PoolManager Swap logs in [fromBlock, toBlock], batch-fetches
// each tx's sender (50/call), returns watchlist txs. Callers must still
// run verifyCandidate on each hit (it re-checks the receipt + direction).
async function scanOnchainBuys(client, chain, watchSet, fromBlock, toBlock) {
  const logs = await chains.rawGetLogs(client, {
    address: chain.poolManager,
    topics: [V4_SWAP_TOPIC0_FORK],
    fromBlock: "0x" + BigInt(fromBlock).toString(16),
    toBlock: "0x" + BigInt(toBlock).toString(16),
  });
  const txs = [...new Set((logs || []).map((l) => l.transactionHash))];
  const poolByTx = {};
  for (const l of logs || []) poolByTx[l.transactionHash] = l.topics[1];
  const senders = {};
  for (let i = 0; i < txs.length; i += 50) {
    const batch = txs.slice(i, i + 50).map((h, j) => ({
      jsonrpc: "2.0", id: j, method: "eth_getTransactionByHash", params: [h],
    }));
    const r = await fetch(chain.rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    const arr = await r.json();
    for (const item of arr) {
      if (item && item.result && item.result.from) senders[item.result.hash] = lc(item.result.from);
    }
  }
  const hits = [];
  for (const h of txs) {
    if (watchSet.has(senders[h])) hits.push({ txHash: lc(h), wallet: senders[h], poolId: poolByTx[h], source: "onchain-v4-scan" });
  }
  return { logs: (logs || []).length, txs: txs.length, hits };
}

// --- holder-concentration check with retry (Gap 2, Part 58) ---------
// scoreHolders is fail-open (never throws), but a TIMEOUT returns
// raw=null, which the old code logged as a plain WARN — indistinguishable
// from "no data" and, on the next run, real concentrated data could
// hard-FAIL. That is exactly what happened to debtdog (timeout WARN one
// run, real concentrated data hard-FAIL the next). Retry once with a
// doubled timeout; if still inconclusive, the status is UNKNOWN —
// fail-open, but explicitly NOT clean data. Returns
// { status: "clean"|"flagged"|"unknown", points, detail, raw, attempts }.
// Scoped to the copy-trader's gate path only — holders.js is untouched,
// so live v2/v3 sniper behavior cannot change.
async function gateHoldersWithRetry(client, chain, verified, opts = {}) {
  const baseMs = opts.holdersTimeoutMs || 30000;
  const args = {
    deployer: verified.deployer || opts.creator || null, poolBlock: verified.poolBlock, client,
    excludeAddresses: verified.poolType === "v4" ? [chain.poolManager] : [verified.poolAddress],
    timeoutMs: baseMs,
  };
  let h = await scoreHolders(chain, verified.token, args);
  let attempts = 1;
  if (!h.raw) {
    // Inconclusive (timeout or indexer/RPC outage) — retry once with a
    // doubled timeout before calling it unknown. Worst case this costs
    // baseMs + 2*baseMs (30s + 60s = 90s) for one candidate.
    h = await scoreHolders(chain, verified.token, { ...args, timeoutMs: baseMs * 2 });
    attempts = 2;
  }
  if (!h.raw) return { status: "unknown", points: h.points, detail: `holders UNKNOWN after ${attempts} attempt(s) (timeout/outage) — fail-open, NOT clean data: ${h.detail}`, raw: null, attempts };
  if (h.points <= -10) return { status: "flagged", points: h.points, detail: `holders ${h.points}: ${h.detail}`, raw: h.raw, attempts };
  return { status: "clean", points: h.points, detail: `holders ${h.points}: ${h.detail}`, raw: h.raw, attempts };
}

// --- safety gates ------------------------------------------------------
// Runs BEFORE any buy. Returns { pass, checks: [{ name, pass, detail }] }.
// Hard fails: GoPlus honeypot/tax, known-rug veto, transfer sim revert.
// Holder concentration is a hard fail only at the worst band (points
// <= -10); milder flags are warnings. Quoter sell sim is a hard fail
// only when the quoter works and the sell returns < 50%.
async function gateToken(client, chain, verified, opts = {}) {
  const checks = [];
  const token = verified.token;
  const pass = (name, detail) => { checks.push({ name, pass: true, detail }); };
  const warn = (name, detail) => { checks.push({ name, pass: true, warn: true, detail }); };

  // 1. GoPlus honeypot/tax (fail-open on API failure, hard fail on flags).
  // GoPlus's creator is also the deployer fallback for the known-rug
  // check (V3 pools have no cheap onchain deployer lookup).
  let creator = null;
  try {
    const gp = await scoreGoPlus(chain.chainId, token, { deployer: verified.deployer });
    const raw = gp.raw || {};
    creator = lc(raw.creator);
    // NOTE (2026-11-09, copy-trader bug fix): GoPlus returns "0"/"1"
    // STRINGS. The string "0" is truthy in JS, so the old code
    // `if (raw.isHoneypot)` flagged EVERY indexed token as a honeypot
    // (proven live: FOBO, $RMUSE, FLETCH, debtdog all returned
    // is_honeypot "0" from the API yet the gate failed them all).
    // Use isOne() — the same helper scoreFromRaw uses.
    const isOne = (v) => v === "1" || v === 1 || v === true;
    const flags = [];
    if (isOne(raw.isHoneypot)) flags.push("is_honeypot=1");
    const buyTax = Number(raw.buyTax ?? 0), sellTax = Number(raw.sellTax ?? 0);
    if (buyTax > 0.05) flags.push(`buyTax ${buyTax}`);
    if (sellTax > 0.05) flags.push(`sellTax ${sellTax}`);
    if (isOne(raw.hiddenOwner)) flags.push("hidden_owner=1");
    if (isOne(raw.isProxy)) flags.push("is_proxy=1");
    if (isOne(raw.canTakeBackOwnership)) flags.push("can_take_back_ownership=1");
    if (isOne(raw.honeypotWithSameCreator) && verified.deployer && creator && creator === lc(verified.deployer)) {
      flags.push("deployer previously made a honeypot");
    }
    if (flags.length) return { pass: false, checks: [...checks, { name: "goplus", pass: false, detail: "GoPlus flags: " + flags.join(", ") }] };
    if (!raw || Object.keys(raw).length === 0) {
      warn("goplus", "GoPlus returned nothing (fail-open): " + (gp.detail || ""));
    } else {
      pass("goplus", `clean (buyTax ${buyTax}, sellTax ${sellTax}, points ${gp.points})`);
    }
  } catch (e) {
    warn("goplus", "GoPlus errored (fail-open): " + e.message.slice(0, 60));
  }

  // 2. Known-rug veto (scammer deployer + fake-POL token).
  try {
    const deployer = verified.deployer || creator;
    const veto = await checkKnownRugLive({ deployer, token });
    if (veto && veto.veto) return { pass: false, checks: [...checks, { name: "known-rug", pass: false, detail: veto.reason }] };
    pass("known-rug", "no match in known-rug registry");
  } catch (e) {
    warn("known-rug", "registry check errored (fail-open): " + e.message.slice(0, 60));
  }

  // 3. Holder concentration (hard fail only at the worst band).
  // Retry-with-backoff wrapper (Gap 2): a timeout is UNKNOWN, never
  // clean and never a hard block on a transient error.
  try {
    const hr = await gateHoldersWithRetry(client, chain, verified, { holdersTimeoutMs: opts.holdersTimeoutMs || 30000, creator });
    if (hr.status === "flagged") {
      return { pass: false, checks: [...checks, { name: "holders", pass: false, status: "flagged", detail: hr.detail }] };
    }
    if (hr.status === "clean") pass("holders", hr.detail);
    else warn("holders", hr.detail); // unknown — fail-open, NOT clean
    checks[checks.length - 1].status = hr.status;
  } catch (e) {
    warn("holders", "holders errored (fail-open): " + e.message.slice(0, 60));
  }

  // 4. Transfer simulation — the ANT lesson. Sim a transfer of 1 whole
  // token (or the holder's full balance if smaller) FROM the pool holder
  // (PoolManager for V4, pool contract for V3) to the agent. If it
  // reverts, the token is transfer-blocked (owner-gated, honeypot).
  const holder = verified.poolType === "v4" ? chain.poolManager : verified.poolAddress;
  try {
    const holderBal = await client.readContract({ address: token, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [holder] });
    if (BigInt(holderBal) === 0n) {
      return { pass: false, checks: [...checks, { name: "transfer-sim", pass: false, detail: "pool holder holds 0 of the token — pool may be empty" }] };
    }
    const oneWhole = 10n ** BigInt(verified.decimals);
    const probe = BigInt(holderBal) < oneWhole ? BigInt(holderBal) : oneWhole;
    await client.simulateContract({
      address: token, abi: TRANSFER_ABI, functionName: "transfer",
      args: [cfg.agent, probe], account: holder,
    });
    pass("transfer-sim", `transfer of ${probe.toString()} from ${holder.slice(0, 10)}... SUCCEEDED — token is transferable`);
  } catch (e) {
    return { pass: false, checks: [...checks, { name: "transfer-sim", pass: false, detail: "transfer simulation REVERTED (token unmovable, ANT-style): " + e.message.slice(0, 120) }] };
  }

  // 5. Quoter buy+sell sim (V4 only) — mirrors evaluate.js check 7.
  if (verified.poolType === "v4" && chain.v4Quoter) {
    try {
      const pool = verified.pool;
      const zeroForOneBuy = lc(pool.currency0) === lc(verified.quote);
      const q = verified.quoteInfo;
      const probeIn = 10n ** BigInt(q.decimals); // 1 whole quote unit as probe
      const [buyOut] = await client.readContract({
        address: chain.v4Quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
        args: [[pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks], zeroForOneBuy, probeIn, "0x"],
      });
      const buyOutB = BigInt(buyOut);
      if (buyOutB === 0n) return { pass: false, checks: [...checks, { name: "quoter", pass: false, detail: "quoter buy returns 0" }] };
      const sellAmt = buyOutB > (2n ** 127n - 1n) ? (2n ** 127n - 1n) : buyOutB;
      const [sellOut] = await client.readContract({
        address: chain.v4Quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
        args: [[pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks], !zeroForOneBuy, sellAmt, "0x"],
      });
      const ratio = Number((BigInt(sellOut) * 10000n) / probeIn) / 100;
      if (ratio < 50) {
        return { pass: false, checks: [...checks, { name: "quoter", pass: false, detail: `quoter sell returns only ${ratio.toFixed(1)}% of buy input (honeypot/tax)` }] };
      }
      pass("quoter", `buy+sell sim ok — sell returns ${ratio.toFixed(1)}% of buy input`);
    } catch (e) {
      // Quoter reverts — on Robinhood it reverts on EVERY pool type
      // tested (Part 58: native + non-native, hookless + liquid, bare
      // empty revert), not just hooked pools. The transfer sim (4)
      // already proved the token moves; this is the documented
      // fallback, not a block.
      warn("quoter", "quoter inconclusive (Robinhood quoter reverts on all pool types tested; transfer sim already passed)");
    }
  } else if (verified.poolType === "v3") {
    warn("quoter", "V3 pool — no quoter sim (V3 path uses the helper; post-buy sell sim covers the route)");
  }

  return { pass: true, checks };
}

// --- buy / sell builds (reuse the proven sniper paths, no new path) --
// V4: trade.buildBuy / trade.buildSell. V3: v3-helper-trade.
// The buy size is read from cfg.buySizeUsd and ASSERTED to be $0.02.
function assertCopyBuySize() {
  if (Number(cfg.buySizeUsd) !== COPY_BUY_USD) {
    throw new Error(`copy-trader buy size is ${cfg.buySizeUsd}, not ${COPY_BUY_USD} — refusing (fee math is calibrated for $0.02)`);
  }
}

async function buildCopyBuy(verified, opts = {}) {
  assertCopyBuySize();
  const chain = getChain();
  const q = verified.quoteInfo;
  if (verified.isNative) {
    // Native-ETH buy (Part 58) — gated behind its own flag. The flag
    // lives in copy-trade-STATE.json (nativeEthLive, default false) and
    // is passed by the runner; this module NEVER flips it. A native buy
    // needs state.live AND --live AND liveConfirm AND nativeEthLive.
    if (opts.nativeAllowed !== true) {
      throw new Error("native-ETH buy is gated off (nativeEthLive=false) — refusing to build; needs a separate go-live call");
    }
    if (verified.poolType !== "v4") throw new Error("native-ETH buy is V4-only (V3 pools cannot have a native currency)");
    const built = await trade.buildBuyNative(cfg, chain, verified.poolKey, verified.token, verified.decimals, q.approxUsdPrice);
    return { kind: "v4-native", ...built, quote: q, usdAmount: COPY_BUY_USD };
  }
  if (verified.poolType === "v4") {
    const built = await trade.buildBuy(cfg, chain, verified.poolKey, verified.token, verified.decimals, q);
    return { kind: "v4", ...built, quote: q, usdAmount: COPY_BUY_USD };
  }
  const built = await v3helper.buildV3HelperBuy(cfg, chain, verified.pool.pool, verified.token, verified.decimals, q);
  return { kind: "v3", ...built, quote: q, usdAmount: COPY_BUY_USD };
}

async function buildCopySell(position, amountRaw) {
  const chain = getChain();
  const q = position.quoteInfo;
  if (position.poolType === "v4" && q && lc(q.address) === ZERO_ADDRESS) {
    // Native-ETH position: sell the token back to native ETH.
    const built = await trade.buildSellNative(cfg, chain, position.poolKey, position.token, position.decimals, amountRaw);
    return { kind: "v4-native", ...built, token: position.token, quote: q };
  }
  if (position.poolType === "v4") {
    const built = await trade.buildSell(cfg, chain, position.poolKey, position.token, position.decimals, q, amountRaw);
    return { kind: "v4", ...built, token: position.token, quote: q };
  }
  const built = await v3helper.buildV3HelperSell(cfg, chain, position.pool.pool, position.token, position.decimals, q, amountRaw);
  return { kind: "v3", ...built, token: position.token, quote: q };
}

// --- the copy-trader's own live gate -----------------------------------
// On top of trade's / the helper's gates: the copy-trader only sends
// when its OWN state says live AND the caller passes liveConfirm.
// The config is live for the sniper (cfg.live === true), so this gate
// is the only thing that stops a copy-buy from sending in dry-run.
function assertCopyLiveAllowed(state, opts) {
  if (!state || state.live !== true) throw new Error("COPY LIVE REFUSED: copy-trade-STATE.json live is false (dry-run mode)");
  if (!opts || opts.liveConfirm !== true) throw new Error("COPY LIVE REFUSED: caller must pass { liveConfirm: true }");
}

// Execute a built buy (V4, V4-native, or V3) — only after assertCopyLiveAllowed.
// Part 76 (2026-11-10): ACTUAL amountOut from the balance delta.
// IFSO proved the announced estimate can be far from reality (announced
// 495.40, the receipt delivered 310.93): the runner recorded only
// amountOutMinimum, never what the buy actually delivered. The balance
// delta (after − before) is exact, works for V4 and V3-helper paths,
// and needs no receipt parsing. Pure + fail-open: null in, null out —
// a failed balance read must never block a buy.
function actualAmountOut(balBefore, balAfter) {
  if (balBefore === null || balBefore === undefined || balAfter === null || balAfter === undefined) return null;
  try {
    const before = BigInt(balBefore);
    const after = BigInt(balAfter);
    if (after <= before) return null;
    return after - before;
  } catch { return null; }
}

async function executeCopyBuy(state, built, opts = {}) {
  assertCopyLiveAllowed(state, opts);
  const chain = getChain();
  if (built.kind === "v4" || built.kind === "v4-native") {
    return await trade.executeTxs(cfg, chain, built.txs, { liveConfirm: true });
  }
  return await v3helper.executeV3HelperTxs(cfg, chain, built.txs, {
    liveConfirm: true, v3Live: true,
    fundToken: built.quote.address, fundAmount: BigInt(built.amountIn),
  });
}

// Execute a built sell (V4, V4-native, or V3) — only after assertCopyLiveAllowed.
async function executeCopySell(state, built, opts = {}) {
  assertCopyLiveAllowed(state, opts);
  const chain = getChain();
  if (built.kind === "v4" || built.kind === "v4-native") {
    return await trade.executeTxs(cfg, chain, built.txs, { liveConfirm: true });
  }
  return await v3helper.executeV3HelperTxs(cfg, chain, built.txs, {
    liveConfirm: true, v3Live: true,
    fundToken: built.token, fundAmount: BigInt(built.amountIn),
  });
}

// --- mirror-exit (sell signal) live gate (Part 59) --------------------
// A mirror sell sends only when the mirrorExit flag is on, on top of
// the copy-trader's own live gate (state.live + liveConfirm). The flag
// lives in copy-trade-STATE.json (mirrorExit, default false) and is
// NEVER flipped by this module. The runner also logs SELL-SIGNAL-SKIP
// before reaching here, mirroring the NATIVE-SKIP pattern — the two
// checks are independent, so bypassing one still leaves the other.
function assertMirrorExitAllowed(state, opts) {
  if (!state || state.mirrorExit !== true) throw new Error("MIRROR-EXIT REFUSED: copy-trade-STATE.json mirrorExit is false (sell signal gated off)");
  if (!opts || opts.liveConfirm !== true) throw new Error("MIRROR-EXIT REFUSED: caller must pass { liveConfirm: true }");
}

// Execute a built mirror sell — only after assertMirrorExitAllowed.
// Delegates to executeCopySell (which asserts state.live +
// liveConfirm and routes V4/V4-native/V3 through the proven paths).
async function executeMirrorSell(state, built, opts = {}) {
  assertMirrorExitAllowed(state, opts);
  return executeCopySell(state, built, opts);
}

// --- post-buy sell-route sim (the debtdog gap, closed post-buy) -------
// AFTER a copy-buy, the agent holds the token and allowances are set.
// Sim the actual sell at minOut=1 via eth_call. If it reverts, the
// pool's hook blocks OUR sell route — flag the position sellBlocked
// immediately. This CANNOT be run pre-buy (the agent holds 0 and has
// no allowances then).
//
// FALSE-POSITIVE FIX (2026-11-11): the sim used to go straight to the
// router execute / helper swap without checking the preconditions the
// real sell sets up first. A V4 sell is 3 txs (approve token->Permit2,
// Permit2 approve token->Router, router execute); the sim only ran the
// execute, so on a fresh position with no token allowance it reverted
// and wrongly flagged sellBlocked — proven by TAFO/FAWBO/BANK, all
// flagged sellBlocked but sold fine for real. A V3 sell is 2 txs
// (transfer token->helper, helper swap); the sim only ran the swap, so
// with an unfunded helper it reverted for the same reason. The sim now
// checks the preconditions FIRST and returns inconclusive (NOT
// sellBlocked) when they are not met — only a revert WITH the
// preconditions in place proves the hook blocks.
async function simSellRoute(client, chain, position, amountRaw) {
  try {
    if (position.poolType === "v4") {
      // Precondition 1: token allowance to Permit2 must cover the amount.
      // Precondition 2: Permit2's allowance to the router must cover the
      // amount and not be expired. If either is short, the execute sim
      // would revert on allowance, not on the hook — inconclusive.
      const erc20Allowance = await client.readContract({
        address: position.token, abi: ERC20_MIN_ABI, functionName: "allowance",
        args: [cfg.agent, chain.permit2],
      });
      if (erc20Allowance < amountRaw) {
        return { ok: false, inconclusive: true, reason: `sell-route sim INCONCLUSIVE: token allowance to Permit2 is ${erc20Allowance} < ${amountRaw} (fresh position, approve tx not run yet) — not proof the hook blocks` };
      }
      const [p2Amount, p2Expiration] = await client.readContract({
        address: chain.permit2, abi: PERMIT2_ALLOWANCE_ABI, functionName: "allowance",
        args: [cfg.agent, position.token, chain.universalRouter],
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (p2Amount < amountRaw || p2Expiration <= now) {
        return { ok: false, inconclusive: true, reason: `sell-route sim INCONCLUSIVE: Permit2 allowance to router is ${p2Amount} (exp ${p2Expiration}) < ${amountRaw} or expired — not proof the hook blocks` };
      }
      const poolKey = position.poolKey;
      const zeroForOne = lc(poolKey.currency0) === lc(position.token);
      const { data } = trade.buildRouterExecuteFor(chain, poolKey, zeroForOne, amountRaw, 1n, position.token, position.quoteInfo.address);
      try {
        await client.call({ account: cfg.agent, to: chain.universalRouter, data, value: 0n });
      } catch (e) {
        return { ok: false, reason: "sell-route sim REVERTED with allowances in place (hook blocks our sell, debtdog-style): " + e.message.slice(0, 150) };
      }
      return { ok: true, detail: "sell-route sim SUCCEEDED (router execute, minOut=1)" };
    }
    // V3: precondition is the helper holding the token (the real sell
    // funds it first via transfer). If the helper is unfunded, the swap
    // sim would revert on balance, not on the hook — inconclusive.
    const helperBal = await client.readContract({
      address: position.token, abi: ERC20_MIN_ABI, functionName: "balanceOf",
      args: [v3helper.HELPER],
    });
    if (helperBal < amountRaw) {
      return { ok: false, inconclusive: true, reason: `sell-route sim INCONCLUSIVE: helper holds ${helperBal} < ${amountRaw} of the token (fund tx not run yet) — not proof the hook blocks` };
    }
    // V3: sim the helper swap tx as built (minOut = spot x 0.80, read
    // fresh). A revert here is most likely the hook; retry once with a
    // fresh build to rule out a stale price.
    for (let attempt = 0; attempt < 2; attempt++) {
      const built = await v3helper.buildV3HelperSell(cfg, chain, position.pool.pool, position.token, position.decimals, position.quoteInfo, amountRaw);
      const swapTx = built.txs.find((t) => lc(t.to) === lc(v3helper.HELPER));
      if (!swapTx) return { ok: false, reason: "no helper swap tx in the sell build" };
      try {
        await client.call({ account: cfg.agent, to: swapTx.to, data: swapTx.data, value: 0n });
        return { ok: true, detail: "sell-route sim SUCCEEDED (helper swap)" };
      } catch (e) {
        if (attempt === 0) continue;
        return { ok: false, reason: "sell-route sim REVERTED with helper funded (hook blocks our helper sell, debtdog-style): " + e.message.slice(0, 150) };
      }
    }
    return { ok: false, reason: "sell-route sim failed" };
  } catch (e) {
    return { ok: false, reason: "sell-route sim REVERTED: " + e.message.slice(0, 150) };
  }
}

// --- pool-fee sanity bound (Part 60) ------------------------------------
// A mirror sell (or any sell) into an absurd-fee pool wastes gas on a
// revert or hands most of the proceeds to the pool. The bound is set
// from the fees real pools actually charge:
//   * Standard V4/V3 tiers: 100 / 500 / 3000 / 10000 (0.01%–1%).
//   * Highest legit fee observed: FOBO 40000 (4%) — bought AND sold
//     by the sniper (break-even 2.31x). $MUSE/$RMUSE: 3000 (0.3%).
//     FAWBO: 0. debtdog: 100. NVDA (V3): 500.
//   * Absurd cases: JOSE 700000 (70%) — passed the v2 evaluator's
//     fee-sane check, whose bound is 100% (evaluate.js). PUSSYCOIN's
//     pool fee 8388608 is NOT 838.86% — it is the V4 DYNAMIC_FEE_FLAG
//     (0x800000): the hook sets the fee per swap, so the fee is
//     unknowable before the sell. (The Part 59 report read it as a
//     percentage; that reading was wrong — corrected here.)
// Bound: static fee <= 50000 (5%) — 25% headroom over the highest
// observed legit fee (4%), 14x below JOSE. At 5%, a $0.02 position
// sold at 2x still nets ~+$0.027 after the $0.0106 sell gas; at 70%
// it nets ~$0.001, and at 1x it LOSES money. A dynamic-fee pool is
// NOT sane for a mirror sell: the fee is hook-set and unverifiable,
// so the attempt's expected value is negative (gas is certain,
// proceeds are not). The position stays held; price-rule sells
// still apply (separate path, unchanged).
const DYNAMIC_FEE_FLAG = 0x800000; // 8388608, V4 dynamic-fee marker
const MAX_SANE_POOL_FEE = 50000; // 5% (fee units are 1e-6: 100 = 0.01%)

function checkPoolFeeSane(fee) {
  const f = Number(fee || 0);
  if (f & DYNAMIC_FEE_FLAG) return { sane: false, reason: `dynamic fee (fee=${f} has the 0x800000 flag — hook sets the fee, unverifiable before the sell)` };
  if (f > MAX_SANE_POOL_FEE) return { sane: false, reason: `static LP fee ${f} (${(f / 1e4).toFixed(2)}%) exceeds the ${MAX_SANE_POOL_FEE / 1e4}% sane bound` };
  return { sane: true, reason: `pool fee ${f} (${(f / 1e4).toFixed(2)}%) within the ${MAX_SANE_POOL_FEE / 1e4}% sane bound` };
}

// --- fee accounting -----------------------------------------------------
// Expected net P&L of a full copy-trade round trip at $0.02, using
// MEASURED Robinhood gas (not estimates) and the pool's LP fee. Hook
// fee is unknown pre-buy — bounded by the buy's minOut buffer (20%)
// and reported separately.
function feeBreakdown(position, usdBuy = COPY_BUY_USD, ethUsd = 2095) {
  const lpFeePct = (position.pool.fee || 0) / 1e6; // e.g. 3000 -> 0.003
  // Native-ETH positions (Part 58): the buy is ONE tx (router execute
  // with value) — no wrap, approve, or Permit2. The sell is the same
  // 3-tx shape as a V4 sell (approve + Permit2 + execute); the output
  // is native ETH. The native execute gas is an eth_call ESTIMATE
  // (124,829, MEASURED_GAS.nativeV4Execute) — not a mined receipt yet;
  // re-measure after the first live native buy.
  const isNative = position.quoteInfo && lc(position.quoteInfo.address) === ZERO_ADDRESS;
  let buyGas, sellGas;
  if (position.poolType === "v4" && isNative) {
    buyGas = MEASURED_GAS.nativeV4Execute;
    sellGas = MEASURED_GAS.approve + MEASURED_GAS.permit2 + MEASURED_GAS.v4Execute;
  } else if (position.poolType === "v4") {
    buyGas = MEASURED_GAS.wrap + MEASURED_GAS.approve + MEASURED_GAS.permit2 + MEASURED_GAS.v4Execute;
    sellGas = MEASURED_GAS.approve + MEASURED_GAS.permit2 + MEASURED_GAS.v4Execute;
  } else {
    buyGas = MEASURED_GAS.wrap + MEASURED_GAS.v3HelperFund + MEASURED_GAS.v3HelperSwap;
    sellGas = MEASURED_GAS.v3HelperFund + MEASURED_GAS.v3HelperSwap;
  }
  const buyGasUsd = gasUsd(buyGas, ethUsd);
  const sellGasUsd = gasUsd(sellGas, ethUsd);
  const lpBuy = usdBuy * lpFeePct;
  // Break-even: sell proceeds must cover buy principal + all fees.
  // x * (1 - lpFeePct) - sellGasUsd = usdBuy + buyGasUsd + lpBuy
  // => x = (usdBuy + buyGasUsd + lpBuy + sellGasUsd) / (1 - lpFeePct).
  const totalCost = usdBuy + buyGasUsd + lpBuy + sellGasUsd;
  const breakEvenValue = totalCost / (1 - lpFeePct);
  const breakEvenMultiple = breakEvenValue / usdBuy;
  const net = (mult) => mult * usdBuy * (1 - lpFeePct) - sellGasUsd - (usdBuy + buyGasUsd + lpBuy);
  return {
    buyGas, sellGas, buyGasUsd, sellGasUsd, lpBuy,
    lpSellAtBreakEven: breakEvenValue * lpFeePct,
    totalFeesUsd: buyGasUsd + sellGasUsd + lpBuy + breakEvenValue * lpFeePct,
    breakEvenValue, breakEvenMultiple,
    pnlAt1x: net(1), pnlAt2x: net(2), pnlAt3x: net(3), pnlAt5x: net(5),
  };
}

module.exports = {
  GMGN_BASE, GMGN_KEY, COPY_BUY_USD, MEASURED_GAS, ROBINHOOD_GAS_GWEI,
  ZERO_ADDRESS, NATIVE_ETH_QUOTE, ETH_USD_FALLBACK, getEthUsd,
  fetchGmgnFeed, detectCandidates, detectSellCandidates, findInitialize, verifyCandidate,
  scanOnchainBuys, gateToken, gateHoldersWithRetry, buildCopyBuy, buildCopySell,
  assertCopyLiveAllowed, assertMirrorExitAllowed, executeCopyBuy, executeCopySell, executeMirrorSell, simSellRoute, actualAmountOut,
  feeBreakdown, gasUsd, checkPoolFeeSane, DYNAMIC_FEE_FLAG, MAX_SANE_POOL_FEE, ERC20_MIN_ABI, TRANSFER_ABI,
};
