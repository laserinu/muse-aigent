# Sniper v2 — Expansion Plan (DRAFT, watch-only until approved)

Prepared 2026-11-07 ~16:20 GMT+7, for the user's message 2026-11-07 09:15:43Z:
"Change it to watch the new prediction for intelligently legit tokens that has minimum
social media platforms and websites, from all available pools, and for all paired with
all verified tokens and stocks, on every chains."

Main agent replied 09:16:25Z promising this design + 3 choices (chains first, buy size,
new cap). This file is that design. NOTHING has been changed in the live bot:
`STATE.json` untouched (live=true, 5/5, manage-only on Robinhood), no cron change,
no code change, no buys. v2 is dry-run first, live only on a per-chain "Go".

## v1 today (verified)

- Robinhood Chain (4663) only, Uniswap V4 only, WETH pair only. 0.00001 ETH per snipe,
  cap 5 total, sell 50% at +100%, sell all at −50%.
- 5/5 filled (Alon, GHOST, KYLIE, BAG, MAGATARD), all −1.3% to −2.3% at last check
  (2026-11-07 09:15Z run, skipped=970), no sell triggers.
- Legit checks: WETH pair, not our $RMUSE/$MUSE, readable ERC-20, no
  mint/pause/blacklist/maxTx/tax selectors in bytecode, honeypot buy+sell simulation
  (transfer-simulation fallback when the quoter reverts on hooks), active liquidity > 0.
- Code: `~/workspace/tokens/sniper/robinhood/` (run.js, evaluate.js, trade.js).
  Watcher cron `robinhood-token-sniper-watcher`, every 2 min.

## v2 scope, dimension by dimension

### 1. Chains — start with our 4, then more

Uniswap V4 is deployed on 40 networks including Ethereum, Arbitrum, Arc, Avalanche,
Base, BNB, Polygon and Robinhood Chain (developers.uniswap.org/deployments, checked
2026-11-07). So V4 watchers are possible on all four of our chains. BUT per-chain
contract addresses MUST be verified, never assumed equal: on Robinhood the
PoolManager is 0x8366a39CC670B4001A1121B8F6A443A643e40951 and the Universal Router is
0x8876… (a Robinhood-modified fork; canonical 0x4fcA… has NO code there). Each new
chain needs its own PoolManager, Router, Permit2, quoter and WETH/native addresses
verified via eth_getCode + explorer before any trade.

Privy CLI broadcast status (from our own verified history):
- VERIFIED: Base, Arc, Robinhood.
- FAILS: Polygon (CLI broadcast reverts; workaround is eth_signTransaction + broadcast
  the raw tx via a public RPC — proven as a pattern for setAgentURI, NOT yet tested
  for swaps). Polygon goes last.
- EXCLUDED: Ethereum mainnet (prepared Privy policy excludes it; user rule).
- Solana is separate: no Uniswap V4 there; launches are Pump.fun / Raydium, and the
  Privy Solana wallet is 0 / unfunded. Out of scope for v2; a different bot if ever.

Recommended order: Robinhood (proven) → Base → Arc → Polygon last.

### 2. Pools — V4 first, V3/V2 second

- V4 `PoolManager.Initialize` is the existing trigger and covers most new launches:
  Pools.xyz and Clanker v5 both launch on V4.
- V3 (`Factory.PoolCreated`) and V2 (`Factory.PairCreated`) are separate watchers with
  separate evaluators (different pool math, quoter, router). Phase 2, after V4 works
  on the new chains. DexScreener labels confirm v2/v3/v4 pools all exist and are
  indexed (checked live 2026-11-07).

### 3. Verified pairs — the real gain is USDC/USDT/native, not stocks

Proposed quote allowlist (per chain, only pairs where one side is on this list):
WETH / native ETH, USDC, USDT, WBTC, plus chain verified stables (USDG on Robinhood).

