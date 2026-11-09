# Sniper v2 — Multichain, chain-agnostic, DRY-RUN only

**Live status: OFF.** `config.json` has `live: false` (master) and every chain
has `live: false`. The runner only reads, evaluates, and logs. No transaction
is sent in dry-run. Live per chain needs: funding confirmed onchain + the user
saying "Go" per chain + flipping that chain's `live` flag (and the master
`config.live`). See "Going live" below.

## What v2 changes vs v1

| | v1 (robinhood/) | v2 (this folder) |
|---|---|---|
| Chains | Robinhood only | Any EVM chain, config-driven |
| Pools | V4 only | V4 only (Phase 1; V3/V2 are Phase 2) |
| Quotes | WETH only | Per-chain allowlist: WETH/WPOL, USDC, USDG, EURC |
| Legit check | Hard gates only | Hard gates + 0–100 score |
| Social/website | Not checked | Dexscreener info, scored (NOT a hard gate) |
| Buy size | 0.00001 ETH hardcoded | `$1` equivalent, in config |
| Cap | 5 total, hardcoded | 5 per chain, in config |
| Sell rules | +100% half / −50% all | Same, in config |

## Files

- `config.json` — everything chain-specific lives here. No chain address is
  hardcoded in the JS. Phase 1 chains (enabled): Robinhood 4663, Base 8453,
  Arc 5042, Polygon 137. Phase 2 chains (disabled): Ethereum 1, Arbitrum
  42161, BSC 56 — core addresses verified, full stack not yet, see below.
- `chains.js` — per-chain clients, raw `eth_getLogs` scanning (viem's
  `getLogs` topic filter is unreliable on some RPCs — proven on Robinhood),
  pool-state reads via `extsload`, Sourcify check.
- `social.js` — Dexscreener `/tokens/v1` info (websites/socials) + website
  HTTP 200 check. Links are self-declared, not verified.
- `evaluate.js` — hard gates (all v1 checks, generalized to any quote) +
  0–100 scoring. `≥70` full size, `45–69` half, `<45` watch only. Buy line lowered 50 → 45 by user decision 2026-11-08 ~01:30 WIB (hooked pools cap at 45 at T+0).
- `trade.js` — execution stub. Calldata building reuses the proven v1
  pattern (wrap → approve Permit2 → Permit2 approve router → Universal
  Router V4_SWAP, PoolKey as nested tuple). `executeTxs` refuses unless
  config.live + chain.live + chain.enabled + not execution-blocked +
  `{ liveConfirm: true }`. **Polygon execution is blocked in code** — the
  Privy CLI broadcast fails there; Polygon is watch-only.
- `run.js` — watcher driver. `--chains 4663,8453`, `--window-blocks N`,
  `--live` (still gated by the flags above).
- `STATE.json` — per-chain last-scanned blocks, positions, pending
  social re-checks, snipes per chain. Separate from v1's STATE.json.
- `LOG.md` — run log.
- `DRY-RUN-TEST.md` — the dry-run test results.
- `BUILD-NOTE.md` — what was built, what was verified, what's blocked.

## Scoring (0–100, design §6)

- social/website +25 — website loads (HTTP 200) + ≥2 socials = 25;
  website + 1 social = 20; website only = 10; socials only = 10; none = 0.
- verified contract +10 — Sourcify match.
- liquidity depth +15 — quoter buy impact ≤1% +15, ≤5% +10, ≤10% +5.
- LP locked +10 — **not checkable at T+0 for V4** (positions are NFTs);
  scored 0, re-check at +60 min.
- deployer history +10 — first-time deployer +5; rug-linked −20 = **veto**.
  The rug list (`config.knownRugDeployers`) is empty until curated.
- no impersonation +5 — symbol matches a known token = 0 + flag.
- early traction +15 — T+5–60 min only, 0 at detection.
- launchpad provenance +5 — Initialize tx `to` in `config.launchpadContracts`
  (registry empty until curated per chain).

Honest limit (design §6.5): no T+0 signal predicts upside. The sell rules
(+100% half / −50% all) are the discipline, not the score.

## Adding a new EVM chain

