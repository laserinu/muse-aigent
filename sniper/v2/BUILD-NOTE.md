# Sniper v2 — Build Note (2026-11-07 ~16:30–16:40 GMT+7)

## What was built

Sniper v2 in `~/workspace/tokens/sniper/v2/`, **dry-run only**. Chain-agnostic
and config-driven for **any EVM chain** (user scope: "for all EVM Chains") —
no chain id, RPC, or contract address is hardcoded in the JS. Adding a chain
is one `config.json` entry; the README documents the exact pre-flight rule.

- `config.json` — 7 chains (4 Phase 1 enabled, 3 Phase 2 disabled), quote
  allowlists with per-token decimals, scoring thresholds, buy size $1,
  cap 5/chain, sell +100% half / −50% all, `live: false` everywhere.
- `chains.js` — per-chain clients, raw `eth_getLogs` (viem `getLogs` topic
  filter is unreliable — proven on Robinhood), Initialize decoding,
  `extsload` pool-state reads, Sourcify check.
- `social.js` — Dexscreener `/tokens/v1` info + website HTTP 200 check.
  Scored, never a hard gate. Dexscreener links are self-declared, not
  verified — noted in code.
- `evaluate.js` — all v1 hard gates (generalized to any quote) + 0–100
  scoring (social 25, verified 10, depth 15, LP locked 10, deployer 10
  with rug −20 veto, impersonation 5, traction 15, launchpad 5).
  ≥70 full, 50–69 half, <50 watch.
- `trade.js` — execution stub reusing the proven v1 pattern (wrap → approve
  Permit2 → Permit2 approve router → Universal Router V4_SWAP, PoolKey as
  nested tuple). Live gate refuses unless master + chain live + enabled +
  not blocked + `{ liveConfirm: true }`. **Polygon execution is blocked in
  code** (Privy CLI broadcast fails there).
- `run.js` — watcher driver (`--chains`, `--window-blocks`, `--live`),
  per-chain state, +10 min social re-check queue, position management
  (dry-run logs only).
- `STATE.json` — fresh v2 state (separate from v1's). `LOG.md` — run log.
- `DRY-RUN-TEST.md` — full test record. `README.md` — incl. the
  "Adding a new EVM chain" pre-flight checklist.

## Verified per chain (eth_getCode + decimals()/symbol(), 2026-11-07)

- **Robinhood 4663** — PoolManager, Router (fork 0x8876…), Permit2 F6B,
  V4Quoter 0x8Dc1…, PositionManager, WETH 18, USDC 6, USDG 6. All OK.
- **Base 8453** — PoolManager, legacy Router 0x3fC9… (deprecated), Router v2
  0x6ff5…, Permit2 F6B, V4Quoter **0x0d5e…** (the v1 quoter 0x8Dc1… has NO
  code here), WETH 18, USDC 0x8335… 6. All OK. PositionManager unverified.
- **Arc 5042** — PoolManager, Router 0x4fcA…, Permit2 F6B, V4Quoter
  0x8Dc1…, PositionManager 0x6049…, USDC 6, EURC 6. All OK.
- **Polygon 137** — PoolManager 0x6736… (docs address confirmed with code),
  legacy Router 0x3fC9… (deprecated), Router v2 0x1095…, Permit2 F6B,
  V4Quoter **0xb3d5…** (0x8Dc1… has NO code here), WPOL 18, USDC 6. All OK.
  PositionManager unverified. Broadcast fails — watch-only.
- **Ethereum 1** — PoolManager 24009B, V4Quoter 0x52f0… 5820B, Permit2,
  WETH 18, USDC 6. Core verified; Router compat unverified. Disabled.
- **Arbitrum 42161** — PoolManager 24009B, Permit2, WETH 18, USDC 6.
  Core verified; Quoter/Router/PositionManager unverified. Disabled.
- **BSC 56** — PoolManager 24009B, Permit2, WBNB 18, USDC **18**,
  USDT **18**. Core verified; Quoter/Router/PositionManager unverified.
  Disabled. (BSC stables are 18 dec — the sizing trap is handled
  per-token in config.)

## Dry-run results (7,200 blocks, 24 pools, 0 buys)

Robinhood 13 pools → 1 hard-gate PASS (Al-Buqqi, 10/100, WATCH). Base 9 → 0.
Arc 2 → 0. Polygon 0. Alon re-evaluated: PASS, 10/100, WATCH — **all 5 v1
buys would have been watch-only under v2 at T+0** (Dexscreener info:null).
PEPE social control: 20/25 (website loads + 1 social). +10 min re-check
branch verified. Live gates verified to refuse in all three tested cases.
Full detail: `DRY-RUN-TEST.md`. **Zero transactions sent.**

## Still unverified / blocked

- **PositionManager on Base/Polygon** — only truncated Dedaub addresses;
  left `null`, not guessed. Not needed for swaps.
- **v1 `execute()` encoding on the Base/Polygon v2 routers** — unproven.
  A test swap must prove it before any live buy there (or use the legacy
  router, which is deprecated but has code).
- **Rug-deployer list** (`config.knownRugDeployers`) and **launchpad
  registry** (`config.launchpadContracts`) are empty — the deployer-history
  and launchpad score components return 0 until curated per chain.
- **LP-locked scoring** — not checkable at T+0 for V4 (positions are NFTs);
  returns 0 with a re-check note.
- **Ethereum live** — excluded by the prepared Privy policy (chain 1
  DENY) and gas dwarfs a $1 buy. Watch-only by default.
- **V3/V2 watchers** — Phase 2, not built. (Base V3 factory conflict noted:
  docs 0x33128a8f… vs code at 0x1F98431c…; Robinhood/Arc V3 literals are
  forwarder decoys.)
- **Tokenized stocks as quotes** — not wired. Real only on Robinhood
  (~194 tokens); the o1-factory-logs question from the design is still
  open, and ERC-8056 pricing is mandatory (not implemented).
- **USD price feed** — buy sizing uses approximate static prices in
  `trade.js` (ETH $2500, POL $0.20, BNB $1100, stables $1). Must be replaced
  with a live feed before any live buy.

## Funding — the live blocker

Wallet is ~$1.15 total (Robinhood ETH 0.000022, Base ETH 0.00035, Arc USDC
0.098, Polygon POL 0.26). **Phase 1 live needs ~$20.20 top-up**
(Robinhood ~$5.05, Base ~$4.70, Arc ~$5.00, Polygon ~$5.45).
Live is NOT possible until the user funds each chain + says "Go" per chain.
Watch-only dry-run costs nothing and can run now.

## Choices still owed to the user (from the design)

Chains first (in order vs all four at once in dry-run), buy size ($1 proposed
vs keep ~$0.02), new cap (5 per chain proposed vs keep 5 total — reopens the
2026-11-07 ~15:09 decision), social rule (score with +10 min re-check
proposed vs hard gate; website + 1 social vs + 2 socials), and confirm
"prediction" means predicting legit NEW launches, not prediction markets.

## Safety confirmations

- **v1 untouched:** `~/workspace/tokens/sniper/robinhood/` run.js /
  evaluate.js / trade.js / README.md mtimes still 2026-11-07 01:43–01:56 GMT+7.
  Only STATE.json/LOG.md changed, by the live watcher's own 2-min runs.
- No cron touched, no live flag flipped, no transaction sent.
- Zip: `~/workspace/tokens/sniper-v2-build.zip` (see report).