Addresses VERIFIED from our own records — use only these until others are verified:
- Robinhood WETH: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
- Base WETH: 0x4200000000000000000000000000000000000006
- Base USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Arc USDC (also Arc's native gas token): 0x3600000000000000000000000000000000000000
- Everything else (USDT, WBTC, USDG, any stock token) must be verified per chain
  via explorer + eth_getCode before being added. Do NOT copy addresses from memory.

Tokenized stocks — verified to exist, but nearly empty as launch pairs:
- Robinhood on-chain Stock Tokens: ~190 US stocks/ETFs as ERC-20 on Robinhood Chain,
  trade 24/7 on DEXs there, issued by Robinhood Assets (Jersey) Ltd, backed 1:1.
  Canonical contract list published by the issuer at api.robinhood.com/rhj/assets.
  On Robinhood Chain they pair with USDG, not with new meme launches.
- xStocks (Backed): Ethereum, Solana, Arbitrum, Mantle, TON, Ink and others.
- Ondo Global Markets ("…on" tokens): Ethereum, BNB Chain, Solana.
- Coinbase Tokenized Stocks: Base (B20 standard), pair with USDC.
- All are non-US persons only — eligibility restriction to respect.
- Honest conclusion: a new token paired with a stock token will be rare. The
  expansion's real catch is USDC/USDT/native-ETH pairs. Evidence: in the v1 dry run
  16 of 18 new Robinhood pools were skipped for not being WETH pairs — most were
  native-ETH pairs. Adding native ETH + USDC pairs is where the volume is.

### 4. Social / website rule — VERIFIED source, but a timing problem

Source verified live 2026-11-07 09:18 UTC via the free DexScreener API (no key):
`GET https://api.dexscreener.com/latest/dex/search?q=pepe` returns per pair
`info.websites[]` and `info.socials[]` (type twitter/telegram/discord) when the token
has them — e.g. PEPE on Robinhood has pepeinhood.com + x.com/pepeinhood + t.me.
GeckoTerminal is the fallback for candles; DexScreener is the source for socials.

Timing problem, verified on our own position: Alon — bought 2026-11-07, hours old —
returns NO `info` field at all on the DexScreener token endpoint (checked 09:17 UTC).
New launches usually have no DexScreener-indexed website/socials in their first
minutes, and some never get indexed. A hard gate at snipe time would have blocked
our own 5 buys.

Proposed rule (as told to the user in chat): token must have a real website that
LOADS (HTTP 200, not just listed) plus at least 1 social (X / Telegram), on top of
all current onchain checks. Implementation must be two-tier:
- Tier A (instant): onchain checks pass → candidate logged, social check attempted.
- Tier B (delayed): if `info` is present at detection, proceed. If absent, re-check
  DexScreener at +10 min; buy only if the website + social appear by then.
- Choice for the user: (i) hard gate with the +10 min wait (slower, misses the
  earliest entry, fewer junk buys), or (ii) score it — buy onchain PASS at small size
  and flag "no socials yet" (faster, keeps v1 behaviour, socials become a filter for
  the NEXT buys, not this one). Recommended: (i) for new chains while dry-running,
  decide after seeing how many real launches actually have info at +10 min.

Note: a website + socials does not prove legitimacy — scammers buy both. It is one
signal on top of the bytecode / honeypot / liquidity checks, not a replacement.

### 5. Funding — the hard blocker

Agent wallet total ~$1.15 (portfolio snapshot 2026-11-07 ~15:10 GMT+7):
Robinhood ETH 0.00002238, Base ETH 0.0003566, Arc USDC 0.098111, Polygon POL
0.264159, Solana 0. Robinhood alone cannot fund even 2 more snipes at 0.00001 ETH
+ gas. Every new chain needs its own gas token + quote token funded before ANY live
buy there. Funding comes from the user's own wallet, as before — Muse never moves
user funds unprompted. Watch-only (dry-run) costs nothing and can start immediately.

### 6. What does NOT change

- Privy agent wallet only; no seed phrase / private key ever.
- `state.live` gate per bot; v2 starts dry-run, live only on explicit "Go".
- Sell rules stay: 50% at +100%, all at −50%, otherwise hold.
- Never buy our own $MUSE / $RMUSE. Never buy a token already held.
- "New prediction" is read as intelligently predicting which NEW launches are legit
  (the current trigger + checks, extended) — NOT prediction markets. Confirm if the
  user meant prediction markets (e.g. Polymarket-style); that would be a different build.

## Phases

- Phase 1 — build watch-only v2: V4 watchers on Base + Arc (+ Robinhood expanded
  pairs), expanded quote allowlist, DexScreener social/website check as a logged
  score with +10 min re-check. Dry-run only. Measure: how many new pools per chain,
  how many pass onchain checks, how many have website+social at detection vs +10 min.
- Phase 2 — add V3/V2 watchers and stock-token pairs (from the verified issuer lists)
  on chains where Phase 1 is clean; Polygon last, after its broadcast fallback is
  tested for swaps.
- Phase 3 — live, only after: funding per chain confirmed onchain, user picks the
  3 choices below, and says "Go" per chain.

## The 3 choices for the user (as promised in chat)

1. **Chains first:** (a) Robinhood → Base → Arc → Polygon in that order, or
   (b) all four at once in dry-run watch-only.
2. **Buy size per snipe:** keep 0.00001 ETH-equivalent per buy, or change it
   (smaller on unproven chains is the cautious option).
3. **New cap:** keep 5 total, or a per-chain cap (e.g. 5 per chain), or a new total
   (e.g. 10 / 20). Note: user chose "Keep cap at 5" on 2026-11-07 ~15:09 GMT+7, one
   hour before this request — the cap question is only reopened because the scope
   itself changed.
Plus the social-rule choice from §4: hard gate with +10 min wait, or score-only.

## Open / to verify during Phase 1 build

- Per-chain PoolManager / Router / Permit2 / quoter / WETH / USDC / USDT / WBTC
  addresses (eth_getCode + explorer each).
- Privy CLI broadcast test per chain (small read + a tiny signed tx only on "Go").
- DexScreener rate limits on the token/search endpoints at 2-min polling across
  4 chains (300 req/min free tier, per earlier research).
- Whether "prediction" meant prediction markets — ask in the delivery message.
