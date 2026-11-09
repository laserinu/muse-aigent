// evaluate.js — Sniper v2 evaluator (chain-agnostic, dry-run safe: reads only).
//
// Hard gates (ALL must pass — carried over from v1):
//   1. quote-pair: one currency is in the chain's quote allowlist (config).
//   2. own-token: never $MUSE / $RMUSE (config.ownTokens).
//   3. erc20-sanity: name/symbol/decimals/totalSupply readable.
//   4. no-dangerous-fns: no mint/pause/blacklist/maxTx/maxWallet/tax/enableTrading
//      selectors in bytecode.
//   5. fee-sane: static LP fee <= 5% (dynamic-fee pools fail — hook-set, unverifiable).
//   6. liquidity: active liquidity > 0 at the current tick.
//   7. honeypot-buy + honeypot-sell: V4Quoter buy+sell simulation; if the
//      quoter reverts (hook — same as our own $MUSE/$RMUSE pools), fall back
//      to a token transfer simulation from the PoolManager (a real holder)
//      to the agent wallet. A quoter revert is INCONCLUSIVE, not a fail.
//   8. token-age (Part 51, user decision 2026-11-08): the token's FIRST
//      pool (any quote, any DEX) must be < 24h old. Earliest of Dexscreener
//      min pairCreatedAt + GeckoTerminal min pool_created_at (the only
//      indexer that covers Arc). Fail-open: age unknown -> allow, logged.
//   9. min-500-tokens (Part 51, user decision 2026-11-08): the $0.02 buy's
//      expected output must be >= 500 whole tokens (decimals-adjusted).
//      Uses the honeypot sim's expected output at the real buy size
//      (quoter first, spot fallback). Unresolvable output (0/unknown)
//      also skips — FOBO bought 2.43 tokens at an unresolvable price.
//
// Scoring 0-100 (design §6, scored — NOT a hard gate):
//   social/website   +25  (Dexscreener info.websites[]/info.socials[];
//                           website must LOAD http 200; links are self-declared,
//                           not verified — see social.js)
//   verified contract +10 (Sourcify match; 0 if the check fails)
//   liquidity depth  +15  (quoter buy impact: <=1% +15, <=5% +10, <=10% +5)
//   LP locked        +10  (NOT checkable at T+0 for V4 — positions are NFTs;
//                           scored 0 with a re-check note)
//   deployer history +10  (first-time deployer +5; rug-linked -20 = VETO;
//                           rug list lives in registries.js KNOWN_RUG
//                           (curated 2026-11-08, Part 50) + the legacy
//                           config.knownRugDeployers, unioned)
//   memory-adjustment ±25  (memory.js — deployer reputation from past launches
//                           with resolved outcomes; unknown deployers get 0)
//   goplus-second-opinion [-10,+5] (goplus.js — GoPlus token_security; the
//                           onchain honeypot sim stays primary, never a veto)
//   holder-concentration [-10,+5] (holders.js — top-1/top-10 non-contract
//                           holders, dev share, bundled supply; pool/burn/
//                           locker contracts excluded before judging)
//   no impersonation +5   (symbol matches a known token but different address
//                           -> 0 + flag; otherwise +5)
//   early traction   +15  (T+5-60 min only — 0 at detection, re-score only)
//   launchpad prov.  +5   (registries.js — Initialize tx `to` matched
//                           against launchpad factories/portals, pool hooks
//                           against launchpad hooks; curated 2026-11-08,
//                           Part 50; unknown launchpad = 0, never negative)
// Thresholds: >=70 full size, 45-69 half size, <45 watch only. Buy line
// lowered 50 -> 45 by user decision 2026-11-08 ~01:30 WIB (hooked pools cap
// at 45 at T+0: liquidity-depth partial credit 5/15 + lp-locked/early-traction
// structurally 0 at birth). Configured in config.json scoreThresholds.half.
//
// Verdict: "PASS" = hard gates passed (size: full/half/watch).
//          "SKIP" = a hard gate failed, or a rug-link veto.

