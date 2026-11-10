# Sniper v2 — Dry-Run Test Record

**Date:** 2026-11-07 ~16:38–16:40 GMT+7 (09:38–09:40 UTC)
**Mode:** DRY-RUN only. `config.live=false`, all chains `live=false`.
**No transactions sent. No funds spent. No v1 files touched.**

## Test 1 — Runner, Robinhood + Base, last 300 blocks (09:38:26 UTC)

- Robinhood 108309842..108310142: **4 new pools** — 3 SKIP (not a quote pair),
  1 SKIP (no active liquidity).
- Base 54269368..54269668: **1 new pool** — SKIP (not a quote pair).
- Result: watcher scans, decodes Initialize logs, and evaluates correctly.

## Test 2 — Runner, Robinhood + Base, last 3000 blocks (09:38:40 UTC)

- Robinhood 108307272..108310272: **9 new pools**
  - 5 SKIP (not a quote pair), 2 SKIP (no active liquidity),
  - 1 SKIP (native-ETH pair — currency0 = address(0), correctly not a WETH pair),
  - **1 PASS — Al-Buqqi** (`0xe1927371f12895be04330bbe9d4cd69bdf2d0087`,
    WETH pair, pool `0xea81981f…`):
    score **10/100** — social 0, verified 0, depth 5 (quoter inconclusive,
    hook; transfer-sim fallback), LP locked 0, deployer 0, impersonation 5,
    traction 0, launchpad 0 → **WATCH** (below 50, no buy).
    Queued for the +10 min social re-check.
- Base 54266767..54269767: **8 new pools** — 4 SKIP (not a quote pair),
  3 SKIP (no active liquidity), 1 SKIP (native-ETH pair).
- Totals across Tests 1+2 (deduplicated windows overlap): **17 pools seen,
  1 passed hard gates (5.9%), 0 would-buy.** Matches v1's observed rate
  (~1 in 9 new pools is a WETH pair).

## Test 3 — Re-evaluate a v1 buy: Alon (09:38 UTC)

`node evaluate.js 4663 0x3ddc0b2b…` (Alon, bought live by v1 at ~08:59 GMT+7):
all hard gates PASS (liquidity 2.468e25, fee 0, WETH pair, ERC-20 OK, no
dangerous selectors, quoter inconclusive → transfer-sim PASS).
Score **10/100** — social **0** (Dexscreener info still `null` ~7h after
creation), verified 0, depth 5, LP locked 0, deployer 0 (nonce 1057),
impersonation 5, traction 0, launchpad 0 → **WATCH**.

**Honest finding:** under v2 scoring, Alon (and by the same pattern the other
4 v1 buys, all info:null at detection) would have been **watch-only at T+0**,
not a buy. The social component (+25) is the main lever, and new launches
almost never have Dexscreener info at detection. This matches the design's
honest limit (§6.5): no T+0 signal predicts upside; the score gates size,
it does not find winners.

## Test 4 — Social scoring, positive control: PEPE (Ethereum)

`scoreSocial('ethereum', 0x69825081…)`:
website https://www.pepe.vip/ **loads (200)** + 1 social (twitter) → **20/25**.
Proves the social path works when info exists. (Website + ≥2 socials = 25.)

## Test 5 — +10 min social re-check branch

Al-Buqqi's pending entry was aged to 11 min old and the runner re-ran:
`[recheck Robinhood] Al-Buqqi — social re-check at +10 min: 0/25
(info:null on Dexscreener)`. Entry consumed. Branch works; the token still
has no Dexscreener info ~1.5h after creation.

## Test 6 — Arc + Polygon watchers, last 300 blocks (09:39:38 UTC)

- Arc 29987502..29987802 (Blockdaemon logs RPC): **2 new pools** — both SKIP
  (not a quote pair; native-USDC pairs, currency0 = address(0)).
  Arc log scanning works (main Arc RPC returns 0 for eth_getLogs — the
  per-chain `logsRpc` is used).
- Polygon 96892316..96892616: **0 new pools** in 300 blocks (fewer V4
  launches on Polygon; watcher itself works).

## Test 7 — Trade stub (calldata only, no send)

`buildBuy` for Alon's pool (WETH quote, $1 size at the approximate $2500
ETH price = 0.0004 WETH):
1. wrap ETH→WETH (0.0004 ETH) → 2. approve WETH→Permit2 → 3. Permit2 approve
   WETH→Router → 4. router execute V4_SWAP (data len 2250, PoolKey nested
   tuple). Correct 4-tx v1 sequence. (Hook address in the smoke test was a
   placeholder 0x0; quoter fell back to spot pricing for minOut — the
   calldata shape, not the price, was under test.)

## Test 8 — Live gates (all must refuse)

