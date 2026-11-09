// v3.js — Sniper v2 V3 pool watching (Robinhood Chain only, DRY-RUN ONLY).
//
// Built 2026-11-08 ~02:50 WIB after the user approved "build V3 watching for
// Pons launches". Pons v1 launches go into Uniswap V3 WETH pools — neither
// sniper watched V3, so they were missed at birth. This module adds V3
// detection + evaluation to the v2 stack. It READS ONLY: no transactions,
// no live flags, no STATE.json writes. Live V3 buying needs a separate user
// Go + the execution assessment in v3-buy-sim.js (see report).
//
// Verified onchain 2026-11-08 (this build):
//  - V3 factory (Robinhood) 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA —
//    24,535 bytes, owner() + feeAmountTickSpacing() + getPool() all work.
//    The canonical Ethereum factory 0x1F98431c... is a 2,109-byte forwarder
//    decoy on Robinhood — NEVER use it (Part 32 warning, confirmed).
//  - PoolCreated topic0 0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118.
//  - Canonical Quoter 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6 and QuoterV2
//    0x61fFE014bA17989E743c5F6cB21bF9697530B21e are 2,109-byte forwarders on
//    Robinhood — both return NO DATA on quoteExactInputSingle. NOT usable.
//  - Robinhood-specific QuoterV2 0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7
//    (8,273 bytes, real) REVERTS BARE (empty data, code 3) on a healthy
//    liquid pool (DELTA/WETH 1%) at 0.00001 and 0.001 WETH — NOT usable.
//    Honeypot simulation therefore uses the transfer-simulation fallback
//    (same pattern as v1's V4 fallback): simulate transfer() from the pool
//    contract (V3 pools hold both tokens) to the agent.
//  - Robinhood SwapRouter02 0xCaf681a66D020601342297493863E78C959E5cb2
//    (24,497 bytes, real). The canonical 0x68b34658... has NO code here.
//  - V3 NonfungiblePositionManager 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3
//    (24,384 bytes) — txs TO it are NPM mints, NOT a launchpad factory.
//    Do not misread receipt.to == NPM as launchpad attribution.
//  - Pons v1 factory 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB emitted ZERO
//    logs in the last 500,000 blocks (~12 days) — v1 is DORMANT; the action
//    moved to Pons v2 (85 logs / 50k blocks, bonding curve -> V4). The V3
//    watcher therefore catches mostly non-Pons V3 launches right now
//    (~6 pools / 50k blocks ≈ 5/day, mostly fee-100 manual NPM mints).
//  - Pons attribution: receipt.to == Pons v1 factory for the PoolCreated
//    tx. Bytecode identity is NOT a fingerprint — DELTA and PONS tokens
//    are both 5,274 bytes but their runtime bytecode DIFFERS.
//  - Robinhood RPC rate-limits bursts (HTTP 429): all scans pace chunks
//    (~400 ms between eth_getLogs chunks) and retry once on 429.
//
// Scoring reuses the V4 scheme (evaluate.js): hard gates + 0-100 score,
// thresholds from config.scoreThresholds (full 70, half 45). Differences:
//  - liquidity depth: quoter impact is unavailable (quoter reverts), so
//    the depth component uses Dexscreener liquidity.usd bands when the
//    pair is indexed, else the +5 partial credit used by the V4 fallback.
//  - lp-locked: V3 positions are NPM NFTs. The PoolCreated tx usually
//    mints the LP position in the same tx (Pons v1 mints to its factory,
//    which moves it to its locker contract; Flap mints to its locker).
//    The evaluator finds NPM Transfer mints in the creation-tx receipt
//    and checks ownerOf(tokenId): burned (revert / dead owner) or held by
//    a contract other than the deployer = locked (+10); owned by the
//    deployer EOA = not locked (0). Proven on DELTA 2026-11-08: tokenId
//    536074 minted to the Pons v1 factory, now owned by locker contract
//    0x736D76699C26D0d966744cAe304C000d471f7F35 (5,426 bytes).
//  - launchpad provenance: +5 when the PoolCreated tx was sent TO a
//    registered launchpad factory/portal, the pool hook is a registered
//    launchpad hook, or the LP NFT is owned by a registered launchpad
//    locker (registries.js, Part 50 — Pons v1, Flap, Vectr, Hood, o1,
//    HedgeFun, Frontier, Duel; unknown = 0, never negative).
//  - holder concentration + bundle: same holders.js component as V4
//    ([-10,+5], fail-open), wired 2026-11-08 (Part 49).

const { parseAbi, decodeAbiParameters } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const social = require("./social.js");
const trade = require("./trade.js"); // buyAmountInQuote for the min-500 gate (no cycle: trade requires only chains)