const { parseAbi, encodeAbiParameters } = require("/home/hatch/workspace/privy/agent-cli/node_modules/viem");
const chains = require("./chains.js");
const social = require("./social.js");
const trade = require("./trade.js"); // buyAmountInQuote + spotOutput for the min-500 gate (no cycle: trade requires only chains)

// Minimum whole tokens a $0.02 buy must yield (user decision 2026-11-08,
// Part 51; LOOSENED 500 -> 250 on 2026-11-09 ~14:05 WIB — pre-agreed gate
// review after the v1-five verdicts: 5/5 survived (debtdog +50%, other four
// sold at ~-2%), so min-500 -> 250. $0.02 / 250 = price ceiling
// ~$0.00008/token at our size. Age gate and score line UNCHANGED.)
const MIN_BUY_TOKENS_WHOLE = 250;

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmountIn, bytes hookData) returns (uint256 amountOut, uint256 gasEstimate)",
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
const DYNAMIC_FEE_FLAG = 0x800000;
const MAX_SANE_POOL_FEE = 50000; // 5% (fee units are 1e-6: 100 = 0.01%) — mirrors copy-trade.js checkPoolFeeSane (Part 60 buy side, 2026-11-09).

// Probe input for the quoter simulation: 0.00001 quote units (v1 size).
// Small enough to be harmless, big enough to quote. The depth score is
// computed from THIS probe's impact — it understates a $1 buy's impact;
// the execution layer's amountOutMinimum is the final guard.
function probeAmount(decimals) {
  return 10n ** BigInt(decimals) / 100000n;
}