- `assertLiveAllowed` with `config.live=false` → **refused** ("config.live
  is false (dry-run mode)").
- Polygon with `live=true` everywhere + `{ liveConfirm: true }` →
  **refused** ("Polygon execution is blocked").
- Base with master `live=true` but chain `live=false` → **refused**
  ("chain Base live flag is false").

## Summary counts

| Chain | Blocks scanned | Pools seen | Hard-gate PASS | Would-buy |
|---|---|---|---|---|
| Robinhood | 3,300 (300 + 3,000) | 13 | 1 (Al-Buqqi) | 0 |
| Base | 3,300 | 9 | 0 | 0 |
| Arc | 300 | 2 | 0 | 0 |
| Polygon | 300 | 0 | 0 | 0 |
| **Total** | **7,200** | **24** | **1** | **0** |

Plus the direct re-evaluations: Alon (PASS, 10/100, WATCH) and PEPE social
(20/25). **Zero transactions sent in all tests.**

---

## Expanded quotes: all verified tokens + tokenized stocks (2026-11-07 ~18:30–18:45 GMT+7)

User Go chain: 18:21 USDC pairs allowed; 18:23 stock pairs YES; 18:24 all EVM
chains; 18:25 ALL verified tokens + stocks; 18:25 "Go for all" (live, once
dry-run passes, Arc/Base/Robinhood only). Build + dry-run in a COPY
(`/tmp/v2-expansion-test/`, flag true, live=false); live config stayed gated
(`expandedQuotesEnabled=false`) until the tests below passed. Zero
transactions sent in all tests. v1 untouched.

### What was verified onchain (this session, fresh checks)

- **ERC-8056 — the economic-balance function is `uiMultiplier()`:**
  `balanceOfUI = balanceOf × uiMultiplier / 1e18` (both in the token's
  decimals). Verified by calling it on AAPL, NVDA, TSLA, SPY: AAPL mult
  1.000566, NVDA 1.000775, TSLA 1.0, SPY 1.001718. All 203 Robinhood stock
  tokens respond to `uiMultiplier()` (code + name/symbol/decimals + mult
  checked). Base B20 tokens also respond (dec 8, NOT 18; precompiles, code=1B).
  Ondo/xStocks `uiMultiplier()` REVERTS (not ERC-8056) — priced as plain
  ERC-20 with multiplier 1e18. Worked example (NVDA): $0.02 buy =
  106,207,364,944,776 raw units → UI shares 1.062897e-4 → $0.02000 exactly.
- **Robinhood stock pools are REAL and common:** last 50,000 blocks to
  108373875: 208 new pools, 65 stock-touching (31%), ALL memecoin/stock, all
  dynamic fee 0x800000, ZERO stock/stable, stock/WETH or stock/stock. Stock
  legs: SPCX 18, AMC 16, HIMS 13, NVDA 7, MRNA 3, AMD 2, TTWO 2, GLD/META/
  TSLA/FIG 1 each. Dominant creator `0x5ff137d4...` (39/40 sampled, 23,689B
  code) — NOT o1/Pons/Bow Fun, unidentified; NOT added to the launchpad
  registry. o1 factories verified (code 24.4KB/23.9KB): RH Standard
  `0xcE9C48cFa068947f77738c81Be406B53338E5B0d`, RH Tax
  `0x29CAD997f3cf1aa9CA51E12BE29C09E3E00F119A`, Base Standard
  `0x1176122eb77AD6a2339322Cda7C4D7ea9BfA63dC`, Base Tax
  `0x53C59d8d335681d58F564cF62073fA3C57cF81ee`.
- **Token matrix re-verified onchain (code + name/symbol/decimals/totalSupply)
  across 7 chains:** WETH/WPOL/WBNB, USDC, USDT, DAI, WBTC/cbBTC/BTCB, USDG,
  EURC all OK. Two research-note addresses were WRONG and were corrected by
  fresh checks: Polygon DAI `0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063`
  (research note truncated, missing trailing 063; verified: code 2949B, DAI,
  dec 18); Arbitrum WBTC `0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f`
  (research note missing final 'f'; verified: code 760B, WBTC, dec 8).
  Traps confirmed in config notes: BSC stables are 18 dec (not 6); Robinhood
  USDC has a "Universal Stable Digital Coin" impostor (different contract);
  Base USDC `0x8335...` vs USDbC `0xd9aA...` are different contracts; Arc USDC
  is the native-gas face `0x3600...`. Polygon USDT onchain symbol is `USDT0`,
  Arbitrum USDT is `USD₮0` (labels only, dec 6 OK).
- **Base B20 (Coinbase tokenized stocks):** 7/7 verified responding (AAPLc,
  NVDAc, TSLAc, MSFTc, GOOGLc, AMZNc, METAc; dec 8; `uiMultiplier()` works).
  Prices: AAPLc $342.98, NVDAc $188.30, TSLAc $359.03, MSFTc $531.53, GOOGLc
  $285.80, AMZNc $259.89, METAc $612.94. B20 approve-via-Permit2 UNPROVEN —
  first live B20 buy may fail at approve (gas only). Base scan (20k blocks):
  0 B20-paired new pools, 1 other expanded-quote pool — B20 launches don't
  exist yet; quotes are wired for future launches.
- **Ondo/xStocks:** exist as tokens (NVDAon/AAPLon/AAPLx on Eth; AAPLon/NVDAon
  on BSC) but 0 Dexscreener pairs anywhere — no pools yet; wired, never
  triggers until a pool appears. Backed/Dinari: no verifiable pool presence;
  not wired.
- **Prices used:** BTC $75,905, ETH $2,243 (CoinGecko 2026-11-07); all 203 RH
  stock prices from GeckoTerminal multi (186 fetched this session + 17
  earlier); stock token prices are per-quote `approxUsdPrice` in config.
- **Arc:** no stock-token system exists there — no new quotes on Arc (USDC/
  EURC only). Polygon/Arbitrum/Ethereum/BSC quotes wired in config but those
  chains stay disabled (Polygon execution-blocked, Phase 2 unverified).

### Code changes (v2 only)

- `config.json`: `expandedQuotesEnabled` gate (false until enable); every new
  quote marked `"expanded": true`, stocks also `"stock": true`, B20 also
  `"b20": true`, each with `approxUsdPrice`. Quote counts: Robinhood 3→208
  (205 expanded, 203 stocks), Base 2→13 (11 expanded, 7 stocks), Eth 2→9,
  BSC 3→7, Polygon 2→5, Arbitrum 2→6, Arc 2→2 (unchanged). `knownTokens`
  8→221 (all 203 stock symbols + B20 + Ondo/xStocks, for impersonation
  scoring). `launchpadContracts`: o1 factories (RH + Base) — added to live
  config ONLY at enable time (see below).
- `evaluate.js` check 1: expanded quotes usable only when the flag is true;
  a gated expanded quote fails with an explicit "(gated off)" reason; the
  fail message lists legacy symbols + expanded count (not 203 symbols).
  `result.quote` now carries `stock`/`b20`/`approxUsdPrice`/`expanded`.
  Pool math (probe, honeypot sim, depth) is raw-unit based — correct for
  stocks unchanged; the multiplier matters only for USD sizing.
- `trade.js`: `buyAmountInQuote` is now async — price from
  `quote.approxUsdPrice` first, else `APPROX_USD_PRICE` (ETH updated
  2500→2243, BTC 75905 added); stock sizing
  `raw = usd × 10^dec × 1e18 / (price × uiMultiplier)` via new
  `quoteMultiplier()` (live `uiMultiplier()` call; revert → 1e18). New
  `checkQuoteBalance()` — pre-buy guard: skips + logs BALANCE-SKIP when the
  agent holds < amountIn of the quote (agent holds 0 of every new quote, so
  without this a passing pool would burn gas on a doomed approve).
- `run.js`: live branch calls the balance guard before `buildBuy`; a
  BALANCE-SKIP never counts as a snipe. `priceQuotePerToken` unchanged —
  relative P&L is multiplier-invariant in raw units (documented in code).
  Known pre-existing gap (out of scope): run.js never records positions, so
  sell rules never trigger.

### Test 5 — Real NVDA pool, evaluator, flag true (18:41 GMT+7)

`node evaluate.js 4663 0x1c5ca4ccfe9030ee72a4d45ca0c491bf4eac041c2b2532ac56729e4e15927cf3`
(memecoin `0x2077...` / NVDA, block 108339042): **PASS** — liquidity OK,
quote-pair PASS ("NVDA is currency1"), ERC-20 OK (Orgasm Factory OF, 18 dec,
1B supply), no dangerous selectors, honeypot buy+sell PASS (transfer sim).
Score **10/100** (social 0, verified 0, depth 5, LP 0, deployer 0,
impersonation 5, traction 0, launchpad 0 — creator is the unidentified
`0x5ff1...`, not o1) → **WATCH**. Same pool, flag false: **SKIP** —
"NVDA is an EXPANDED quote but expandedQuotesEnabled=false (gated off)".
Gate proven both ways.

### Test 6 — Sizing + balance guard, 13 quote types + 4 guard cases

All implied USD ≈ $0.02: NVDA $0.02000 (mult 1.000775, 106,207,364,944,776
raw), AAPL $0.02000 (mult 1.000566), AMC $0.02003 (mult 1.0), WBTC $0.01974
(26 raw — floor rounding), USDT $0.02000, WETH $0.02000 (legacy path
unchanged), NVDAc $0.02000 (B20, mult 1.000538, 10,615 raw), AAPLc $0.02000,
DAI $0.02000, cbBTC $0.01974, NVDAon $0.02000 (revert → mult 1e18), Polygon
DAI $0.02000, Arbitrum WBTC $0.01974. Guards: RH NVDA ok=false (balance 0),
RH WBTC ok=false (balance 0), RH WETH ok=true (balance 0.0000223824 ETH >
0.0000089166 needed — funds exactly 1 buy), Arc USDC ok=true (98,111 >
20,000 units).

### Test 7 — buildBuy calldata for the NVDA pool (dry-run, no send)

`buildBuy` for the Test 5 pool: amountIn 106,207,364,944,776 raw NVDA
(= $0.02000), amountOutMinimum 1,404,600,672,190,474,485,760 OF, 3 txs
(approve NVDA→Permit2, Permit2 approve NVDA→Router, router execute
V4_SWAP). No wrap step (NVDA is not WETH). Calldata builds correctly.

### Test 8 — Full runner dry-run, 2,000 blocks × 3 live chains (18:41 GMT+7)

`node run.js --chains 4663,8453,5042 --window-blocks 2000` (test copy,
live=false): Robinhood 13 pools (6 WATCH score 10–15, 7 SKIP), Arc 7 pools
(all SKIP), Base 9 pools (all SKIP). **0 would-buys, 0 errors.** Two SPCX-
paired pools were DETECTED as stock pairs (passed quote-pair) and skipped
only on "no active liquidity" — the quote gate works in the runner. Legacy
behaviour unchanged (Arc/Base all-SKIP as before; no new quotes on Arc).
**Zero transactions sent.**

### Enable (after tests passed)

Live config: `expandedQuotesEnabled` false→true, o1 factories restored into
`launchpadContracts`. Then one live cycle `node run.js --chains
5042,8453,4663 --live` + next watcher cycle watched. See LOG.md / parent
report for the live outcome.

### Test 9 — Position recording fix (2026-11-07 ~18:48 GMT+7)

**Bug:** the live buy branch in `run.js` incremented `snipesDone` and logged
BOUGHT but never pushed anything into `state.positions`. The management loop
iterates `state.positions`, so it stayed empty forever and the +100% sell-half
/ −50% sell-all rules could never fire on a bought token. (Found before any
v2 buy happened — 0 buys in live LOG.md, nothing at risk, no migration needed.)

**Fix (run.js only, no trade.js change needed):** after a successful
`executeTxs`, the buy branch now reads the pool state fresh
(`chains.readPoolState`) and computes `buyPriceQuotePerToken` with the same
`priceQuotePerToken` the management loop uses, then pushes a full position
record: `{ chainId, symbol, token, decimals, poolId, poolKey, quote
{ symbol, address, decimals }, buyPriceQuotePerToken, buyPriceSource
("post-buy" or "init-event" fallback), amountIn, buyTxHashes, boughtAt,
soldHalf: false, soldAll: false }`. `poolId` is required because the loop
reads state via `readPoolState(poolManager, pos.poolId)`. Dry-run "would BUY"
records NOTHING (nothing was bought). All inputs verified to exist:
`res.poolKey` carries `poolId` (evaluate.js:122), `buildBuy` returns
`amountIn`, `executeTxs` returns `{ hash }` results. No live flags, caps,
snipesDone seeding, cron, scoring, or gates changed. No transaction sent.

**Proof (dry-run only, test copy at /tmp/v2-pos-test with its own STATE.json
and LOG.md — live STATE.json untouched, md5 43e826e1df3edbf2c4b539d1d9925113
before and after):** seeded a real Robinhood pool (CANCERINU/WETH
`0x20cc13…`, block 108313807; current price 1.642e9 WETH/token via
`readPoolState`) with three buy prices and ran the copy's runner
(`node run.js --chains 4663`, no `--live`):
- A: buy = current/2.1 → change **+110.0%** → `would SELL 50% of CANCERINU
  at +110% — DRY-RUN` ✓
- B: buy = current×2.1 → change **−52.4%** → `would SELL ALL of CANCERINU
  at −52% — DRY-RUN` ✓
- C (control): buy = current → change **0.0%** → position line only, no sell ✓
Fallback check: buy price from the Initialize-event `sqrtPriceX96`
(1.658e9) computes cleanly, ~1% stale vs live — sane fallback if the fresh
read ever fails. Dry-run runs left `soldHalf`/`soldAll` false (no mutation).
**Zero transactions sent.**

## Polygon (137) — dry-run for live enablement (2026-11-07 ~19:01–19:35 GMT+7)

**Task:** user GO "Do snipping on Polygon too" + "Go". Same rules ($0.02 buys,
cap 5, ≥70 full / 50–69 buy / <50 watch). Known blocker: Privy CLI `rpc`
broadcast FAILS on Polygon; workaround = sign via `eth_signTransaction` +
broadcast raw via public RPC. Restore Privy machine identity before every CLI
call.

**VERDICT: DRY-RUN FAILED — Polygon stays GATED (live=false,
executionBlocked=true, unchanged).** The sign path, pool scanning, scoring,
and sizing all pass, but the router-execution proof FAILS: the legacy v1
Universal Router 0x3fC9… on Polygon cannot execute a V4_SWAP — the swap
reverts inside `PoolManager.swap` with empty data on liquid pools, on Polygon
AND on Base (same router). The encoding itself is proven correct (see Test E
+ Test I); the failure is the router/PoolManager path on 0x3fC9 chains. Per
the task rule, a failed verification gates the chain off — the Go does not
override it. **Zero transactions sent in the whole dry-run. Live config.json
and STATE.json untouched.**

### Onchain verification (Polygon, publicnode, 2026-11-07)
- PoolManager 0x67366782805870060151383f4bbff9dab53e5cd6 — code 24,009 B.
- Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3 (F6B) — code 9,152 B.
- Universal Router v1 (legacy) 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD —
  code 35,918 B.
- Universal Router V2 0x1095692a6237d83c6a72f3f5efedb9a670c49223 — code 39,000 B.
- V4Quoter 0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9 — code 5,820 B.
- PositionManager UNVERIFIED (null in config; not needed for swaps).
- RPC: polygon-bor-rpc.publicnode.com (polygon-rpc.com DEAD). viem `getLogs`
  over 20k blocks FAILS on publicnode (range cap); raw `eth_getLogs` in
  ≤2000-block chunks works. Llamarpc timed out (unreliable from this VM).
- Quote allowlist (all verified: code + name/symbol/decimals):
  WPOL 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 (18 dec, "Wrapped Polygon
  Ecosystem Token"); USDC 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 (6 dec);
  USDT0 0xc2132D05D31c914a87C6611C10748AEb04B58e8F (6 dec, "USDT0");
  DAI 0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063 (18 dec, "(PoS) Dai
  Stablecoin"); WBTC 0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6 (8 dec,
  "(PoS) Wrapped BTC").
- **Agent Polygon token balances all 0** (USDC/USDT0/DAI/WBTC/WPOL) — only
  native POL held. So only WPOL pairs are buyable on Polygon; all
  stablecoin/BTC pairs BALANCE-SKIP.
- **Polygon V4 is quiet:** 12 pools in last 20k blocks (~11h), 58 in last
  100k, 138 in last ~1.1M blocks (~12 days). WPOL pairs are rare: ~1 in 200
  pools over 12 days. **Healthy pools are NATIVE-POL pairs** (currency0 =
  0x0) — the evaluator's check 1 matches only the ERC-20 quote allowlist, so
  native-POL pools SKIP as "not a quote pair". Even a funded Polygon bot would
  buy very rarely under the current quote model (native-quote support would be
  a separate scoring/build change — NOT attempted here).
- **Liquid quote-pair pools that exist are junk:** the liquid USDT0 pairs
  found (6 in the scan) all have 89–99% fees (e.g. 0x8acc… fee 989999).

### Code change (LIVE `~/workspace/tokens/sniper/v2/trade.js`, Polygon-only)
Arc/Base/Robinhood path, v1 sniper, scoring, gates, caps untouched.
- Constants: POLYGON_CHAIN_ID 137, POLYGON_MAX_GAS_GWEI 100,
  POLYGON_RESERVE_WEI 0.16 POL, POLYGON_MIN_TIP_WEI 25 gwei,
  POLYGON_ROUTER_EXECUTE_GAS_FALLBACK 600000.
- New: `signTxPolygon` (Privy CLI `eth_signTransaction`; NO top-level caip2;
  chain_id INSIDE params.transaction; snake_case gas fields only; parses
  `data.signed_transaction` — snake_case, discovered empirically),
  `broadcastRawPolygon` (eth_sendRawTransaction via publicnode + receipt
  wait), `polygonGuardCheck` (gas ceiling 100 gwei → GAS-SKIP; reserve floor
  0.16 POL per tx → RESERVE-SKIP, bundle stops), `polygonFeeParams`
  (tip 25 gwei = 0x5d21dba00; max fee = base + tip + ~20% headroom, hex),
  `executeTxsPolygon`; `executeTxs` routes chainId 137 to the Polygon path.
  Header comment updated (old "blocked FOREVER" superseded).
- POL/WPOL price in trade.js static map fixed 0.2 → **0.0905** (live:
  Uniswap WPOL/USDT0 $0.09054, Dooar $0.09143, QuickSwap $0.09072;
  CoinGecko $0.126 lags). $0.02 buy = **0.220994475138121568 POL**.
- `buildRouterExecute` exported (test-only addition; pure function).

### Test A — runner dry-run, Polygon, last 2000 blocks
Ran (test copy /tmp/v2-polygon-test, live=false): **0 new pools** — genuine,
not a scan failure (see quietness above).

### Test B — sign path (PASSED, 4/4 txs)
Pool 0x3ce6d8b5014a3c0d39d3cc7255dbaa9137e94257daa2885ae167714dbdcee129
(block 96480611, WPOL + 0x8e23…, fee 990000, tickSpacing 1, no hooks;
liquidity 0). buildBuy: amountIn 220994475138121568 WPOL = $0.0200 exactly,
minOut 813233153903390208, 4 txs. Each signed via Privy CLI, decoded, sender
recovered to the agent, MATCH=true: wrap (est 30812 → limit 36974, nonce 3),
approve WPOL→Permit2 (47273 → 56727, nonce 4), Permit2 approve (51402 →
61682, nonce 5), router execute (estimateGas reverted as expected — no
allowance → fallback 600000, nonce 6). Guard check refused as expected
(GAS-SKIP at ~256 gwei > 100 ceiling). **0 transactions sent, 0 broadcast.**
Note: viem `parseTransaction` does NOT populate `from` (quirk) — manual
recovery via keccak256(serializeTransaction(unsigned)) + recoverAddress is
the correct check.

### Test C / C2 — router-encoding proof (FAILED — the gating failure)
eth_call of the built router execute calldata on the **liquid** USDT0 pool
0x8acc7cbaf01852d40446a44c00beac558ddf32a60d73f4e91dfdf559591c0233
(block 96887884, fee 989999, no hooks, liquidity 25,594,760,082,532, tick
326533): reverts `0x2c4029e9` + (0, 64, 0). 4byte.directory:
**`ExecutionFailed(uint256,bytes)`** — Universal Router: command 0 (the
V4_SWAP) failed with EMPTY inner revert data. Same on the dead WPOL pool
0x3ce6…, and with amountOutMinimum = 0 (rules out the minOut check).
The V4Quoter also reverts (empty) on the same pools.

### Test D — Base control (FAILED the same way)
Same legacy router 0x3fC9, same encoding, on a **liquid Base** USDC/PEPE pool
0xb57fe19cdc38d4ea56c2b78cdf71ed5a8a052a898e72462e7f90af7f86f7438d
(block 54276261, fee 4500, tickSpacing 90, no hooks, liq 64,344,446,987,749,002):
identical `ExecutionFailed(0, 0x)` with minOut=0. So the failure is NOT
Polygon-specific — it is the legacy router 0x3fC9 on every chain that uses it
(Polygon + Base + Eth). No liquid WETH-pair Base pool with fee <1% was found
in 240k blocks for a second Base sample. **Implication: v2's live Base chain
shares this execution failure — its first buy would revert the same way
(gas only).** Robinhood (fork router) and Arc (0x4fcA) are NOT affected.

### Test E — minHopPriceX36 (encoding CONFIRMED correct)
Same pool, same swap, but WITHOUT the `minHopPriceX36` field:
reverts `0x3b99b53d` = **`SliceOutOfBounds()`** (4byte.directory) — the router
ran out of input bytes because it EXPECTS that field. So v2's encoding
(with minHopPriceX36) is the correct struct for the legacy router; the
Test C failure is downstream, not a decode failure. (An ABI-decode failure
would also have produced a Panic with data, not empty data.)

### Test F — action isolation (swap itself fails)
V4_SWAP with actions SWAP-only (0x06), SWAP+SETTLE (0x060c), and full
(0x060c0f) all revert identically `ExecutionFailed(0, 0x)`. The failure is
inside the SWAP_EXACT_IN_SINGLE action — `PoolManager.swap` — not SETTLE
or TAKE. No-op `execute("0x", [], deadline)` on 0x3fC9 SUCCEEDS (router is
alive and dispatches commands). `poolManager()` / `PERMIT2()` getters revert
empty on 0x3fC9 (no such getters in the legacy router) — the router's
internal PoolManager pointer cannot be read directly; a stale/wrong
PoolManager immutable is the leading hypothesis for the empty swap revert.

### Test G — quoter (reverts on both chains)
V4Quoter `quoteExactInputSingle` reverts (empty) on the liquid Polygon
USDT0 pool AND the liquid Base USDC/PEPE pool. Consistent with the swap
itself failing at the PoolManager level, not a router-only issue. (Test H:
canonical Base WETH/USDC 0.3% poolId computed from WETH/USDC/3000/60 has
liquidity 0 / tick 0 — that pool does not exist on Base V4; control
inconclusive, not a quoter failure.)

### Test I — Robinhood fork router, POSITIVE control (PASSED)
Same v2 encoding, same minOut=0, on a liquid Robinhood pool
0xd2ac381a94e6e8773454f64436417300c20cc4755b96e64b9c367c7fb462bccd
(block 108398852, fee 800000, tickSpacing 8000, no hooks, liq
20,412,879,198,307) via the fork router 0x8876…: reverts
`0xd81b2f2e` + 0 = **`AllowanceExpired(uint256)`** (4byte.directory) — a
**Permit2 error**. The swap EXECUTED (pool math worked) and the failure is
the expected dry-run funds step (agent has no allowance). **This proves the
v2 encoding end-to-end.** The legacy router never reaches this step.

### Test J — Polygon V2 router probe (interface differs)
Same v1 encoding sent to the Polygon V2 router
0x1095692a6237d83c6a72f3f5efedb9a670c49223 (code 39,000 B; Base V2
0x6ff5693b99212da76ad316178a184ab56d299b43, same size): reverts with bare
empty data `0x` — the V2 router does NOT accept the v1 encoding. It needs
its own V4-swap encoding research, not a drop-in swap.

### POL budget math (verified onchain, block 96899044, 2026-11-07 ~19:35 GMT+7)
- Balance **5.5141593 POL** (unchanged since the +5 POL top-up; nonce still 3,
  no outgoing txs). Gas 287 gwei at check (baseFee ~250) — above the 100 gwei
  ceiling, so the guard would GAS-SKIP anyway.
- Reserve 0.16 POL → available 5.3541593. One buy ≈ 0.221 principal +
  ~0.03–0.08 gas (4-tx bundle ~756k gas worst case at ≤100 gwei). Five buys
  ≈ 1.105 principal + ~0.15–0.38 gas ≈ 1.25–1.5 total ≪ 5.354 →
  **full cap 5 fundable, NO pre-seed needed.** (Superseded: at 0.264159 the
  effective cap was 0; at 0.514159 it was 1.)
- **Budget is NOT the blocker.** The blocker is the router-execution proof
  above. The POL math is recorded so the cap is ready the moment execution
  is unblocked.

### What would unblock Polygon
1. **Research + prove the Universal Router V2 (0x1095… on Polygon,
   0x6ff5… on Base) V4-swap encoding** — the v1 encoding does not work on
   it (Test J). Needs the V2 router's V4_SWAP command byte + params struct
   from its source/docs, then the same eth_call proof (expect
   AllowanceExpired, as in Test I), then a sign-path test, then live.
2. **Or find/prove a working router for Polygon** (e.g. a fork like
   Robinhood's 0x8876, if one exists on Polygon) with the same proof.
3. The same fix also unblocks **Base** (same legacy router, same failure).
4. NOT unblocked by: more POL (budget already funds cap 5), lower gas
   (guard would still pass at ≤100 gwei — the swap reverts regardless), or
   a different pool (fails on liquid pools with normal fees too).

## Router V2 encoding — PROVEN on Polygon AND Base (2026-11-07 ~19:22–19:35 GMT+7)

**VERDICT: PROVEN.** The Universal Router V2 encoding executes a V4 swap on
both chains — the exact unblock for Polygon sniping and for live Base (whose
first buy would otherwise revert on the legacy router). **Zero transactions
sent in the whole task. Live config.json and STATE.json untouched — the
switch is reported below, NOT applied.**

### 1. What differs in V2 (from the deployed source, Sourcify full match)
- Polygon V2 router 0x1095692a6237d83c6a72f3f5efedb9a670c49223 — verified
  2026-06-27, compiler 0.8.26, 93 source files pulled via Sourcify v2 API
  (`?fields=sources`). Base V2 0x6ff5693b99212da76ad316178a184ab56d299b43 —
  verified 2025-04-13, same code.
- **The ONLY structural difference: V2's `ExactInputSingleParams` has NO
  `minHopPriceX36` field.** V2 struct (`IV4Router.sol`):
  `(PoolKey poolKey, bool zeroForOne, uint128 amountIn, uint128
  amountOutMinimum, bytes hookData)` — 5 fields. The v1 struct adds
  `uint256 minHopPriceX36` between amountOutMinimum and hookData.
  `CalldataDecoder.decodeSwapExactInSingleParams` confirms it (min length
  0x140 = 320 bytes = the 5-field layout); `minHopPrice` appears NOWHERE in
  the V2 source (the SDK's "v2.1.1+ per-hop bounds" is a newer version than
  the deployed routers). This is why the v1 encoding reverts bare-empty on
  V2: the hookData offset word lands on minHopPriceX36 (= 0), so the
  decoder reads hookData at offset 0.
- Everything else is IDENTICAL to v1: `execute(bytes,bytes[],uint256)`
  (same selector — both overloads exist in the V2 ABI), command `0x10`
  V4_SWAP, actions `0x060c0f` (SWAP_EXACT_IN_SINGLE 0x06, SETTLE_ALL 0x0c,
  TAKE_ALL 0x0f — same constants in `Actions.sol`), SETTLE/TAKE params
  `(address,uint256)`, and the V4_SWAP input shape
  `abi.encode(actions, params[])` dispatched via `_executeActions` →
  `poolManager.unlock` → `unlockCallback`.
- V2 router immutables READABLE (unlike legacy 0x3fC9, whose getters
  revert empty — Test F): Polygon V2 `poolManager()` =
  0x67366782805870060151383f4bbff9dab53e5cd6 (the real Polygon V4
  PoolManager, 24,009 B code); Base V2 `poolManager()` =
  0x498581fF718922c3f8e6A244956aF099B2652b2b.

### 2. Proof pools (normal-fee, liquid — found by fresh scan)
Polygon V4 is NOT all junk: scan of the last 500k blocks (raw eth_getLogs,
2k-block chunks, publicnode): 234 pools, 77 quote-pair, **16 normal-fee
(≤3%) quote pools**. Proof pool **GRT/USDT0
0x8e409e5e5f40a42de72f4ec002989dadd0eef78a63fb681b6792d0f58ae6edc0** —
fee 2500 (0.25%), tickSpacing 25, no hooks, liquidity ~1.07e17, block
96640738 (currency0 GRT 0x5fe2…, currency1 USDT0 0xc213…). Other liquid
normal-fee pools: CRV/USDT0 0x6668… (fee 2500, liq ~1.2e16), RST/USDC
0x284d… (fee 75, liq ~8.8e13), USDC/MKT 0x47ef… (fee 9000, liq ~4.0e14).
Base proof pool: the Test D pool **USDC/PEPE
0xb57fe19cdc38d4ea56c2b78cdf71ed5a8a052a898e72462e7f90af7f86f7438d** —
fee 4500, tickSpacing 90, no hooks, liq ~6.4e16, block 54276261.

### 3. eth_call proof (from the agent address, minOut = 0, $0.02 size)
- **Polygon V2 router + V2 encoding** (USDT0→GRT, zeroForOne=false,
  amountIn 20000 USDT0 units): reverts **`AllowanceExpired(uint256)`**
  (`0xd81b2f2e` + 0) — the SAME positive-control signature as Test I
  (Robinhood fork router). **The swap EXECUTED; only the dry-run funds
  step failed** (agent holds 0 USDT0 / no Permit2 allowance). PROVEN.
- Polygon V2 router + V1 encoding (control): bare empty revert `0x` —
  Test J reproduced on a normal-fee pool.
- **Base V2 router + V2 encoding** (USDC→PEPE, zeroForOne=true,
  amountIn 20000 USDC units): reverts **`AllowanceExpired(uint256)`**.
  PROVEN. V1 control: bare empty.
- Calldata: V2 encoding 1092 bytes vs V1 1124 bytes — exactly 32 bytes
  shorter, the dropped minHopPriceX36 word.
- Test-harness bug, caught and fixed (NOT a router issue): the first Base
  run compared a lowercase address to a checksummed one, inverting
  zeroForOne (PEPE→USDC with a USDC settle) and reverting with unknown
  selector `0x5212cba1` (not in 4byte.directory — likely a
  DeltaResolver/settlement error from settling the wrong currency). The
  corrected run reaches AllowanceExpired. The bug was in `/tmp/v2-proof.js`,
  not in trade.js or the router.

### 4. Sign-path test (PASSED — sign only, nothing broadcast)
V2-encoded router execute tx for the Polygon GRT/USDT0 pool, signed via
Privy CLI `eth_signTransaction` (machine identity restored first, per the
proven path; `trade.js signTxPolygon`): pending nonce 3, gas limit 600000
(router-execute fallback — estimation reverts without allowance), maxFee
325.3 gwei, tip 25 gwei. Decoded: to = V2 router 0x1095…, chainId 137,
nonce 3, EIP-1559. Recovered sender = agent wallet
0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4, **MATCH=true**. The signed raw
tx was NOT saved and NOT broadcast. Note: Polygon gas was 274.7 gwei at
signing — above the 100 gwei live ceiling, so the live guard would
GAS-SKIP anyway; signing itself costs nothing.

### 5. Fork-router alternative (checked, dead end)
Robinhood's fork router 0x8876… has **NO code on Polygon** — no fork
router exists there to fall back to. No further hunting (per task rule).

### 6. EXACT change needed to switch (REPORTED, NOT APPLIED)
- **config.json:** Polygon (137) `universalRouter`:
  0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD →
  0x1095692a6237d83c6a72f3f5efedb9a670c49223; Base (8453)
  `universalRouter`: 0x3fC9… → 0x6ff5693b99212da76ad316178a184ab56d299b43.
  Add a `routerVersion: 2` marker on both chains so the code can select
  the encoding.
- **trade.js:** add `buildRouterExecuteV2` — byte-for-byte identical to
  `buildRouterExecute` EXCEPT the `ExactInputSingleParams` tuple drops
  `minHopPriceX36` (5 fields). `buildBuy`/`buildSell` select the V2
  builder when `chain.routerVersion === 2`, else the v1 builder. Nothing
  else changes: same command 0x10, actions 0x060c0f, settle/take params,
  `execute(bytes,bytes[],uint256)`, deadline handling. The Permit2 approve
  step already targets `chain.universalRouter`, so it follows the config
  switch automatically. The sell path uses the same builder, so it follows
  too. The V4Quoter (0xb3d5… on Polygon) still reverts — unaffected,
  `buildBuy` already falls back to spot pricing when it does.
- **Live enablement (separate decision, not part of this change):**
  Polygon stays `live=false, executionBlocked=true` until the parent flips
  it (funding/gas checks are the parent's call); Base is already live=true,
  so the router switch alone unblocks its first buy.
- **Caveats (encoding proof only, not buyability):** the agent holds 0
  USDT0 on Polygon and 0 USDC on Base, so a live buy on either proof pool
  would BALANCE-SKIP — the proof is about the router, not the pool.
  Polygon buyability is still limited to WPOL pairs (~1 in 200 pools);
  native-POL pairs remain skipped by the evaluator.

### 7. What this unblocks
Polygon sniping (sign+broadcast path + V2 router now both proven) and
live Base buys (same legacy-router failure, same fix). Robinhood (fork
router) and Arc (0x4fcA…) are unaffected — their v1 encoding stays as-is.

## V2 switch APPLIED + spot/sell-price fixes (2026-11-07 ~19:35 GMT+7)

**Applied (live config + code, by the parent after reproducing the V2 proof):**
- `trade.js`: `buildRouterExecuteV2` (byte-identical to v1 builder except the
  5-field `ExactInputSingleParams`, no `minHopPriceX36`) + `buildRouterExecuteFor`
  selector (`chain.routerVersion === 2` → V2, else v1). `buildBuy`/`buildSell`
  use the selector. Permit2 approve already targets `chain.universalRouter`,
  so it follows the switch. Exported `buildRouterExecuteV2`.
- `config.json` (backup `config.json.bak-pre-v2-switch`): Polygon (137)
  `universalRouter` 0x3fC9… → 0x1095692a6237d83c6a72f3f5efedb9a670c49223,
  `routerVersion: 2`, `live: true`, `executionBlocked: false`; Base (8453)
  `universalRouter` 0x3fC9… → 0x6ff5693b99212da76ad316178a184ab56d299b43,
  `routerVersion: 2`. Robinhood (fork 0x8876…) and Arc (0x4fcA…) untouched
  (v1 encoding, proven live).
- V2 proof reproduced independently by the parent before applying:
  `/tmp/v2-proof.js` re-run — Polygon GRT/USDT0 + Base USDC/PEPE both reach
  `AllowanceExpired` with the V2 encoding; V1 controls revert bare-empty.
  Router immutables re-read: Polygon V2 `poolManager()` = 0x6736…,
  Base V2 `poolManager()` = 0x4985… (both match the research report).

**Three further bugs found by the parent's integration test (all v2, all
never exercised live — 0 v2 buys before this):**
1. `spotOutput` (trade.js) multiplied by `10^(tokenDec-quoteDec)`. The
   sqrt price is already in RAW units, so the factor double-counts decimals:
   mixed-decimal buy minOut was 1e12 too big (18-dec token vs 6-dec USDC).
   Proven by the integration test: `buildBuy` on GRT/USDT0 first returned
   minOut 8.16e29 and reverted `V4TooLittleReceived` (0x8b063d73); after the
   fix minOut is 8.16e17 and the same eth_call reaches `AllowanceExpired`.
   Cross-checked against the known-good first $MUSE swap: 50000 raw USDC ×
   2e13 = 1e18 raw MUSE ≈ the actual 986,590,874.86 gross.
2. `buildSell` spot had the same decimal error (`tokenPerQuote` /
   `quotePerToken` with the `10^(tokenDec-quoteDec)` factor). Replaced with
   the direct raw-units formula (`amountToken × price` / `÷ price`).
3. `priceQuotePerToken` (run.js) had its branches swapped: it returned
   token-per-quote instead of quote-per-token, which INVERTED the sell
   triggers (a 2x pump read as −50% → SELL ALL; a 50% crash read as +100% →
   SELL 50%). Branches swapped; Test 9 could not catch this (it feeds
   synthetic buy prices through the same function). 0 v2 positions exist,
   so no stored buyPrice needed migration.
- **v1 checked, unaffected:** `priceWethPerToken` is correct in both
  branches, and v1's spot formulas are right for its 5 live positions
  (all 18-dec, all currency1, WETH currency0). v1 files untouched.
- `chains.js` `rawGetLogs` now chunks eth_getLogs into ≤5000-block ranges:
  Polygon publicnode rejects any range >10000 ("exceed maximum block
  range") — a 20000-block dry-run scan proved the failure; the chunked
  re-run succeeds. Protects all chains after any watcher outage.

**Sell-path proof (after the fixes):**
- Polygon GRT sell, minOut=0, direct V2 builder → `AllowanceExpired`
  (encoding executes). With the fixed minOut (15,676) the same pool reverts
  `V4TooLittleReceived` (actual 317) — the GRT/USDT0 pool is one-sided thin
  (no sell-side depth at tick −315650), NOT a code bug.
- Base PEPE sell via the full `buildSell` path (4000 PEPE) → `AllowanceExpired`.
  minOut 50,662,710 raw USDC came from the quoter (that pool's PEPE is priced
  ~$0.013, not the famous PEPE — a different Base token).

**First live cycle 2026-11-07 19:35:13 GMT+7 (`--chains 5042,8453,4663,137 --live`):**
Polygon scanned 96899622..96899639: 0 new pools; Robinhood 1 new pool — PIG
watch 10/100; Arc 1 new pool — SKIP not a quote pair; Base 1 new pool — SKIP
no active liquidity. **0 buys, 0 sells, 0 transactions.** Watcher cron
`sniper-v2-watcher-arc-base` updated to `--chains 5042,8453,4663,137` and
renamed (Arc + Base + Robinhood + Polygon); next run ~19:36:17 GMT+7.
Polygon gas ~271 gwei at enablement — above the 100 gwei ceiling, so Polygon
buys GAS-SKIP until gas drops. **Zero transactions sent in the entire apply.**

## Buy line lowered 50 -> 45 (2026-11-08 ~01:30 GMT+7, user decision)

Why: live ~7.5h produced 0 buys — 242 cycles, ~2,000 pools evaluated, best
score ever 45/100, 21 unique tokens in the 30–45 band. Hooked pools cap at 45
at T+0 (liquidity-depth partial credit 5/15 + lp-locked/early-traction
structurally 0 at birth), so 50 was near-unreachable for the dominant launch
type. Bands now: ≥70 full, 45–69 half, <45 watch. Half-sizing still not wired
— half-score buys spend the full $0.02.

Change (0 txs): `config.json` scoreThresholds.half 50→45; `run.js` WATCH log
now prints the configured threshold; `evaluate.js` §6 comment updated;
`README.md` + `V2-DESIGN.md` (§6.3 live-change note) + watcher cron body
updated to 45.

Verification (real pools, evaluate.js CLI, 0 txs):
- CURVEIL pool 0x14d7e1d991370a198f07213a7e21736f18b035ab99d89ef4260c0fef13d6a1be
  (Robinhood, scored 45 at 17:44 GMT+7) → VERDICT: PASS, score 45, size **half**.
  First 4 CURVEIL pool candidates errored with eth_getLogs HTTP 429 (Robinhood
  RPC rate limit, transient) before the 5th succeeded — no code failure.
- FOREVER pool (scored 40) negative control: ran after; result recorded below.
- FOREVER pool 0x9e1a51fc5d9f66ec5de309cbfe787a16fd8b28d633db3bd723b498fd7c34015b
  (Robinhood, scored 40 at 18:10 GMT+7) → VERDICT: PASS, score 40, size **watch**.
  Negative control confirmed: 40 stays below the new line. First 4 FOREVER
  pool candidates errored with eth_getLogs HTTP 429 (transient); a 5th
  candidate returned SKIP score 0 — its pool had 0 active liquidity at the
  current tick (liquidity moved since detection), not a scoring issue.
- Both controls passed: 45 buys, 40 watches. Threshold change verified live
  in the evaluator; the next watcher cycle applies it to new pools.