// Minimum whole tokens a $0.02 buy must yield (user decision 2026-11-08,
// Part 51; LOOSENED 500 -> 250 on 2026-11-09 ~14:05 WIB — pre-agreed gate
// review after the v1-five verdicts: 5/5 survived (debtdog +50%, other four
// sold at ~-2%). $0.02 / 250 = price ceiling ~$0.00008/token at our size.
// Hard gates added 2026-11-08 (Part 51), same as evaluate.js:
//   token-age: first pool < 24h old (token-age.js; fail-open when unknown)
//   min-500-tokens: expected $0.02-buy output >= 250 whole tokens
//     (spot estimate from slot0 — the V3 quoter reverts on Robinhood, so
//     the spot price is the established estimator here, as in the helper
//     micro-test; unresolvable spot also skips)
const MIN_BUY_TOKENS_WHOLE = 250;

// Robinhood Chain (4663) V3 addresses — all verified onchain 2026-11-08.
const V3_FACTORY_RH = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const V3_NPM_RH = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const V3_QUOTERV2_RH = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"; // real code, but REVERTS bare — unusable (see header)
const V3_SWAPROUTER02_RH = "0xCaf681a66D020601342297493863E78C959E5cb2";
const PONS_V1_FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

const POOLCREATED_TOPIC0 = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

const V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function owner() view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24 tickSpacing)",
]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);
const NPM_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
]);
const NPM_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
]);
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);

const DANGEROUS = {
  "0x40c10f19": "mint(address,uint256)",
  "0x8456cb59": "pause()",
  "0x3f4ba83a": "unpause()",
  "0x0ec8a5ce": "setBlacklist(address,bool)",
  "0xf9f92be4": "blacklist(address)",
  "0x4b7f0d8d": "setMaxTxAmount(uint256)",
  "0x8a5c7b4a": "setMaxWallet(uint256)",
  "0x9e281a98": "setTax(uint256,uint256)",
  "0x6b5d3b5b": "setFees(uint256,uint256)",
  "0x8a8c5239": "enableTrading()",
  "0x3ee05d2d": "setTradingEnabled(bool)",
};
const BAD = Object.keys(DANGEROUS);