async function evaluatePool(cfg, chain, pool) {
  const client = chains.makeClient(chain);
  const checks = [];
  const scores = [];
  const fail = (name, reason) => checks.push({ check: name, pass: false, reason });
  const pass = (name, detail) => checks.push({ check: name, pass: true, detail });
  const result = {
    chainId: chain.chainId,
    chain: chain.name,
    poolId: pool.poolId,
    token: null, symbol: null, decimals: null, quote: null, poolKey: null,
    checks, scores, score: 0, verdict: "SKIP", reason: "", size: null,
  };

  // Pool state via extsload.
  let state;
  try {
    state = await chains.readPoolState(client, chain.poolManager, pool.poolId);
  } catch (e) {
    fail("pool-state", "extsload failed: " + e.message.slice(0, 120));
    result.reason = "pool state unreadable"; return result;
  }
  result.poolState = {
    sqrtPriceX96: state.sqrtPriceX96.toString(), tick: state.tick,
    lpFee: state.lpFee, liquidity: state.liquidity.toString(),
  };

  if (state.liquidity === 0n) {
    fail("liquidity", "pool has 0 active liquidity at the current tick");
    result.reason = "no active liquidity"; return result;
  }
  pass("liquidity", "active liquidity " + state.liquidity.toString());

  // Fee sanity (Part 60 buy side, 2026-11-09): static fee > 5% is a hard
  // fail, mirroring the copy-trader's checkPoolFeeSane bound; dynamic-fee
  // pools fail too (fee is hook-set and unverifiable before the buy).
  // Highest legit fee observed: FOBO 4% (40000). JOSE 70% (700000) blocks.
  if (state.lpFee & DYNAMIC_FEE_FLAG) {
    fail("fee-sane", "dynamic fee pool (fee set by hook) — unverifiable before the buy");
    result.reason = "dynamic fee pool"; return result;
  } else if (state.lpFee > MAX_SANE_POOL_FEE) {
    fail("fee-sane", "static LP fee " + state.lpFee + " exceeds the 5% sane bound");
    result.reason = "fee above 5% sane bound"; return result;
  } else {
    pass("fee-sane", "static LP fee " + state.lpFee + " (100 = 0.01%)");
  }

  const c0 = pool.currency0, c1 = pool.currency1;
  const poolKey = { poolId: pool.poolId, currency0: c0, currency1: c1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks };
  result.poolKey = poolKey;

  // Check 1: quote pair — one currency must be in this chain's allowlist.
  // Quotes marked expanded:true (all verified tokens + tokenized stocks,
  // wired 2026-11-07) are usable ONLY when cfg.expandedQuotesEnabled === true.
  // When the flag is off, a pool whose only quote is expanded is skipped with
  // an explicit gate reason, so the live watcher log shows WHY it skipped.
  // (The allowlist in the fail message is truncated — Robinhood alone has
  // 203 stock quotes; listing them all would flood the log.)
  const allQuotes = chain.quotes || [];
  const usableQuotes = allQuotes.filter((q) => !q.expanded || cfg.expandedQuotesEnabled === true);
  const quote = usableQuotes.find(
    (q) => q.address.toLowerCase() === c0 || q.address.toLowerCase() === c1,
  );
  if (!quote) {
    const expandedHit = allQuotes.find(
      (q) => q.address.toLowerCase() === c0 || q.address.toLowerCase() === c1,
    );
    if (expandedHit && !cfg.expandedQuotesEnabled) {
      fail("quote-pair", expandedHit.symbol + " is an EXPANDED quote but expandedQuotesEnabled=false (gated off) — not a live quote pair yet");
    } else {
      const legacy = allQuotes.filter((q) => !q.expanded).map((q) => q.symbol).join("/");
      const nExp = allQuotes.filter((q) => q.expanded).length;
      fail("quote-pair", "neither currency is in the " + chain.name + " quote allowlist (" + legacy + (nExp ? ` + ${nExp} expanded` : "") + ")");
    }
    result.reason = "not a quote pair"; return result;
  }
  // NOTE (2026-11-07): pool math below is in RAW units of both tokens.
  // For a stock quote (ERC-8056) balanceOfUI = balanceOf * uiMultiplier / 1e18,
  // but the pool's sqrtPrice, the probe amount and the honeypot sim are all
  // raw-unit based, so they are correct unchanged. The multiplier matters ONLY
  // for USD sizing in trade.js (buyAmountInQuote), not here.
  result.quote = { symbol: quote.symbol, address: quote.address, decimals: quote.decimals, stock: !!quote.stock, b20: !!quote.b20, approxUsdPrice: quote.approxUsdPrice, expanded: !!quote.expanded };
  pass("quote-pair", quote.symbol + " is currency" + (c0 === quote.address.toLowerCase() ? "0" : "1"));

  const token = (c0 === quote.address.toLowerCase()) ? c1 : c0;
  if (token === "0x0000000000000000000000000000000000000000") {
    fail("token", "other side is the native token, not an ERC-20");
    result.reason = "other side is native"; return result;
  }
  result.token = token;

  // Check 2: own tokens — never buy $MUSE / $RMUSE.
  if ((cfg.ownTokens || []).map((t) => t.toLowerCase()).includes(token)) {
    fail("own-token", "this is our own token ($MUSE/$RMUSE), skip");
    result.reason = "own token"; return result;
  }
  pass("own-token", "not our token");

  // Check 3: ERC-20 sanity.
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

  // Check 4: dangerous functions in bytecode.
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

  // Check 7: honeypot — quoter buy+sell sim, transfer-sim fallback.
  const zeroForOneBuy = c0 === quote.address.toLowerCase();
  const probeIn = probeAmount(quote.decimals);
  let buyOut = null;
  let quoterWorked = false;
  let buyImpact = null;
  try {
    const [out] = await client.readContract({
      address: chain.v4Quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [[c0, c1, pool.fee, pool.tickSpacing, pool.hooks], zeroForOneBuy, probeIn, "0x"],
    });
    buyOut = BigInt(out);
    if (buyOut === 0n) {
      fail("honeypot-buy", "quoter buy returns 0");
      result.reason = "quoter buy returns 0"; return result;
    }
    quoterWorked = true;
    // Buy impact: executed price vs spot price (from sqrtPriceX96).
    // priceFromSqrt returns token0-per-token1. Quote-per-token is:
    //   quote=c0: spot directly; quote=c1: 1/spot.
    // Executed quote-per-token is probeIn/buyOut in both directions.
    const dec0 = zeroForOneBuy ? quote.decimals : decimals;
    const dec1 = zeroForOneBuy ? decimals : quote.decimals;
    const spot = chains.priceFromSqrt(pool.sqrtPriceX96, dec0, dec1);
    const execPrice = Number(probeIn) / Number(buyOut);
    const spotQuotePerToken = zeroForOneBuy ? spot : 1 / spot;
    buyImpact = spotQuotePerToken > 0 ? Math.max(0, (spotQuotePerToken - execPrice) / spotQuotePerToken) : 0;
    result.spotQuotePerToken = spotQuotePerToken; // first-price baseline for memory/outcome tracking
    pass("honeypot-buy", "quoter buy returns " + buyOut.toString() + " (impact " + (buyImpact * 100).toFixed(2) + "%)");
  } catch (e) {
    // Quoter reverts (hook) — fallback to transfer simulation from PoolManager.
    try {
      const pmBal = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [chain.poolManager] });
      if (pmBal === 0n) {
        fail("honeypot-buy", "PoolManager holds 0 of the token — pool may be empty");
        result.reason = "pool empty"; return result;
      }
      const smallAmt = pmBal > 1000000n ? 1000000n : pmBal;
      await client.simulateContract({
        address: token, abi: TRANSFER_ABI, functionName: "transfer",
        args: [cfg.agent, smallAmt], account: chain.poolManager,
      });
      pass("honeypot-buy", "quoter inconclusive (hook reverts quoter, as with our own pools); transfer simulation from PoolManager SUCCEEDED — token is transferable");
      pass("honeypot-sell", "fallback: token transferable and no blacklist/maxTx/tax selectors (check 4) — sell path not blocked at token level");
      buyOut = -1n;
    } catch (e2) {
      fail("honeypot-buy", "transfer simulation from PoolManager reverted — likely honeypot: " + e2.message.slice(0, 120));
      result.reason = "transfer simulation reverted (honeypot)"; return result;
    }
  }
  if (buyOut && buyOut > 0n && buyOut !== -1n) {
    try {
      const sellAmt = buyOut > (2n ** 127n - 1n) ? (2n ** 127n - 1n) : buyOut;
      const [out2] = await client.readContract({
        address: chain.v4Quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
        args: [[c0, c1, pool.fee, pool.tickSpacing, pool.hooks], !zeroForOneBuy, sellAmt, "0x"],
      });
      const sellOut = BigInt(out2);
      if (sellOut === 0n) {
        fail("honeypot-sell", "quoter sell returns 0 — likely honeypot");
        result.reason = "quoter sell returns 0"; return result;
      }
      const ratio = Number((sellOut * 10000n) / probeIn) / 100;
      if (ratio < 50) {
        fail("honeypot-sell", "sell returns only " + ratio.toFixed(1) + "% of buy input — likely honeypot/tax");
        result.reason = "sell returns <50% (honeypot/tax)"; return result;
      }
      pass("honeypot-sell", "sell returns " + ratio.toFixed(1) + "% of buy input");
    } catch (e) {
      fail("honeypot-sell", "V4Quoter sell reverted: " + e.message.slice(0, 100));
      result.reason = "quoter sell reverted"; return result;
    }
  }

  // Check 8: token-age gate (hard veto, Part 51 — user decision 2026-11-08
  // ~07:42 WIB). Only buy tokens whose FIRST pool is < 24h old. Placed
  // AFTER the honeypot sim so tokens failing cheap gates never cost an
  // indexer call. Fail-open: age unknown -> allow, logged — never stall
  // the watcher. TOKEN_AGE_ENABLED=0 disables the check (testing/escape).
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

  // Check 9: minimum-500-tokens rule (hard gate, Part 51 — user decision
  // 2026-11-08 ~07:45 WIB). The $0.02 buy must yield >= 500 whole tokens.
  // Expected output at the REAL buy size: quoter first (includes fees and
  // hook taxes), spot fallback via trade.spotOutput when the quoter reverts
  // on a hooked pool. Unresolvable output (0/unknown) also skips — if we
  // cannot verify >= 500 tokens, we do not buy (FOBO: 2.43 tokens at an
  // unresolvable 0 price). MIN500_ENABLED=0 disables the check (testing).
  if (process.env.MIN500_ENABLED !== "0") {
    try {
      const amountIn = await trade.buyAmountInQuote(cfg, chain, quote, client);
      let expectedOut = null;
      try {
        const [out] = await client.readContract({
          address: chain.v4Quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
          args: [[c0, c1, pool.fee, pool.tickSpacing, pool.hooks], zeroForOneBuy, amountIn, "0x"],
        });
        expectedOut = BigInt(out);
      } catch { expectedOut = null; /* quoter reverts on hooked pools — spot fallback below */ }
      if (expectedOut === null || expectedOut === 0n) {
        try {
          expectedOut = trade.spotOutput(amountIn, state.sqrtPriceX96, decimals, quote.decimals, zeroForOneBuy);
        } catch { expectedOut = null; }
      }
      if (expectedOut === null || expectedOut === 0n) {
        fail("min-500-tokens", "buy output unresolvable at $" + (cfg.buySizeUsd || 0.02) + " size (quoter reverted, spot returned 0) — cannot verify >= 500 tokens");
        result.reason = "buy output unresolvable (< 500 tokens unverifiable)"; return result;
      }
      const expectedWhole = Number(expectedOut) / 10 ** decimals;
      result.expectedBuyTokensWhole = expectedWhole;
      if (expectedWhole < MIN_BUY_TOKENS_WHOLE) {
        fail("min-500-tokens", "expected output " + expectedWhole.toFixed(2) + " whole tokens < " + MIN_BUY_TOKENS_WHOLE + " (price ~$" + ((cfg.buySizeUsd || 0.02) / expectedWhole).toExponential(2) + "/token)");
        result.reason = "expected output " + expectedWhole.toFixed(2) + " tokens < 500"; return result;
      }
      pass("min-500-tokens", "expected output " + expectedWhole.toFixed(2) + " whole tokens >= " + MIN_BUY_TOKENS_WHOLE);
    } catch (e) {
      fail("min-500-tokens", "buy size uncomputable: " + e.message.slice(0, 100));
      result.reason = "buy size uncomputable (min-500 unverifiable)"; return result;
    }
  } else {
    pass("min-500-tokens", "disabled (MIN500_ENABLED=0)");
  }

  // ---- Scoring 0-100 (all soft — none of these fail the pool) ----
  // Social/website +25.
  try {
    const s = await social.scoreSocial(chain.dexscreenerSlug, token, cfg);
    scores.push({ component: "social-website", points: s.points, max: 25, detail: s.detail });
    result.social = s;
  } catch (e) {
    scores.push({ component: "social-website", points: 0, max: 25, detail: "social check errored: " + e.message.slice(0, 80) });
  }

  // Verified contract +10 (Sourcify; 0 if the check fails — never a hard fail).
  try {
    const m = await chains.sourcifyMatch(chain.chainId, token);
    scores.push({ component: "verified-contract", points: m.verified ? 10 : 0, max: 10, detail: m.verified ? "Sourcify match: " + m.match : "not verified on Sourcify (or check failed)" });
  } catch {
    scores.push({ component: "verified-contract", points: 0, max: 10, detail: "Sourcify check failed" });
  }

  // Liquidity depth +15 (from the probe's buy impact; quoter-inconclusive -> +5).
  if (quoterWorked && buyImpact !== null) {
    const pts = buyImpact <= 0.01 ? 15 : buyImpact <= 0.05 ? 10 : buyImpact <= 0.10 ? 5 : 0;
    scores.push({ component: "liquidity-depth", points: pts, max: 15, detail: `probe buy impact ${(buyImpact * 100).toFixed(2)}% (probe size, understates a $1 buy)` });
  } else {
    scores.push({ component: "liquidity-depth", points: 5, max: 15, detail: "quoter inconclusive (hook); active liquidity > 0 + transfer sim proven — partial credit" });
  }

  // LP locked +10 — NOT checkable at T+0 for V4 (positions are NFTs, no
  // generic lock registry). Scored 0; re-check at +60 min in a future pass.
  scores.push({ component: "lp-locked", points: 0, max: 10, detail: "not checkable at T+0 for V4 (positions are NFTs) — re-check at +60 min" });

  // Deployer history +10: first-time deployer +5; rug-linked -20 = VETO.
  // The veto is live (registries.js KNOWN_RUG, Part 50 — confirmed scams
  // only) AND covers the token itself, not just the deployer. The legacy
  // config.knownRugDeployers list is unioned in for backward compat.
  // Fail-open: a broken registry degrades to the config list only.
  let veto = false;
  try {
    const receipt = await client.getTransactionReceipt({ hash: pool.txHash });
    const deployer = (receipt.from || "").toLowerCase();
    result.deployer = deployer;
    result.creatorContract = (receipt.to || "").toLowerCase() || null;
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

  // Memory adjustment ±25 (2026-11-08, memory.js — aegis-style Second Brain):
  // deployer reputation from past launches with resolved outcomes.
  // Unknown deployers get 0 — never penalize the unknown. The known-rug
  // VETO above stands regardless of memory. Lazy require inside try/catch
  // so a broken/unavailable memory store degrades to 0, never to a crash.
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
  // Part 48). Free, no key, covers Robinhood 4663 + Arc 5042 (live-verified).
  // The onchain honeypot sim stays primary: a GoPlus honeypot flag only
  // costs -5, never a veto. Fail-open: any error/timeout -> 0 points.
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
      excludeAddresses: [chain.poolManager],
    });
    result.holders = h;
    scores.push({ component: "holder-concentration", points: h.points, max: 5, detail: h.detail });
  } catch (e) {
    scores.push({ component: "holder-concentration", points: 0, max: 5, detail: "holders: lookup failed (fail-open): " + e.message.slice(0, 80) });
  }

  // Smart-money signal [0, +15] (2026-11-09, smart-money.js — Part 55).
  // +10 when >=1 watchlisted wallet bought this token and still holds it;
  // +15 when >=2. Detection reads the pool's Swap events onchain and
  // checks each swap tx's `from` (the V4 Swap sender is the router, not
  // the buyer). The token must still pass EVERY gate — this only adds
  // points. Fail-open: any error -> 0 points. Never a veto.
  try {
    const sm = require("./smart-money.js");
    const s = await sm.scoreSmartMoney(chain, {
      client,
      poolId: pool.poolId,
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

  // No impersonation +5.
  const symUpper = (symbol || "").toUpperCase();
  if ((cfg.knownTokens || []).includes(symUpper)) {
    scores.push({ component: "no-impersonation", points: 0, max: 5, detail: "symbol " + symUpper + " matches a known token — possible impersonation" });
  } else {
    scores.push({ component: "no-impersonation", points: 5, max: 5, detail: "symbol " + symUpper + " is not a known-token symbol" });
  }

  // Early traction +15 — T+5-60 min only, 0 at detection.
  scores.push({ component: "early-traction", points: 0, max: 15, detail: "T+0 — only scorable at T+5-60 min (re-score only)" });

  // Launchpad provenance +5 — registries.js (Part 50). Matches the
  // Initialize tx `to` against launchpad factories/portals and the pool
  // hooks against launchpad hooks. Unknown launchpad = 0, never negative.
  // A registry-level veto (veto: true on the entry — none today) also
  // vetoes the pool here. Fail-open: a broken registry scores 0.
  try {
    const tx = await client.getTransaction({ hash: pool.txHash });
    const to = (tx.to || "").toLowerCase();
    const reg = require("./registries.js");
    const lp = reg.scoreLaunchpadLive(chain.chainId, { txTo: to || null, hooks: pool.hooks || null, lpOwner: null });
    result.launchpad = lp.launchpad ? { id: lp.launchpad.id, name: lp.launchpad.name, status: lp.launchpad.status } : null;
    scores.push({ component: "launchpad-provenance", points: lp.points, max: 5, detail: lp.detail });
    if (lp.veto) veto = true;
  } catch (e) {
    scores.push({ component: "launchpad-provenance", points: 0, max: 5, detail: "launchpad registry lookup failed (fail-open): " + e.message.slice(0, 80) });
  }

  // Total clamped to [0, 100]: the memory adjustment (±25) can otherwise
  // push a strong pool over 100 or a vetoed pool below 0. Thresholds
  // (>=70 full, >=45 half) are unchanged.
  const total = Math.max(0, Math.min(100, scores.reduce((a, s) => a + s.points, 0)));
  result.score = total;
  result.scores = scores;

  if (veto) {
    result.verdict = "SKIP";
    result.reason = "rug-linked deployer (veto)";
    result.size = null;
    recordToMemory(result, pool);
    return result;
  }
  const t = cfg.scoreThresholds || { full: 70, half: 50 };
  result.verdict = "PASS";
  result.reason = "all hard gates passed";
  result.size = total >= t.full ? "full" : total >= t.half ? "half" : "watch";
  recordToMemory(result, pool);
  return result;
}

// Record a scored evaluation in memory (fail-open: never throws, never
// blocks evaluation). Decision intent at evaluate time; run.js upgrades
// it to buy / cap-skip / balance-skip once the runner knows the outcome.
function recordToMemory(result, pool) {
  try {
    const mem = require("./memory.js");
    mem.recordEvaluation({
      chainId: result.chainId,
      token: result.token,
      poolId: result.poolId,
      deployer: result.deployer || null,
      creatorContract: result.creatorContract || null,
      symbol: result.symbol,
      quoteSymbol: result.quote ? result.quote.symbol : null,
      quoteAddress: result.quote ? result.quote.address : null,
      source: "v2",
      score: result.score,
      scoreBreakdown: result.scores,
      decision: result.verdict === "SKIP" ? "skip" : (result.size === "watch" ? "watch" : "would-buy"),
      firstPrice: result.spotQuotePerToken ?? null,
      firstPriceQuote: result.quote ? result.quote.symbol : null,
    });
  } catch (e) { /* fail-open: memory must never break evaluation */ }
}

// CLI: node evaluate.js <chainId> <poolId>
if (require.main === module) {
  const cfg = require("./config.json");
  const chainId = Number(process.argv[2]);
  const poolId = process.argv[3];
  if (!chainId || !poolId) { console.log("usage: node evaluate.js <chainId> <poolId>"); process.exit(1); }
  const chain = { chainId, ...cfg.chains[String(chainId)] };
  if (!chain.poolManager) { console.log("chain not configured:", chainId); process.exit(1); }
  (async () => {
    const client = chains.makeClient(chain);
    const latest = await client.getBlockNumber();
    const logs = await chains.rawGetLogs(client, {
      address: chain.poolManager,
      topics: [chains.INITIALIZE_TOPIC0, poolId],
      fromBlock: Number(latest - 1000000n), toBlock: Number(latest),
    });
    if (logs.length === 0) { console.log("pool not found on", chain.name); process.exit(1); }
    const pool = chains.decodeInitialize(logs[0]);
    const r = await evaluatePool(cfg, chain, pool);
    for (const c of r.checks) console.log(c.pass ? "  PASS" : "  FAIL", c.check, "-", c.pass ? c.detail : c.reason);
    for (const s of r.scores) console.log("  SCORE", s.component, s.points + "/" + s.max, "-", s.detail);
    console.log("=== VERDICT:", r.verdict, "score", r.score, "size", r.size, "-", r.reason, "===");
  })().catch((e) => { console.error("EVALUATOR ERROR:", e.message); process.exit(1); });
}

module.exports = { evaluatePool };
