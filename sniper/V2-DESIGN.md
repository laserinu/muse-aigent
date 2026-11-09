# Sniper v2 — Multichain Design Spec (DESIGN ONLY, no live changes)

Prepared 2026-11-07 ~16:30 WIB. Research + design only.
**Nothing has changed in the live bot:** `~/workspace/tokens/sniper/robinhood/STATE.json`
untouched (live=true, 5/5, manage-only on Robinhood), no cron change, no code change,
no buys, nothing spent. V2 starts dry-run (watch-only) and goes live only on a
per-chain "Go" from the user, after funding is confirmed onchain.

Builds on the parent draft `~/workspace/tokens/sniper/EXPANSION-PLAN-v2.md`
(2026-11-07 ~16:20 WIB). Where this spec differs from that draft, the difference
is flagged explicitly (§12).

## 0. The user request (verbatim, 2026-11-07 ~16:15 WIB)

> "Change it to watch the new prediction for intelligently legit tokens that has
> minimum social media platforms and websites, from all available pools, and for
> all paired with all verified tokens and stocks, on every chains."

Interpretation used in this design (user to confirm):
- "new prediction" = intelligently predicting which NEW launches are legit
  (the current trigger + checks, extended) — **NOT prediction markets**
  (Polymarket-style). If the user meant prediction markets, that is a different
  build; confirm in the delivery message.
- "minimum social media platforms and websites" = a token must have at least a
  website + social presence to qualify (§5).
- "all available pools" = V4 + V3 + V2 + other DEXes (§2).
- "all verified tokens and stocks" = every verified quote token + tokenized
  stock as a pair leg (§4). The honest finding is that most of that list is
  dead code — see §4.3.
- "every chains" = literally hundreds of chains; infeasible. Phased list in §1.

## 1. Chains — phased list (not "every chain")

| Phase | Chains | Why this order |
|---|---|---|
| 1a | Robinhood 4663 (proven), Base 8453, Arc 5042 | V1 proven on Robinhood; Base + Arc are our other live chains (tokens, registrations, Privy CLI broadcast VERIFIED on all three) |
| 1b | Polygon 137 | Last in Phase 1: Privy CLI broadcast FAILS on Polygon (proven); sign+broadcast fallback is proven for setAgentURI but NOT yet tested for swaps |
| 2 | Arbitrum 42161, BSC 56 | Bigger, cheaper than Ethereum; new DEXes (Camelot, PancakeSwap) |
| 2-watch-only | Ethereum 1 | Watch + score only. Buys excluded by default: gas dwarfs a small buy, and the prepared Privy policy DENIES chain 1. A buy there needs a policy change + a much bigger size (§7) |
| Out of scope | Solana, all other chains | Solana has no Uniswap V4 (Pump.fun/Raydium = a different bot); the Privy Solana wallet is 0/unfunded. "Every chain" beyond the 7 above is Phase 3+ if ever, and only chains where Uniswap V4 (or a major DEX) is actually deployed |

RPCs (public, from our own verified history):
Robinhood `https://rpc.mainnet.chain.robinhood.com`; Base
`https://base-rpc.publicnode.com` (mainnet.base.org is flaky from this VM);
Arc `https://rpc.mainnet.arc.io` + Blockdaemon `https://rpc.blockdaemon.mainnet.arc.io`
(main Arc RPC returns 0 for `eth_getLogs` — use Blockdaemon for logs);
Polygon `https://polygon-bor-rpc.publicnode.com` (polygon-rpc.com is DEAD, 403);
Arbitrum `https://arb1.arbitrum.io/rpc`; BSC `https://bsc-dataseed.binance.org`
(rate-limits; have a fallback); Ethereum `https://ethereum-rpc.publicnode.com`.

## 2. Pool sources — all pool types, per chain

### 2.1 Trigger events (raw `eth_getLogs` is the primary trigger)

| Pool type | Creation event | Event signature / topic0 | Factory / singleton |
|---|---|---|---|
| Uniswap V4 | `Initialize` on PoolManager | `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)` — **topic0 `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`** (verified live on Ethereum + recomputed with keccak, 2026-11-07) | PoolManager — **DIFFERS per chain** (see §2.2). This is the v1 trigger |
| Uniswap V3 | `PoolCreated` on Factory | `PoolCreated(address,address,uint24,int24,address)` — topic0 `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118` (verified via QuickNode + Dune sources) | V3 Factory — **DIFFERS per chain** (see §2.2) |
| Uniswap V2 | `PairCreated` on Factory | `PairCreated(address,address,address,uint256)` — topic0 `0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9` (verified via QuickNode) | V2 Factory — **DIFFERS per chain** (see §2.2) |

### 2.2 V4 PoolManager per chain — NEVER assume one address