// Standard V3 fee tiers. Pons v1 uses 10000 (1%). Fee-100 pools in the
// recent sample are manual NPM mints, not launchpad launches.
const STANDARD_FEES = new Set([100, 500, 3000, 10000]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Paced rawGetLogs: 400 ms between chunks + one retry on HTTP 429
// (Robinhood RPC throttles bursts — proven 2026-11-08).
async function rawGetLogsPaced(client, { address, topics, fromBlock, toBlock }) {
  const out = [];
  for (let start = BigInt(fromBlock); start <= BigInt(toBlock); start += 5000n) {
    const end = start + 5000n - 1n > BigInt(toBlock) ? BigInt(toBlock) : start + 5000n - 1n;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(client.transport.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_getLogs",
            params: [{ address, topics, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }],
          }),
        });
        if (res.status === 429) { await sleep(2000); continue; }
        if (!res.ok) throw new Error(`eth_getLogs HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(`eth_getLogs RPC error: ${JSON.stringify(json.error)}`);
        out.push(...(json.result || []));
        lastErr = null;
        break;
      } catch (e) { lastErr = e; await sleep(1500); }
    }
    if (lastErr) throw lastErr;
    await sleep(400);
  }
  return out;
}

// Decode one PoolCreated log.
// Event: PoolCreated(address indexed token0, address indexed token1,
//   uint24 indexed fee, int24 tickSpacing, address pool)
// topics[0]=topic0, topics[1]=token0, topics[2]=token1, topics[3]=fee.
// data = tickSpacing (word 1) + pool address (word 2).
function decodePoolCreated(log) {
  const [tickSpacing, pool] = decodeAbiParameters(
    [{ type: "int24" }, { type: "address" }],
    log.data,
  );
  return {
    token0: ("0x" + log.topics[1].slice(26)).toLowerCase(),
    token1: ("0x" + log.topics[2].slice(26)).toLowerCase(),
    fee: parseInt(log.topics[3], 16),
    tickSpacing: Number(tickSpacing),
    pool: pool.toLowerCase(),
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
  };
}

// Scan the Robinhood V3 factory for new PoolCreated events in [from, to].
async function scanV3Pools(chain, fromBlock, toBlock) {
  const client = chains.makeClient(chain);
  const logs = await rawGetLogsPaced(client, {
    address: V3_FACTORY_RH,
    topics: [POOLCREATED_TOPIC0],
    fromBlock, toBlock,
  });
  return logs.map(decodePoolCreated);
}

// Read V3 pool state: slot0 + active liquidity + tokens + fee.
async function readV3PoolState(client, poolAddress) {
  const [slot0, liquidity, token0, token1, fee, tickSpacing] = await Promise.all([
    client.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "liquidity" }),
    client.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "token0" }),
    client.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "token1" }),
    client.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "fee" }),
    client.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName: "tickSpacing" }),
  ]);
  return {
    sqrtPriceX96: slot0[0], tick: slot0[1], feeProtocol: slot0[5], unlocked: slot0[6],
    liquidity, token0: token0.toLowerCase(), token1: token1.toLowerCase(),
    fee: Number(fee), tickSpacing: Number(tickSpacing),
  };
}

// Launchpad attribution for a V3 pool (registries.js, Part 50 — replaces
// the Pons-only check). Three signals, in order:
//   1. PoolCreated tx `to` == a registered launchpad factory/portal
//      (Pons v1 factory, Flap Portal, Hood launcher, ...).
//   2. LP-NFT owner == a registered launchpad locker (Vectr locker,
//      Pons v1 locker) — the ONLY signal that works for Vectr, whose
//      graduation tx is sent to the per-launch curve clone, never to the
//      migrator. lpOwner comes from the lp-locked check (same receipt).
//   3. Otherwise unproven — never guessed.
// Returns { launchpad, matchedBy, evidence, points, veto } via the
// registry scorer; the legacy { pons, evidence } shape is preserved in
// result.pons for the live-run log. Fail-open: any error -> 0 points.
// `receiptTo` may be passed in to skip a second receipt fetch (the
// deployer-history block already fetched the creation receipt).
async function launchpadAttribution(client, pool, opts) {
  const o = opts || {};
  try {
    let to = (o.receiptTo || "").toLowerCase() || null;
    if (!to) {
      const rc = await client.getTransactionReceipt({ hash: pool.txHash });
      to = (rc.to || "").toLowerCase() || null;
      if (to === V3_NPM_RH.toLowerCase()) {
        return { launchpad: null, matchedBy: null, evidence: `PoolCreated tx sent to the V3 NPM (manual mint via NonfungiblePositionManager), not a launchpad factory — from ${rc.from}`, points: 0, veto: false };
      }
    }
    const reg = require("./registries.js");
    const scored = reg.scoreLaunchpadLive(4663, { txTo: to, hooks: null, lpOwner: o.lpOwner || null });
    return {
      launchpad: scored.launchpad,
      matchedBy: scored.launchpad ? "registry" : null,
      evidence: scored.detail,
      points: scored.points,
      veto: scored.veto,
    };
  } catch (e) {
    return { launchpad: null, matchedBy: null, evidence: "launchpad attribution failed (fail-open): " + e.message.slice(0, 80), points: 0, veto: false };
  }
}

// Back-compat alias: the old name, same registry-backed behavior.
const ponsAttribution = (client, pool, opts) => launchpadAttribution(client, pool, opts);

// Dexscreener liquidity (USD) for depth scoring when the quoter is unusable.
async function dexscreenerLiquidityUsd(chainSlug, tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/${chainSlug}/${tokenAddress}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; MuseSniperV2/2.0)" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) return null;
    const pairs = [...json].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0].liquidity?.usd ?? null;
  } catch { return null; }
}

async function evaluateV3Pool(cfg, chain, pool) {
  const client = chains.makeClient(chain);
  const checks = [];
  const scores = [];
  const fail = (name, reason) => checks.push({ check: name, pass: false, reason });
  const pass = (name, detail) => checks.push({ check: name, pass: true, detail });
  const result = {
    chainId: chain.chainId, chain: chain.name, poolType: "V3",
    poolAddress: pool.pool, token: null, symbol: null, decimals: null,
    quote: null, checks, scores, score: 0, verdict: "SKIP", reason: "", size: null,
    pons: null,
  };

  // Pool state.
  let state;
  try {
    state = await readV3PoolState(client, pool.pool);
  } catch (e) {
    fail("pool-state", "slot0/liquidity read failed: " + e.message.slice(0, 120));
    result.reason = "pool state unreadable"; return result;
  }
  result.poolState = {
    sqrtPriceX96: state.sqrtPriceX96.toString(), tick: state.tick,
    fee: state.fee, tickSpacing: state.tickSpacing,
    liquidity: state.liquidity.toString(), unlocked: state.unlocked,
  };
  result.sqrtPriceX96 = state.sqrtPriceX96;

  if (state.liquidity === 0n) {
    fail("liquidity", "pool has 0 active liquidity at the current tick");
    result.reason = "no active liquidity"; return result;
  }
  pass("liquidity", "active liquidity " + state.liquidity.toString());

  if (!STANDARD_FEES.has(state.fee)) {
    fail("fee-sane", "non-standard V3 fee tier " + state.fee);
    result.reason = "non-standard fee tier"; return result;
  }
  pass("fee-sane", "V3 fee tier " + state.fee + (state.fee === 10000 ? " (1% — Pons v1 tier)" : state.fee === 100 ? " (0.01% — manual-mint tier in the recent sample)" : ""));

  const c0 = pool.token0, c1 = pool.token1;
  const allQuotes = chain.quotes || [];
  const usableQuotes = allQuotes.filter((q) => !q.expanded || cfg.expandedQuotesEnabled === true);
  const quote = usableQuotes.find((q) => q.address.toLowerCase() === c0 || q.address.toLowerCase() === c1);
  if (!quote) {
    const expandedHit = allQuotes.find((q) => q.address.toLowerCase() === c0 || q.address.toLowerCase() === c1);
    if (expandedHit && !cfg.expandedQuotesEnabled) {
      fail("quote-pair", expandedHit.symbol + " is an EXPANDED quote but expandedQuotesEnabled=false (gated off)");
    } else {
      const legacy = allQuotes.filter((q) => !q.expanded).map((q) => q.symbol).join("/");
      fail("quote-pair", "neither currency is in the " + chain.name + " quote allowlist (" + legacy + ")");
    }
    result.reason = "not a quote pair"; return result;
  }
  result.quote = { symbol: quote.symbol, address: quote.address, decimals: quote.decimals, stock: !!quote.stock, approxUsdPrice: quote.approxUsdPrice, expanded: !!quote.expanded };
  pass("quote-pair", quote.symbol + " is token" + (c0 === quote.address.toLowerCase() ? "0" : "1"));

  const token = (c0 === quote.address.toLowerCase()) ? c1 : c0;
  if (token === "0x0000000000000000000000000000000000000000") {
    fail("token", "other side is the native token, not an ERC-20");
    result.reason = "other side is native"; return result;
  }
  result.token = token;

  if ((cfg.ownTokens || []).map((t) => t.toLowerCase()).includes(token)) {
    fail("own-token", "this is our own token ($MUSE/$RMUSE), skip");
    result.reason = "own token"; return result;
  }
  pass("own-token", "not our token");

  let decimals, symbol;
  try {
    const [name, sym, dec, totalSupply] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);
    decimals = dec; symbol = sym;
    result.symbol = symbol; result.decimals = decimals;
    result.totalSupply = totalSupply.toString();
    pass("erc20-sanity", `${name} (${sym}), ${dec} dec, totalSupply ${(totalSupply / 10n ** BigInt(dec)).toString()}`);
  } catch (e) {
    fail("erc20-sanity", "name/symbol/decimals/totalSupply reverted: " + e.message.slice(0, 120));
    result.reason = "not a readable ERC-20"; return result;
  }

  // Spot quote-per-token (first-price baseline for memory/outcome tracking).
  // v3PriceFromSqrt returns token1-per-token0 (human units).
  try {
    const dec0 = c0 === quote.address.toLowerCase() ? quote.decimals : decimals;
    const dec1 = c0 === quote.address.toLowerCase() ? decimals : quote.decimals;
    const spot = v3PriceFromSqrt(state.sqrtPriceX96, dec0, dec1);
    result.spotQuotePerToken = c0 === quote.address.toLowerCase() ? 1 / spot : spot;
  } catch { /* no baseline — follow-up uses the first checkpoint price */ }

  try {
    const code = await client.getBytecode({ address: token });
    const codeHex = (code || "").toLowerCase();
    const foundBad = BAD.filter((sel) => codeHex.includes(sel.slice(2)));
    if (foundBad.length > 0) {
      fail("no-dangerous-fns", "bytecode contains dangerous selectors: " + foundBad.map((s) => DANGEROUS[s]).join(", "));
      result.reason = "dangerous functions in token"; return result;
    }
    pass("no-dangerous-fns", "no mint/pause/blacklist/maxTx/maxWallet/tax/enableTrading selectors in bytecode");
  } catch (e) {
    fail("no-dangerous-fns", "bytecode read failed: " + e.message.slice(0, 100));
    result.reason = "bytecode unreadable"; return result;
  }
  try {
    const owner = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "owner" });
    result.tokenOwner = owner;
    if (owner === "0x0000000000000000000000000000000000000000") pass("owner", "ownership renounced (owner = zero)");
  } catch { /* no owner() — informational only */ }

  // Honeypot: QuoterV2 on Robinhood reverts bare on every pool tried, so go
  // straight to the transfer simulation (pool contract holds both tokens).
  // Same pattern as v1's V4 fallback. A reverted transfer = likely honeypot.
  try {
    const poolBal = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [pool.pool] });
    if (poolBal === 0n) {
      fail("honeypot-buy", "pool contract holds 0 of the token — pool may be empty");
      result.reason = "pool empty"; return result;
    }
    const smallAmt = poolBal > 1000000n ? 1000000n : poolBal;
    await client.simulateContract({
      address: token, abi: TRANSFER_ABI, functionName: "transfer",
      args: [cfg.agent, smallAmt], account: pool.pool,
    });
    pass("honeypot-buy", "QuoterV2 unusable on Robinhood (bare revert — verified); transfer simulation from pool contract SUCCEEDED — token is transferable");
    pass("honeypot-sell", "fallback: token transferable and no blacklist/maxTx/tax selectors (check 4) — sell path not blocked at token level");
  } catch (e) {
    fail("honeypot-buy", "transfer simulation from pool contract reverted — likely honeypot: " + e.message.slice(0, 120));
    result.reason = "transfer simulation reverted (honeypot)"; return result;
  }

  // Token-age gate (hard veto, Part 51 — user decision 2026-11-08 ~07:42 WIB).
  // Only buy tokens whose FIRST pool is < 24h old. Fail-open: age unknown
  // -> allow, logged. TOKEN_AGE_ENABLED=0 disables the check (testing).
  if (process.env.TOKEN_AGE_ENABLED !== "0") {
    try {
      const ta = require("./token-age.js");
      const age = await ta.checkTokenAge(chain, token);
      result.tokenAge = age;
      const d = ta.evaluateAge(age.firstPoolAtMs);
      if (age.known && d.decision === "reject") {
        fail("token-age", d.reason + " [" + (age.sources.join("+") || "no source") + "]");
        result.reason = "token too old: " + d.reason; return result;
      }
      pass("token-age", age.known ? d.reason + " [" + age.sources.join("+") + "]" : "first-pool age unknown (fail-open): " + age.detail);
    } catch (e) {
      pass("token-age", "age check errored (fail-open): " + e.message.slice(0, 80));
    }
  } else {
    pass("token-age", "disabled (TOKEN_AGE_ENABLED=0)");
  }

  // Minimum-500-tokens rule (hard gate, Part 51 — user decision 2026-11-08
  // ~07:45 WIB). The $0.02 buy must yield >= 500 whole tokens. V3 has no
  // working quoter on Robinhood, so the estimate is the slot0 spot price
  // (result.spotQuotePerToken, computed above from v3PriceFromSqrt — now
  // fixed in chains.js; it ignores fees/hook taxes and price impact, so it
  // OVERESTIMATES output — the gate only guards against absurd prices
  // like FOBO's 2.43 tokens, and the execution layer's minOut is the
  // final guard). Unresolvable spot (0/NaN/undefined) also skips.
  // MIN500_ENABLED=0 disables the check (testing).
  if (process.env.MIN500_ENABLED !== "0") {
    try {
      const spot = result.spotQuotePerToken;
      if (!spot || !Number.isFinite(spot) || spot <= 0) {
        fail("min-500-tokens", "spot price unresolvable (spot=" + spot + ") — cannot verify >= 500 tokens");
        result.reason = "spot price unresolvable (< 500 tokens unverifiable)"; return result;
      }
      const amountIn = await trade.buyAmountInQuote(cfg, chain, quote, client);
      const quoteHuman = Number(amountIn) / 10 ** quote.decimals;
      const expectedWhole = quoteHuman / spot;
      result.expectedBuyTokensWhole = expectedWhole;
      if (!Number.isFinite(expectedWhole) || expectedWhole < MIN_BUY_TOKENS_WHOLE) {
        fail("min-500-tokens", "expected output " + (Number.isFinite(expectedWhole) ? expectedWhole.toFixed(2) : "NaN") + " whole tokens < " + MIN_BUY_TOKENS_WHOLE);
        result.reason = "expected output < 500 tokens"; return result;
      }
      pass("min-500-tokens", "expected output ~" + expectedWhole.toFixed(2) + " whole tokens >= " + MIN_BUY_TOKENS_WHOLE + " (spot estimate)");
    } catch (e) {
      fail("min-500-tokens", "buy size uncomputable: " + e.message.slice(0, 100));
      result.reason = "buy size uncomputable (min-500 unverifiable)"; return result;
    }
  } else {
    pass("min-500-tokens", "disabled (MIN500_ENABLED=0)");
  }

  // ---- Scoring 0-100 (same scheme as V4) ----
  try {
    const s = await social.scoreSocial(chain.dexscreenerSlug, token, cfg);
    scores.push({ component: "social-website", points: s.points, max: 25, detail: s.detail });
    result.social = s;
  } catch (e) {
    scores.push({ component: "social-website", points: 0, max: 25, detail: "social check errored: " + e.message.slice(0, 80) });
  }

  try {
    const m = await chains.sourcifyMatch(chain.chainId, token);
    scores.push({ component: "verified-contract", points: m.verified ? 10 : 0, max: 10, detail: m.verified ? "Sourcify match: " + m.match : "not verified on Sourcify (or check failed)" });
  } catch {
    scores.push({ component: "verified-contract", points: 0, max: 10, detail: "Sourcify check failed" });
  }

  // Liquidity depth +15: no quoter impact available on Robinhood V3.
  // Use Dexscreener liquidity.usd bands when indexed, else +5 partial
  // credit (same as the V4 quoter-inconclusive fallback).
  const liqUsd = await dexscreenerLiquidityUsd(chain.dexscreenerSlug, token);
  if (liqUsd !== null) {
    const pts = liqUsd >= 100000 ? 15 : liqUsd >= 20000 ? 10 : liqUsd >= 5000 ? 5 : 0;
    scores.push({ component: "liquidity-depth", points: pts, max: 15, detail: `Dexscreener liquidity $${Math.round(liqUsd).toLocaleString()} (quoter unusable on Robinhood V3 — depth by USD bands)` });
  } else {
    scores.push({ component: "liquidity-depth", points: 5, max: 15, detail: "quoter unusable on Robinhood V3; pair not yet indexed on Dexscreener — active liquidity > 0 + transfer sim proven, partial credit" });
  }

  // LP locked +10 — replaced 2026-11-08 by the real NPM ownerOf check
  // (below, after deployer history, which fetches the creation receipt).
  // Kept here as a placeholder so the score order stays readable.

  // Deployer history +10: first-time deployer +5; rug-linked -20 = VETO.
  // The veto is live (registries.js KNOWN_RUG, Part 50 — confirmed scams
  // only) AND covers the token itself, not just the deployer. The legacy
  // config.knownRugDeployers list is unioned in for backward compat.
  let veto = false;
  let creationReceipt = null;
  try {
    creationReceipt = await client.getTransactionReceipt({ hash: pool.txHash });
    const deployer = (creationReceipt.from || "").toLowerCase();
    result.deployer = deployer;
    result.creatorContract = (creationReceipt.to || "").toLowerCase() || null;
    let rugHit = null;
    try {
      const reg = require("./registries.js");
      const chk = reg.checkKnownRugLive({ deployer, token });
      if (chk.veto) rugHit = chk.reason;
    } catch { /* registry unavailable — fall through to the config list */ }
    if (!rugHit && (cfg.knownRugDeployers || []).map((d) => d.toLowerCase()).includes(deployer)) {
      rugHit = "deployer " + deployer + " is on the config known-rug list — VETO";
    }
    if (rugHit) {
      scores.push({ component: "deployer-history", points: -20, max: 10, detail: rugHit });
      veto = true;
    } else {
      const nonce = await client.getTransactionCount({ address: deployer });
      const firstTime = nonce <= 10;
      scores.push({ component: "deployer-history", points: firstTime ? 5 : 0, max: 10, detail: firstTime ? "first-time deployer (nonce " + nonce + ")" : "established deployer (nonce " + nonce + "), not on the known-rug list (registries.js)" });
    }
  } catch (e) {
    scores.push({ component: "deployer-history", points: 0, max: 10, detail: "deployer lookup failed: " + e.message.slice(0, 80) });
  }

  // Memory adjustment ±25 (2026-11-08, memory.js — aegis-style Second Brain).
  // Same fail-open contract as v2: lazy require in try/catch, unknown -> 0,
  // known-rug VETO above stands regardless of memory.
  try {
    const mem = require("./memory.js");
    const adj = result.deployer
      ? mem.adjustmentForDeployer(result.deployer)
      : { points: 0, detail: "memory: no deployer known for this pool" };
    result.memoryAdjustment = adj;
    scores.push({ component: "memory-adjustment", points: adj.points, max: 25, detail: adj.detail });
  } catch (e) {
    scores.push({ component: "memory-adjustment", points: 0, max: 25, detail: "memory: lookup failed (fail-open): " + e.message.slice(0, 80) });
  }

  // GoPlus token_security second opinion [-10, +5] (2026-11-08, goplus.js —
  // Part 48). Free, no key, covers Robinhood 4663 (live-verified). The
  // onchain transfer sim stays primary: a GoPlus honeypot flag only costs
  // -5, never a veto. Fail-open: any error/timeout -> 0 points.
  try {
    const gp = require("./goplus.js");
    const g = await gp.scoreGoPlus(chain.chainId, token, {
      deployer: result.deployer || null,
      creatorContract: result.creatorContract || null,
    });
    result.goplus = g;
    scores.push({ component: "goplus-second-opinion", points: g.points, max: 5, detail: g.detail });
  } catch (e) {
    scores.push({ component: "goplus-second-opinion", points: 0, max: 5, detail: "goplus: lookup failed (fail-open): " + e.message.slice(0, 80) });
  }

  // Holder concentration + bundle detection [-10, +5] (2026-11-08,
  // holders.js — Part 49). Blockscout PRO when BLOCKSCOUT_API_KEY is set,
  // else onchain Transfer-log reconstruction (no key, works today).
  // Pool/burn/locker contracts are excluded before judging; a contract
  // whose owner() is the deployer counts toward the dev share. Fail-open:
  // any error/timeout -> 0 points. Never a veto.
  try {
    const hd = require("./holders.js");
    const h = await hd.scoreHolders(chain, token, {
      client,
      deployer: result.deployer || null,
      totalSupply: result.totalSupply ? BigInt(result.totalSupply) : null,
      poolBlock: pool.blockNumber,
      poolAddress: pool.pool,
      excludeAddresses: [pool.pool],
    });
    result.holders = h;
    scores.push({ component: "holder-concentration", points: h.points, max: 5, detail: h.detail });
  } catch (e) {
    scores.push({ component: "holder-concentration", points: 0, max: 5, detail: "holders: lookup failed (fail-open): " + e.message.slice(0, 80) });
  }

  // Smart-money signal [0, +15] (2026-11-09, smart-money.js — Part 55).
  // +10 when >=1 watchlisted wallet bought this token and still holds it;
  // +15 when >=2. Detection reads the pool's Swap events onchain and
  // checks each swap tx's `from` (the V3 Swap sender is the router, not
  // the buyer). The token must still pass EVERY gate — this only adds
  // points. Fail-open: any error -> 0 points. Never a veto.
  try {
    const sm = require("./smart-money.js");
    const s = await sm.scoreSmartMoney(chain, {
      client,
      poolAddress: pool.pool,
      token,
      poolBlock: pool.blockNumber,
      deployer: result.deployer || null,
      creator: result.goplus && result.goplus.raw ? result.goplus.raw.creator : null,
      cfg,
    });
    result.smartMoney = s;
    scores.push({ component: "smart-money", points: s.points, max: 15, detail: s.detail });
  } catch (e) {
    scores.push({ component: "smart-money", points: 0, max: 15, detail: "smart-money: lookup failed (fail-open): " + e.message.slice(0, 80) });
  }

  // LP locked +10 — real check (built 2026-11-08, proven on DELTA):
  // find NPM Transfer mints (from 0x0) in the PoolCreated-tx receipt,
  // then ownerOf each minted tokenId. Burned (ownerOf reverts, or the
  // dead address owns it) or held by a contract other than the deployer
  // = locked (+10). Owned by the deployer EOA (or any EOA) = not locked
  // (0). No NPM mint in the creation tx = unverifiable (0).
  // The LP owner is also captured for launchpad attribution below: a
  // Vectr graduation mints straight into the VectrLPLocker, which is
  // the only signal that identifies Vectr (registries.js, Part 50).
  let lpOwner = null;
  try {
    let receipt = creationReceipt;
    if (!receipt) receipt = await client.getTransactionReceipt({ hash: pool.txHash });
    const mints = (receipt.logs || []).filter(
      (l) => l.address.toLowerCase() === V3_NPM_RH.toLowerCase()
        && l.topics[0] === NPM_TRANSFER_TOPIC0
        && BigInt(l.topics[1] || "0x0") === 0n,
    );
    if (mints.length === 0) {
      scores.push({ component: "lp-locked", points: 0, max: 10, detail: "no NPM position minted in the PoolCreated tx — LP lock unverifiable at T+0" });
    } else {
      let locked = false;
      let detail = "";
      for (const m of mints) {
        const tokenId = BigInt(m.topics[3]);
        let owner;
        try {
          owner = (await client.readContract({ address: V3_NPM_RH, abi: NPM_ABI, functionName: "ownerOf", args: [tokenId] })).toLowerCase();
        } catch {
          locked = true; detail = `LP NFT #${tokenId} ownerOf reverts — burned`; break;
        }
        if (owner === DEAD_ADDRESS) {
          locked = true; detail = `LP NFT #${tokenId} owned by the dead address — burned`; break;
        }
        if (!lpOwner) lpOwner = owner;
        const ownerCode = await client.getBytecode({ address: owner });
        if (ownerCode && ownerCode !== "0x") {
          locked = true; detail = `LP NFT #${tokenId} held by contract ${owner} (locker) — not the deployer`; break;
        }
        detail = `LP NFT #${tokenId} owned by EOA ${owner}${owner === (result.deployer || "") ? " (the deployer)" : ""} — not locked`;
      }
      scores.push({ component: "lp-locked", points: locked ? 10 : 0, max: 10, detail });
    }
  } catch (e) {
    scores.push({ component: "lp-locked", points: 0, max: 10, detail: "LP-lock check failed: " + e.message.slice(0, 80) });
  }

  const symUpper = (symbol || "").toUpperCase();
  if ((cfg.knownTokens || []).includes(symUpper)) {
    scores.push({ component: "no-impersonation", points: 0, max: 5, detail: "symbol " + symUpper + " matches a known token — possible impersonation" });
  } else {
    scores.push({ component: "no-impersonation", points: 5, max: 5, detail: "symbol " + symUpper + " is not a known-token symbol" });
  }

  scores.push({ component: "early-traction", points: 0, max: 15, detail: "T+0 — only scorable at T+5-60 min (re-score only)" });

  // Launchpad provenance +5 — registry attribution (Part 50). The
  // PoolCreated tx `to` (reused from the creation receipt fetched above)
  // is matched against launchpad factories/portals, and the LP-NFT owner
  // captured by the lp-locked check is matched against launchpad lockers
  // (the Vectr signal). Unknown launchpad = 0, never negative. A
  // registry-level veto (veto: true — none today) vetoes the pool.
  const attr = await launchpadAttribution(client, pool, {
    receiptTo: creationReceipt ? (creationReceipt.to || null) : null,
    lpOwner,
  });
  result.pons = { pons: !!(attr.launchpad && attr.points > 0), evidence: attr.evidence, launchpad: attr.launchpad ? attr.launchpad.id : null };
  result.launchpad = attr.launchpad ? { id: attr.launchpad.id, name: attr.launchpad.name, status: attr.launchpad.status } : null;
  scores.push({ component: "launchpad-provenance", points: attr.points, max: 5, detail: attr.evidence });
  if (attr.veto) veto = true;

  // Total clamped to [0, 100] (memory ±25 can otherwise push over 100).
  // Thresholds (>=70 full, >=45 half) are unchanged.
  const total = Math.max(0, Math.min(100, scores.reduce((a, s) => a + s.points, 0)));
  result.score = total;
  result.scores = scores;

  if (veto) {
    result.verdict = "SKIP";
    result.reason = "rug-linked deployer (veto)";
    result.size = null;
    recordToMemory(result);
    return result;
  }
  const t = cfg.scoreThresholds || { full: 70, half: 45 };
  result.verdict = "PASS";
  result.reason = "all hard gates passed";
  result.size = total >= t.full ? "full" : total >= t.half ? "half" : "watch";
  recordToMemory(result);
  return result;
}