No code change needed — add one entry under `chains` in `config.json`.
**Pre-flight rule (mandatory): verify every address before enabling.**

1. **Chain basics:** chain id, RPC URL, logs RPC (some chains' main RPC
   returns 0 for `eth_getLogs` — Arc needs Blockdaemon for logs), native gas
   token + decimals (e.g. POL 18, USDC-on-Arc 18 native / 6 ERC-20 face),
   wrapped native token address.
2. **Uniswap V4 contracts — verify each with `eth_getCode` (must return
   non-empty code) AND check the official Uniswap docs:**
   - PoolManager — **differs per chain.** Only Robinhood + Arc share
     `0x8366…`. Do NOT copy the Ethereum address to another chain.
   - Universal Router — note the legacy v1 router (`0x3fC9…`) is deprecated
     per Uniswap docs. The current v2 router address differs per chain.
     Record both; whether the v1 `execute()` encoding works on the v2
     router must be **proven with a test swap** before any live buy.
   - Permit2 — usually the canonical `0x0000…F6B`, but verify per chain
     (the `F7B` variant has NO code on Arc/Robinhood).
   - V4Quoter — **differs per chain.** `0x8Dc1…` has NO code on Base or
     Polygon. Find the per-chain quoter from Uniswap docs, verify code.
   - PositionManager — optional (not needed for swaps). Do NOT guess it;
     leave `null` with a note if unverified.
3. **Quote tokens — verify each with `eth_getCode` + `decimals()` +
   `symbol()` reads:**
   - Record decimals EXACTLY as the contract reports. **BSC stables are
     18 decimals, not 6** — assuming 6 would size buys 1,000,000× wrong.
   - Check the token is the real one: compare against the official issuer
     (Circle USDC, Paxos USDG) and the chain's explorer; watch for
     same-symbol impostors (Robinhood has a 30k-holder "Universal Stable
     Digital Coin" USDC impostor on Blockscout).
   - At least one live pool of that quote must exist on that chain, or the
     quote is dead weight — do not pre-fund it.
4. **Privy broadcast:** confirm the Privy CLI can broadcast on the chain
   (proven: Arc, Base, Robinhood; **fails: Polygon**). If it fails, the
   chain is watch-only until a sign+broadcast fallback is proven for swaps.
5. **Dexscreener slug:** the chain slug Dexscreener uses (e.g. `arc`,
   `robinhood`, `base`, `polygon`, `ethereum`, `arbitrum`, `bsc`) — verify
   with a live `/tokens/v1/{slug}/{knownToken}` call.
6. **Set the entry:** `enabled: false`, `phase: 2` until steps 1–5 pass,
   then `enabled: true`, `phase: 1`, `live: false`. Fill the `verified`
   block with what was checked and when. **Never wire an unverified
   address.**
7. **Dry-run first:** `node run.js --chains <id> --window-blocks 300` and
   confirm it sees real pools and evaluates them before ever enabling live.

Known traps (all verified 2026-11-07):
- Base V3 factory conflict: docs say `0x33128a8f…`, code found at
  `0x1F98431c…` — V3 is out of scope anyway; note it, don't wire it.
- On Robinhood/Arc the Ethereum V3 literals are forwarder decoys.
- Arc's EVM is pre-Shanghai — compile with `evm_version paris`.
- Arc has NO working WETH9; Arc pools are token/USDC.
- Arc baseFee is fixed at exactly 20 gwei; the RPC estimator/broadcast
  path caps around ~16–17M gas per tx.

## Going live (per chain)

1. Fund the chain: ~$5 per Phase 1 chain (design: $20.20 total for all
   four). Wallet is ~$1.15 total right now — **live is NOT possible until
   the user funds each chain**.
2. User says "Go" for that chain (per chain, explicitly).
3. Set that chain's `live: true` in `config.json` AND `config.live: true`.
4. Watch the first run's log. The runner refuses to send anything while
   any flag is false, and `trade.js` refuses Polygon always.

## Dry-run test

`node run.js --chains 4663,8453 --window-blocks 300` — see
`DRY-RUN-TEST.md` for the recorded results.