Verified via `eth_getCode` this session (2026-11-07) unless marked 📄 (official
Uniswap deployments page, developers.uniswap.org/docs/protocols/v4/deployments —
docs-sourced, still needs an `eth_getCode` confirmation before wiring):
- Ethereum (1): `0x000000000004444c5dc75cB358380D2e3dE08A90` (code present)
- Base (8453): `0x498581ff718922c3f8e6a244956af099b2652b2b` (code present)
- Arc (5042) + Robinhood (4663): `0x8366a39CC670B4001A1121B8F6A443A643e40951`
  (24,009 bytes on both — verified; these two share an address, the others don't)
- Polygon (137): `0x67366782805870060151383f4bbff9dab53e5cd6` 📄
- Arbitrum (42161): `0x360e68faccca8ca495c1b759fd9eee466db9fb32` 📄
- BSC (56): `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` 📄

**V3 factory per chain (official docs + Dedaub eth_getCode Oct 2026):**
Ethereum/Polygon/Arbitrum `0x1F98431c8aD98523631AE4a59f267346ea31F984` (code
verified onchain this session on all three); **Base: CONFLICT — official docs
+ Dedaub say `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, but code was found at
`0x1F98431c…` on Base this session. Code presence alone does not prove it is
the factory — on Robinhood/Arc the Ethereum literals exist as forwarder
decoys (2,109 B, no V3 events). Probe `0x33128a8f…` with `getPool()` /
`PoolCreated` history before wiring Base V3; treat `0x1F98431c…` on Base as
suspect.** BSC `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` (docs only, NOT
eth_getCode-verified this session); Robinhood `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
(Dedaub); Arc `0xf0db7b58379503491d857dB50AC9ece64c653918` (Dedaub).
**Never use the Ethereum V3 literals on Robinhood/Arc — they are decoys there.**

**V2 factory per chain (official Uniswap V2 deployments page, 2026-09-22):**
Ethereum `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` (code verified); Base/BSC
`0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`; Polygon
`0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C`; Arbitrum
`0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9`; Robinhood
`0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f`; **Arc: NO row on the official V2
page — V2 on Arc is unverified/absent; do not assume any address.**

Per chain, the full V4 stack must be verified the same way before trading:
PoolManager, PositionManager, Universal Router, Permit2, V4Quoter, WETH.
Known traps from v1: Robinhood's Universal Router is a modified fork
(`0x8876789976dEcBfCbBbe364623C63652db8C0904`; canonical `0x4fcA…` has NO code
there); Arc's Permit2 is the F6B address
`0x000000000022D473030F116dDEE9F6B43aC78BA3` (F7B has NO code); Arc's EVM is
pre-Shanghai (compile `evm_version paris`).

### 2.3 Other DEXes (Phase 2, after V4 works on the new chains)

All addresses below are docs-sourced (2026-11-07 pool-detection research);
⚠️ = locally computed topic or single-source — probe with one live log before
wiring. Full table + sources in the research report §2–3.

- **PancakeSwap** (BSC, Base, Arbitrum, Robinhood…): V3 factory **same on all
  chains** `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`, event = Uni-V3
  `PoolCreated` (topic0 `0x783cca1c…b7118`). V2 factory: BSC
  `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73`; Base/Arbitrum/Robinhood
  `0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E`; Ethereum
  `0x1097053Fd2ea711dad45caCcc45EfF7548fCB362`; event = `PairCreated`
  (topic0 `0x0d3648bd…d0e9`). PancakeSwap Infinity (V4-style singleton) exists
  on BSC/Base — PoolManager addresses NOT verified; out of scope for now.
- **Aerodrome (Base only — Base's dominant DEX, matters for Phase 1):**
  vAMM/sAMM `PoolFactory` `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`,
  `PoolCreated(address,address,bool,address)` — topic0 ⚠️
  `0xa9d67f07d02636a34d7223f6507271ecd86bfbc8f7179cbd7f0bab63ed90ad90`
  (computed from the canonical Velodrome/Aerodrome signature; verify against
  one live log). Slipstream CL factories: **three live versions — resolve via
  `FactoryRegistry` `0x5C3F18F06CC09CA1910767A34a20F771039E37C0`
  `.poolFactories()` at runtime, do not hardcode one** (old
  `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`, `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a`,
  current `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`); CL event is Uni-V3-style
  `PoolCreated`.
- **QuickSwap (Polygon only):** V2 factory `0x5757371414417B8c6CaaD45BaEF941AbC7d3Ab32`
  (Polygonscan-labelled), `PairCreated`. V3 factory ⚠️
  `0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28` (single source — GitHub audit
  issue); Algebra engine, event is `Pool(address,address,address)` (NOT
  `PoolCreated`), topic0 ⚠️ `0x91ccaa7a278130b65168c3a0c8d3bcae84cf5e43704342bd3ec0b59e59c036db`.
- **SushiSwap:** V2 `PairCreated`: Ethereum `0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac`;
  Polygon/BSC/Arbitrum `0xc35DADB65012eC5796536bD9864eD8773aBc74C4`; Base ⚠️
  `0x71524B4f93c58fcbF659783284E38825f0622859` (single doc — probe first). V3
  `PoolCreated`: Ethereum `0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F`; Base
  `0xc35DADB65012eC5796536bD9864eD8773aBc74C4`; Arbitrum
  `0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e`; Polygon
  `0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2`; BSC not found in Sushi V3 docs.
- **Camelot (Arbitrum only):** V2 factory `0x6EcCab422D763aC031210895C81787E87B43A652`
  (`PairCreated`); V3 factory `0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B`
  (Algebra `AlgebraFactory`, `Pool` event topic0 ⚠️ `0x91ccaa7a…c036db`).
- **Robinhood non-Uniswap DEXes** seen in Dexscreener pair data on 4663:
  `aero`, `ramses`, `metric`, `giga` — resolve factories the same way before
  wiring.
- Each extra DEX is a separate evaluator + quoter + router. Do NOT build these
  until V4 watchers are clean on the new chains — V4 covers most new launches
  (Pools.xyz and Clanker v5 both launch on V4).

### 2.4 Dexscreener as a trigger — NO (enrichment only)

Verified this session (live API + docs, 2026-11-07):
- **There is NO Dexscreener new-pairs endpoint.** Documented routes are
  lookups (`/latest/dex/pairs/{chain}/{pair}`, `/token-pairs/v1/{chain}/{token}`,
  `/tokens/v1/{chain}/{tokens}`, `/latest/dex/search`) plus discovery feeds
  (`/token-profiles/latest/v1`, `/token-profiles/recent-updates/v1`,
  `/token-boosts/*`) — all at 60 req/min for the feeds, 300 req/min for lookups.
- The profile feeds are NOT a new-pool feed: they list tokens whose profile was
  recently created/updated (paid Enhanced Token Info / boosts). Latest batch
  checked: 30 items, 22 Solana, 1 Robinhood, 1 Base, 1 Arc. A new token with no
  profile never appears there.
- Dexscreener is an indexer with no published detection latency; being first to
  a launch needs an onchain source.
- **Design: primary trigger = raw `eth_getLogs` per chain** (the proven v1
  pattern — note the Robinhood RPC quirk: viem's `client.getLogs({topics})`
  silently ignores the topic filter there, so use raw `eth_getLogs`).
  Dexscreener is the **second trigger + enrichment**: poll
  `/token-profiles/recent-updates/v1` for newly-profiled tokens (a "team is
  investing in visibility" signal) and use `/tokens/v1` for the social/website
  check (§5) and price/volume snapshots. GeckoTerminal is the TA/candles source
  (free OHLCV, verified in Part 31); it has NO social/website fields (§5).
  **Safety net:** GeckoTerminal DOES have a documented free new-pools feed —
  `GET /api/v2/networks/{network}/new_pools` (and `/networks/new_pools` for all
  networks) — but free tier is 30 req/min keyless with a 1-min cache, so
  polling 7 networks every 10 s already exceeds it; use it at ~30 s cadence
  as a cross-check for any factory missed onchain, never as the buy trigger.
  Polling cadence for the onchain trigger should match block time:
  Robinhood/Arc ~1–2 s, Base/Arbitrum/Polygon ~2 s, BSC ~3 s, Ethereum ~12 s.

## 3. What v1 keeps, what changes

KEPT: Privy agent wallet only (never a seed/private key); `state.live` gate per
bot (v2 starts dry-run, live only on explicit per-chain "Go"); sell rules
50% at +100%, all at −50%, otherwise hold; never buy our own $MUSE/$RMUSE;
never buy a token already held; restore the Privy machine identity before every
CLI call; exact-amount approvals, never unlimited.

CHANGED vs v1: trigger expands V4-only → V4+V3+V2 (+other DEXes in Phase 2);
quote allowlist expands WETH-only → §4; a social/website score is added (§5);
a 0–100 score replaces the pure pass/fail gate (§6); caps become per-chain (§8).

## 4. Quote-token allowlist — "all verified tokens and stocks"

Full per-chain table with addresses is in the research report
(`~/workspace/research_notes/verified-quote-tokens-tokenized-stocks-20261107-1616/report.md`).
Summary + decisions:

### 4.1 INCLUDE (Phase 1: Robinhood, Base, Arc, Polygon)

| Quote | Chains | Address | Notes |
|---|---|---|---|
| WETH (wrap native on the fly — no pre-funding beyond gas) | Base, Robinhood | Base `0x4200000000000000000000000000000000000006`; Robinhood `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Both verified |
| WPOL (WMATIC, same contract) | Polygon | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` | Verified |
| USDC (Circle native) | Base, Arc, Polygon, Robinhood | Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`; Arc `0x3600000000000000000000000000000000000000` (also Arc's native gas — one balance, two interfaces, divide native by 1e12); Polygon `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`; Robinhood (bridged) `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8` | Beware lookalikes: Base USDbC `0xd9aA…` and Polygon USDC.e `0x2791…` are DIFFERENT contracts; Robinhood Blockscout shows a 30k-holder "Universal Stable Digital Coin" impostor — never trust the name |
| USDG (Paxos, natively issued) | Robinhood | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | Robinhood's dominant stable (~60,946 holders); SPY/USDG, TSLA/USDG are the deep stock pools |
| EURC (Circle) | Arc (secondary) | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | Only if an EURC-paired pool is actually detected; do not pre-fund |

### 4.2 INCLUDE (Phase 2: Arbitrum, BSC, Ethereum-watch)

WETH Eth `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, Arbitrum
`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`; WBNB BSC
`0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`; USDC Eth
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, Arbitrum
`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`; USDT Eth
`0xdAC17F958D2ee523a2206206994597C13D831ec7`, Arbitrum
`0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`, BSC
`0x55d398326f99059fF775485246999027B3197955` (**18 dec on BSC, not 6** —
sizing trap; BSC USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` is also
18 dec, Binance-peg, NOT Circle native).

### 4.3 Tokenized stocks — the honest verdict

**New-token / stock-token pools are REAL on exactly one chain — Robinhood
(4663) — and near-nonexistent everywhere else.**
- Robinhood native stock tokens: ~194 US stocks/ETFs as ERC-20 (18 dec,
  BeaconProxy, ERC-20 + EIP-2612 + ERC-8056), issued by Robinhood Assets
  (Jersey) Ltd, 1:1 backed, holders get economic exposure only (no voting,
  no ownership, no direct dividend). Authoritative registry:
  `GET https://api.robinhood.com/rhj/assets` (no auth) + onchain
  `RhPairRegistry.isAdmitted(address)`. Verified examples: AAPL
  `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`, NVDA
  `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`, TSLA
  `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`. (MSFT/GOOGL/AMZN only
  partially quoted in sources — never use truncated addresses; pull the full
  list from the registry at build time.)
- A Sept 2026 on-chain audit cited in the research counts 25,139 Uniswap v4
  pools on 4663 touching a stock token, incl. **22,359 launchpad memecoin
  pairs**. **Spot-check caveat (mine, 2026-11-07):** Dexscreener's token-pairs
  endpoint caps at 30 pairs sorted by volume, so it surfaced only NVDA's big
  pairs (NVDA/USDG $1.9M liq, NVDA/WETH, NVDA/SPY — confirming stock tokens
  DO trade on Robinhood DEXes with deep liquidity). The 22,359 figure could
  neither be confirmed nor refuted from that endpoint. **Phase 1 build must
  verify stock-paired launches directly from o1 launchpad factory logs before
  spending anything on this category.**
- **Correction to the parent draft:** EXPANSION-PLAN-v2.md §3 says Robinhood
  stock tokens "pair with USDG, not with new meme launches". The audit cited
  above says the o1 launchpad registers all 194 stock tokens as pairs and
  memecoin launches against them are common. Both claims can't be fully right;
  the factory-log check in Phase 1 settles it.
- Stock-quote mechanics that MUST be built, not assumed: ERC-8056 pricing —
  `balanceOf()` is NOT the economic balance; price with `balanceOfUI()` /
  `uiMultiplier()` or the sniper misprices by the multiplier. Only one
  Authorised Participant mints/redeems, only while the underlying market is
  open; on-chain trading is 24/7, so weekend prices are stale vs Monday's gap
  (the ClosingBell hook proposal documents this as the core LP risk). Only
  the liquid top names (AAPL/NVDA/TSLA/MSFT/GOOGL/AMZN/META/SPY/QQQ…) are
  in scope; a sniper buying with NVDA must HOLD NVDA (~$180/share, volatile,
  weekend-stale) — inventory + pricing risk far above a stablecoin quote.
- xStocks (Backed, ~131 stocks/ETFs), Ondo Global Markets ("…on" tokens),
  Dinari dShares, Backed bTokens (closed to new issuance since May 2025),
  Swarm, RealT, Bitget/Gate CEX wrappers: **EXCLUDED as quote tokens.**
  They trade vs USDC/USDT on CEXs/Solana, never as a memecoin quote leg, and
  no new-token/xStock pool was found. Dinari scale is the killer: most
  dShares sit at $200–$1,300 market cap, $0–$56 24h volume. OUSG/USD Y are
  NOT stocks (Treasuries / yield stablecoin) and are permissioned/KYC-gated.
- Non-US-persons-only restrictions apply to all of these issuers.

### 4.4 EXCLUDE everywhere as quote tokens

DAI (new-token/DAI pools are ~nonexistent); WBTC/cbBTC/BTCB (no new-token
pools; a 0.00001-ETH-size buy in BTC terms is ~1.3e-7 BTC — below meaningful
pool granularity; ~$76k per whole coin makes inventory absurd); any
stock-token address not pulled live from the issuer registry or not
full-length verified. **Pre-flight rule:** before adding any quote token,
check onchain `decimals()`/`symbol()` + `eth_getCode`, and confirm at least
one live pool of that quote exists on that chain (Dexscreener/GeckoTerminal
pair search). Never trust a symbol.

### 4.5 The fragmentation problem (why the allowlist stays narrow)

Full matrix (7 quotes × 7 chains) = up to 49 balances, each needing its own
bridge-in, gas top-up and Permit2 approval before a single buy. At a ~$0.02–$1
buy size that is absurd: gas + approval + bridging dwarfs the buy, and a
stablecoin quote needs a separate funded balance per chain (USDC on Base ≠
USDC on Arbitrum ≠ USDC on Polygon — different contracts, no shared balance).
Realistic new-pool incidence: wrapped-native dominates everywhere; USDC second
(esp. Base; Arc is USDC-only by construction); USDT third but thin; USDG on
Robinhood. Everything else is ~zero — which is why §4.1/§4.2 are short lists,
not "all verified tokens".

## 5. Social / website minimum — the rule, the source, and the timing problem

### 5.1 Source — verified live 2026-11-07

- **Dexscreener is the ONLY verified source.** Pair objects from
  `GET /tokens/v1/{chainId}/{tokenAddress}` (300 req/min) carry an `info`
  field when the token has a Dexscreener profile:
  `info.websites[]` (`{url, label}`) + `info.socials[]` (`{url, type}` —
  `twitter`/`telegram`/`discord`). Verified live: PEPE on Ethereum returns
  `websites: [{url: "https://www.pepe.vip/", label: "Website"}]` +
  `socials: [{url: "https://twitter.com/pepecoineth", type: "twitter"}]`.
- **No per-token profile endpoint exists.** `GET
  /token-profiles/v1/{chainId}/{tokenAddress}` returns HTTP 404
  ("Cannot GET …") — verified live for Alon and $MUSE. Only the feeds exist:
  `/token-profiles/latest/v1` and `/token-profiles/recent-updates/v1`
  (60 req/min, 30 items per call).
- **GeckoTerminal has NO social/website fields.** Verified live: both the
  token endpoint (`/api/v2/networks/robinhood/tokens/…`) and the pool endpoint
  return name/symbol/price/FDV/volume only. It stays the TA/candles source.
- **The profile feeds are Solana-biased.** Latest batch checked: 30 items,
  22 Solana, 2 BSC, 1 Ethereum, 1 Arc, 1 Cronos, 1 PulseChain, 1 Robinhood,
  1 Base. All 30 had links — but that is selection bias (only profiled tokens
  appear). Do not read "30/30 have links" as "new tokens have links".

### 5.2 The timing problem — verified on our own position

Alon — bought 2026-11-07, hours old — returns **NO `info` field at all** on
the Dexscreener token endpoint (checked live 2026-11-07). All five v1 buys
would have failed a hard social gate at snipe time. New launches usually have
no Dexscreener-indexed website/socials in their first minutes, and some never
get indexed (a profile is usually submitted AFTER launch — often as paid
Enhanced Token Info — or never).

### 5.3 The rule (proposed)

**Minimum to BUY at full size: website URL present in `info.websites` AND
at least 1 social in `info.socials` (X or Telegram), with the website
verified to LOAD (HTTP 200 on a HEAD/GET, 3-second timeout).**

Implementation is two-tier, because a hard gate at T+0 kills the sniper:
- **Tier A (instant, at detection):** run all onchain hard gates (§6). In
  parallel, fetch Dexscreener `/tokens/v1` for the token. If `info` is present
  with website + ≥1 social → social score full (§6), candidate proceeds.
  If `info` is absent → social score 0, candidate is NOT rejected outright:
  it goes to the watchlist at reduced size (see §6 thresholds).
- **Tier B (delayed, +10 min re-check):** re-fetch Dexscreener for watchlist
  candidates at +10 min (and +60 min for positions already bought). If the
  website + social appear by then, upgrade the score; if a position was bought
  at reduced size and still has no profile at +60 min, that is a sell-tilt
  signal for the position manager (not an auto-sell — user decides the rule).
- **Website-load check is async and non-blocking.** Never let a slow website
  delay a buy: fetch with a 3s timeout in parallel with the onchain checks;
  a timeout/fail counts as "website not verified" (score 0 for that part),
  not as a hang. A listed-but-dead website scores the same as no website.
- **Spoof warning (hard):** Dexscreener links are SELF-DECLARED, not verified.
  Anyone can put any URL in a profile — a scam can link to a real project's
  site or X account. Website + socials is a weak "team is trying" signal, NOT
  proof of legitimacy. It sits on top of the bytecode / honeypot / liquidity
  checks, never instead of them. A token with a beautiful website and a
  honeypot sell-sim still fails.

### 5.4 What "minimum social media platforms" means in practice

Website + 1 social (X or Telegram) is the proposed minimum. Website + 2
socials (X + Telegram, or X + Discord) scores higher (§6) but is NOT
required — requiring 2 would filter out most small-but-real launches. The
user can raise it to website + 2 socials; the cost is fewer candidates.

## 6. Scoring — "intelligently legit" (0–100, not pass/fail)

### 6.1 Hard gates (any FAIL = no buy, score irrelevant)

Kept from v1, extended to all pool types/chains: (1) quote token in the §4
allowlist for that chain; (2) not our own $MUSE/$RMUSE; (3) readable ERC-20
(name/symbol/decimals/totalSupply); (4) no dangerous selectors in bytecode
(mint/pause/blacklist/maxTx/maxWallet/tax/enableTrading — v1 list in
`evaluate.js`, plus `setTradingEnabled` variants); (5) honeypot buy+sell
simulation passes — per pool type: V4 via V4Quoter with the transfer-simulation
fallback when the quoter reverts on hooks (proven v1 pattern); V3 via its
Quoter (`quoteExactInputSingle`); V2 via `getAmountsOut` simulation; if the
sim reverts or the sell returns <50% of the buy input, FAIL; (6) active
liquidity > 0 at the current tick/range (V4: `extsload`; V3: `liquidity()` on
the pool; V2: reserves > 0 and a simmed buy returns > 0); (7) pool fee sane
(no 100% fee tier — V4 dynamic-fee hooks that can set fee to 100% are a FAIL
unless the hook is allowlisted).

### 6.2 Scored signals (ranked by how fast they are available at launch)

| Signal | Max pts | Available when | Notes |
|---|---|---|---|
| Social/website (§5) — website loads + ≥1 social | +25 | T+0 if profile exists; else +10 min re-check | Website+2 socials: +25; website+1 social: +20; website only: +10; socials only: +10; none: 0 |
| Contract verified (Sourcify exact match, else Blockscout) | +10 | T+0 if verified at deploy | Unverified ≠ fail — most launches are unverified at T+0 |
| Liquidity depth vs buy size | +15 | T+0 | Buy impact ≤1%: +15; ≤5%: +10; ≤10%: +5; >10%: 0 (and amountOutMinimum still guards) |
| Liquidity locked / LP burned | +10 | Usually NOT at T+0 (locks happen later) | Check LP-token holder (dead/burn/locker contract); if unknown at T+0: 0, re-check at +60 min |
| Deployer history | +10 | T+0 (deployer address is in the creation tx) | Deployer previously launched a token that still has liquidity / didn't rug: +10; first-time deployer: +5 (neutral, not punished); deployer linked to a known rug/honeypot: −20 (veto-level, treat as hard fail) |
| No impersonation (name/symbol vs known tokens) | +5 | T+0 | Exact name/symbol match to a top token with a different address: −10 |
| Early traction (buy volume, holders, buys>sells) | +15 | T+5–60 min ONLY — not at launch | First blocks: ≥5 buys and buys>sells in first 10 min: +15; holders growing: +5 of it. This is a re-score input, not a snipe-time input |
| Launchpad provenance | +5 | T+0 | Launched via a known launchpad factory (Pools.xyz, Clanker, o1) with its standard anti-snipe/fee rules: +5; unknown deployer contract: 0 |
| **TOTAL** | **100** | | |

### 6.3 Buy thresholds (proposed)

- **Score ≥ 70 → buy at full size** (§7).
- **Score 50–69 → buy at half size** (still small money; keeps v1 behaviour
  for unprofiled-but-clean launches — this is where our own 5 buys would have
  landed at T+0, since they had no `info`).
- **Score < 50 → watch only** (log + re-score at +10/+60 min; buy only if the
  re-score crosses 50 AND a slot is free).
- A hard-gate FAIL overrides any score. A deployer-rug link (−20) is a veto.

> **LIVE CHANGE 2026-11-08 ~01:30 WIB (user decision): buy line lowered 50 → 45.**
> Hooked pools cap at 45 at T+0 (liquidity-depth partial credit 5/15, lp-locked
> and early-traction structurally 0 at birth), so 50 was near-unreachable for
> the dominant launch type. Live thresholds now: ≥70 full, 45–69 half, <45
> watch. Configured in `v2/config.json` `scoreThresholds.half`.

### 6.4 Honest limit

**No T+0 signal predicts upside.** At launch there are no holders, no volume,
no price history (the TA finding from Part 31: Alon had 2 hourly candles in
its entire history; RSI/MACD need 15–26 closes). This rubric ranks "looks
like a real project trying" vs "anonymous throwaway" — it filters junk, it
does not forecast a 2x. The sell rules (+100% half / −50% all) remain the
discipline that makes the expected value work, not the score.

## 7. Buy size per chain (USD-equivalent, proposed)

| Chain | Buy size (proposed) | Gas per buy (approx, 2026-11-07) | Why |
|---|---|---|---|
| Robinhood 4663 | **$1.00** | ~$0.001 (0.02 gwei) | Cheapest; v1 size was $0.02 — $1 is 50x bigger but still tiny, and meaningful vs the $0.001 gas |
| Base 8453 | **$1.00** | ~$0.01–0.05 | L2 gas is cents; $1 buy is not gas-dominated |
| Arc 5042 | **$1.00 in USDC** | ~$0.01 (20 gwei fixed baseFee) | USDC is gas AND quote — simplest chain to fund |
| Polygon 137 | **$1.00** | ~$0.01–0.05 at ≤40 gwei; much more at 200+ gwei | Buy only when gas is low OR accept the gas; Polygon goes last (§1) |
| Arbitrum 42161 | **$1.00** | ~$0.01–0.05 | As Base |
| BSC 56 | **$1.00** | ~$0.01–0.05 | As Base (mind 18-dec stables when sizing) |
| Ethereum 1 | **$10.00 minimum, or watch-only** | $1–5+ per swap | A $1 buy is gas-dominated and pointless; default is watch-only (§1) |

**This is a proposal, not a decision.** The parent's EXPANSION-PLAN-v2.md lists
buy size as user choice #2 ("keep 0.00001 ETH-equivalent per buy, or change
it"). Recommendation: $1 on Phase 1 chains — it keeps the "small portion"
spirit (5 buys × $1 = $5 per chain) while being large enough that gas and
rounding don't dominate the trade. If the user prefers, keep the v1
0.00001-ETH-equivalent (~$0.02) size — but then a USDC-quote buy needs a
separate dust-size path and the economics get silly on every chain except
Robinhood.

## 8. Caps (proposed)

- **Per-chain cap: 5** (mirrors v1). Phase 1 total: 4 chains × 5 = **20 max**.
  Phase 2 total: +3 chains × 5 = **35 max** (Ethereum watch-only contributes 0).
- **This reopens a decided question, deliberately.** The user chose "Keep cap
  at 5" on 2026-11-07 ~15:09 WIB, one hour before this request — the cap
  question is only reopened because the scope itself changed (5 total across
  1 chain → 5 per chain across 4–7 chains). It needs an explicit re-approval;
  until then the live bot stays at 5 total, manage-only.
- Sell rules unchanged per position: 50% at +100%, all at −50%.

## 9. Funding needed (the hard blocker)

Wallet now (portfolio snapshot 2026-11-07 ~15:10 WIB): **~$1.15 total** —
Robinhood ETH 0.00002238 (~$0.05), Base ETH 0.0003566 (~$0.80), Arc USDC
0.098111 (~$0.10), Polygon POL 0.264159 (~$0.05), Solana 0. Robinhood alone
cannot fund even 2 more snipes at v1 size + gas.

| Chain | Buys (5 × $1) | Gas reserve | Quote inventory needed | Total top-up needed |
|---|---|---|---|---|
| Robinhood 4663 | $5.00 (ETH) | ~$0.10 | WETH via wrap-on-the-fly; USDG if USDG pairs wanted (~$5 separate) | **~$5.05** (have ~$0.05) |
| Base 8453 | $5.00 (ETH or USDC) | ~$0.50 | ETH for gas + wrap; USDC balance if USDC pairs wanted | **~$4.70** (have ~$0.80 ETH) |
| Arc 5042 | $5.00 (USDC) | ~$0.10 | USDC is gas AND quote — single balance | **~$5.00** (have $0.098) |
| Polygon 137 | $5.00 (POL/USDC) | ~$0.50 | POL for gas; USDC balance if USDC pairs wanted | **~$5.45** (have ~$0.05 POL) |
| **Phase 1 total** | **$20.00** | **~$1.20** | | **~$20.20** (have $1.15) |
| Arbitrum 42161 | $5.00 | ~$0.50 | ETH + USDC as Base | ~$5.50 |
| BSC 56 | $5.00 | ~$0.50 | BNB + USDT/USDC (18 dec) | ~$5.50 |
| Ethereum 1 | $50.00 (5 × $10) or $0 watch-only | ~$15 | ETH | ~$65 or $0 |
| **Phase 2 total** | | | | **~$11–76** |

Funding comes from the user's own wallet, as before — Muse never moves user
funds unprompted. **Watch-only (dry-run) costs nothing and can start
immediately**; live buying on a chain starts only after that chain's funding
is confirmed onchain AND the user says "Go" for that chain.

## 10. Blockers & risks (honest list)

1. **Funding (§9).** ~$20 short for Phase 1, ~$11–76 more for Phase 2.
   Nothing live until funded.
2. **Privy CLI broadcast.** VERIFIED: Base, Arc, Robinhood. FAILS: Polygon
   (sign+broadcast fallback proven for setAgentURI, NOT tested for swaps —
   test with a tiny swap in dry-run-live before any Polygon "Go"). Ethereum:
   excluded by the prepared policy. Per-chain broadcast test required before
   any live buy on a new chain. Session restore
   (`restore-privy-machine-identity.sh`) before EVERY CLI call, as in v1.
3. **"Every chain" is not a real scope.** Hundreds of chains exist; only the
   7 in §1 have verified DEX + RPC + Privy paths. Everything else is out of
   scope until a chain proves all three.
4. **Per-chain address traps.** PoolManager/Router/Permit2/WETH differ per
   chain (§2.2); BSC stables are 18 dec; Arc has no WETH; Robinhood stock
   tokens need ERC-8056 pricing; Polygon gas spikes to 200+ gwei (the
   setAgentURI gas watch is still waiting at 40 gwei).
5. **Dexscreener rate limits.** 300 req/min lookups, 60 req/min profile
   feeds, ~10–30 req/min GeckoTerminal. A 2-min poll across 4–7 chains ×
   several endpoints fits easily — but a per-token social check on EVERY new
   pool (hundreds/hour on Base) needs batching (`/tokens/v1` accepts up to
   30 addresses per call) and caching, or it burns the budget.
6. **Socials are spoofable** (§5.3). A website + X account costs $10 and 10
   minutes. The score weights them at most 25/100 for exactly this reason.
7. **V3/V2 execution is a separate build.** Different pool math, quoter and
   router per type (V3 `exactInputSingle` via SwapRouter, V2 `swapExactTokens
   ForTokens` via Router02). V4-first; V3/V2 in Phase 2 after V4 is clean.
8. **Stock-quote risk.** Weekend-stale prices, single Authorised Participant,
   geo restrictions (US/CA/UK/CH excluded), ERC-8056 mispricing if built
   naively. Robinhood stock pairs are Phase 2, after the o1 factory-log
   verification (§4.3).
9. **Volume of candidates.** Base alone launches hundreds of tokens a day;
   the evaluator must be fast (onchain checks first, Dexscreener second,
   website-load last and async) or the bot falls behind the 2-min poll.
10. **The v1 lesson that still applies:** the Arc RPC estimator/broadcast
    path caps around ~16–17M gas per tx; viem's `getTransactionReceipt`
    THROWS when unmined (catch `TransactionReceiptNotFoundError` and keep
    polling); viem's `client.getLogs({topics})` silently ignores the topic
    filter on the Robinhood RPC (use raw `eth_getLogs`).

## 11. Dry-run-first build plan

- **Step 0 (now):** design only — this file + research report + Part 32 +
  MEMORY.md entry. No code, no state changes. User decides the 3 choices
  (§12) + the social-rule choice (§5.3/§6.3).
- **Step 1 — watch-only v2 (no user funds needed):** V4 watchers on Base +
  Arc (+ Robinhood expanded pairs: WETH + USDC + USDG). Expanded quote
  allowlist, Dexscreener social check as a logged score with +10 min
  re-check. Dry-run only, 2-min poll per chain. **Measure for 3–7 days:**
  new pools/chain/day; % passing onchain gates; % with website+social at
  detection vs +10 min; score distribution; Dexscreener rate-limit headroom.
- **Step 2 — verify the open items:** per-chain PoolManager/Router/Permit2/
  quoter/WETH/USDC addresses (§2.2); o1 factory-log check for stock-paired
  launches (§4.3); Polygon sign+broadcast swap test (tiny, on "Go" only);
  BSC V3 factory existence. **Pre-build checklist from the pool-detection
  research (must-do before wiring):** probe the Base V3 factory conflict
  (`0x33128a8f…` vs `0x1F98431c…` via `getPool()` / `PoolCreated` history);
  `eth_getCode` BSC V3 `0xdB1d1001…`, QuickSwap V3 `0x411b0fAc…`, Sushi V2
  Base `0x71524B4f…`; confirm one live `PoolCreated` log for Aerodrome v2
  (topic `0xa9d67f07…`) and one Algebra `Pool` log (topic `0x91ccaa7a…`);
  confirm the Dexscreener `arc` chain slug with one live API call; resolve
  Uniswap V2 on Arc (likely absent — confirm, don't assume).
- **Step 3 — add V3/V2 watchers + Robinhood stock pairs** (only where Step 1
  is clean and Step 2 verified). Polygon last.
- **Step 4 — live, per chain, only after:** funding per chain confirmed
  onchain (§9), user picks the choices (§12), and says "Go" per chain.
  First live buy per chain is a single $1 test (same discipline as the v1
  test buys), verified onchain before the cap opens.
- **Step 5 — position management** is per-chain but shared rules: sell 50%
  at +100%, all at −50%, otherwise hold; re-score at +60 min; social-profile
  appearance is logged, not auto-traded.

## 12. Differences from EXPANSION-PLAN-v2.md (parent draft, ~16:20 WIB)

1. **Stock pairs on Robinhood:** the draft says stock tokens "pair with USDG,
   not with new meme launches". The research behind this spec cites a Sept
   2026 on-chain audit counting 22,359 launchpad memecoin pairs touching a
   stock token. Unresolved — Phase 1 must check the o1 factory logs (§4.3).
2. **Buy size:** the draft leaves it as user choice #2 with no recommendation.
   This spec RECOMMENDS $1 per snipe on Phase 1 chains (§7) with reasoning.
3. **Cap:** the draft lists options (5 total / 5 per chain / new total). This
   spec RECOMMENDS 5 per chain (§8) with the explicit note that it reopens
   the user's 2026-11-07 ~15:09 "Keep cap at 5" decision.
4. **Scoring:** the draft proposes hard-gate-with-+10-min-wait OR score-only.
   This spec picks a concrete rubric (0–100, §6) with thresholds (≥70 full,
   50–69 half, <50 watch) — the "score it" option, with the +10 min re-check
   built in as Tier B.
5. **Pool detection:** the draft says "DexScreener labels confirm v2/v3/v4
   pools all exist". This spec adds the verified negative: Dexscreener has NO
   new-pairs endpoint and cannot be the primary trigger (§2.4).
6. **V4 PoolManager:** the draft notes Robinhood's differs; this spec gives
   the verified per-chain table (§2.2) incl. Base `0x4985…` and Ethereum
   `0x0000…4444`, both confirmed via `eth_getCode` this session.

## 13. The choices for the user (as promised in chat)

1. **Chains first:** (a) Robinhood → Base → Arc → Polygon in that order, or
   (b) all four at once in dry-run watch-only. (Recommendation: (b) for
   dry-run — it costs nothing — then (a) for live, one chain at a time.)
2. **Buy size per snipe:** keep 0.00001 ETH-equivalent (~$0.02), or $1
   (recommended, §7), or another size.
3. **New cap:** keep 5 total, or 5 per chain (recommended, §8), or a new total.
4. **Social rule:** hard gate with +10 min wait, or score it with thresholds
   (recommended, §6.3). Plus: minimum = website + 1 social, or website + 2
   socials?
5. **Confirm:** "prediction" means predicting legit NEW launches (this design),
   not prediction markets — yes / no?

## References

- V1 bot: `~/workspace/tokens/sniper/robinhood/` (run.js, evaluate.js,
  trade.js, STATE.json, LOG.md, README.md); research
  `~/workspace/research_notes/robinhood-token-sniper-20261107-0831/report.md`;
  tools-and-sites Part 28.
- Quote tokens + stocks:
  `~/workspace/research_notes/verified-quote-tokens-tokenized-stocks-20261107-1616/report.md`
- This design's research report:
  `~/workspace/research_notes/sniper-v2-multichain-20261107-1615/report.md`;
  tools-and-sites Part 32.
- Parent draft: `~/workspace/tokens/sniper/EXPANSION-PLAN-v2.md`.
- Dexscreener API: docs verified live 2026-11-07 (no key, 300/60 req/min);
  GeckoTerminal API (Part 31). Uniswap V4 deployments:
  developers.uniswap.org/docs/protocols/v4/deployments.