// Record a scored V3 evaluation in memory (fail-open: never throws).
function recordToMemory(result) {
  try {
    const mem = require("./memory.js");
    mem.recordEvaluation({
      chainId: result.chainId,
      token: result.token,
      poolAddress: result.poolAddress,
      poolType: "V3",
      deployer: result.deployer || null,
      creatorContract: result.creatorContract || null,
      symbol: result.symbol,
      quoteSymbol: result.quote ? result.quote.symbol : null,
      quoteAddress: result.quote ? result.quote.address : null,
      source: "v3",
      score: result.score,
      scoreBreakdown: result.scores,
      decision: result.verdict === "SKIP" ? "skip" : (result.size === "watch" ? "watch" : "would-buy"),
      firstPrice: result.spotQuotePerToken ?? null,
      firstPriceQuote: result.quote ? result.quote.symbol : null,
    });
  } catch (e) { /* fail-open: memory must never break evaluation */ }
}

// Spot price of token1 in token0 units (raw): (sqrtPriceX96/2^96)^2 * 10^(dec0-dec1).
function v3PriceFromSqrt(sqrtPriceX96, dec0, dec1) {
  return chains.priceFromSqrt(sqrtPriceX96, dec0, dec1);
}

// CLI: node v3.js evaluate <poolAddress> — evaluate one known V3 pool.
//      node v3.js scan <fromBlock> <toBlock> — list new V3 pools (no eval).
if (require.main === module) {
  const cfg = require("./config.json");
  const chain = { chainId: 4663, ...cfg.chains["4663"] };
  const cmd = process.argv[2];
  (async () => {
    if (cmd === "scan") {
      const from = Number(process.argv[3]), to = Number(process.argv[4]);
      const pools = await scanV3Pools(chain, from, to);
      console.log(`V3 pools ${from}..${to}: ${pools.length}`);
      for (const p of pools) console.log(`  block ${p.blockNumber} ${p.token0.slice(0, 10)}..${p.token1.slice(0, 10)} fee ${p.fee} pool ${p.pool} tx ${p.txHash}`);
    } else if (cmd === "evaluate") {
      const poolAddress = process.argv[3].toLowerCase();
      const client = chains.makeClient(chain);
      const state = await readV3PoolState(client, poolAddress);
      const pool = { token0: state.token0, token1: state.token1, fee: state.fee, tickSpacing: state.tickSpacing, pool: poolAddress, blockNumber: 0, txHash: "0x" + "0".repeat(64), logIndex: 0 };
      // txHash unknown for a bare pool address — attribution will report
      // "receipt lookup failed"; use the dry-run runner for full attribution.
      const r = await evaluateV3Pool(cfg, chain, pool);
      for (const c of r.checks) console.log(c.pass ? "  PASS" : "  FAIL", c.check, "-", c.pass ? c.detail : c.reason);
      for (const s of r.scores) console.log("  SCORE", s.component, s.points + "/" + s.max, "-", s.detail);
      console.log("=== VERDICT:", r.verdict, "score", r.score, "size", r.size, "-", r.reason, "===");
      console.log("pons:", JSON.stringify(r.pons));
    } else {
      console.log("usage: node v3.js scan <fromBlock> <toBlock> | node v3.js evaluate <poolAddress>");
      process.exit(1);
    }
  })().catch((e) => { console.error("V3 ERROR:", e.message); process.exit(1); });
}

module.exports = {
  V3_FACTORY_RH, V3_NPM_RH, V3_QUOTERV2_RH, V3_SWAPROUTER02_RH, PONS_V1_FACTORY,
  POOLCREATED_TOPIC0, V3_FACTORY_ABI, V3_POOL_ABI,
  decodePoolCreated, scanV3Pools, readV3PoolState, ponsAttribution,
  launchpadAttribution,
  evaluateV3Pool, v3PriceFromSqrt, rawGetLogsPaced,
};
