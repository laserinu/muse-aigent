# $MUSE Pool Repositioning — COMPLETE

**Date:** 2026-11-07 (attempt 2; attempt 1 was 2026-11-06 ~22:10 GMT+7)
**Status:** ✅ COMPLETE — position repositioned from full range to a ±25% concentrated range.

## What changed

| | Before | After |
|---|---|---|
| Position NFT | 322143 (full range) | **322298** (concentrated) |
| Tick range | [-887220, 887220] | **[304080, 308520]** |
| Price bounds | — | +25.08% / −20.24% |
| Liquidity | 2,236,067,997,499 | **21,130,171,658,904** |
| Depth multiplier | 1x | **9.4497x** |
| 0.05 USDC buy impact | 9.09% | **1.05%** |
| 0.5 USDC buy impact | 50.00% | **9.57%** |

Same capital (10B MUSE + 0.5 USDC), no new USDC added. Pool price unchanged by the repositioning (sqrtPriceX96 and tick identical before/after).

## Transactions

All on Arc (5042), from the agent wallet 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4 via the Privy CLI. No policy attached, so nothing gated the txs.

### Attempt 1 (2026-11-06 ~22:10 GMT+7) — partial, session broke
| # | Action | Hash | Block | Gas | Status |
|---|---|---|---|---|---|
| 01 | Approve MUSE → Permit2 | 0x97797347fc03ecb686e5b5b5abd43672cb6857fd321b6ace91c80473a3e81ccb | 29906329 | 46,311 | ✅ success |

Session broke ("Not logged in") between tx 01 and tx 02. Attempt 1 stopped per safety rules. Full record: `REPOSITIONING-ATTEMPT-1.md`.

### Attempt 2 (2026-11-07 ~05:14–05:20 GMT+7) — complete
Privy re-login completed ~05:14 GMT+7 (device code YKFTR-YZ6F6). Pool re-verified first (block 29906807): price still exactly at seed (tick 306282, sqrtPriceX96 unchanged), position 322143 full range, agent USDC 1.454687. MUSE → Permit2 allowance from tx 01 confirmed still set (1e19) — tx 01 NOT resent. Calldata rebuilt with a fresh deadline (unix 1794010532, +2h). Target range [304080, 308520] reused — tick was still 306282, so no recompute was needed.

| # | Action | Hash | Block | Gas | Status |
|---|---|---|---|---|---|
| 02 | Approve USDC → Permit2 (500,000) | 0xb0d7af08da27f95d122a0506788fd48ca8ff702158c781cf56c36c15dd79271c | 29906879 | 55,378 | ✅ success |
| 03 | Permit2 approve MUSE → PositionManager (1e19) | 0x5a61d8edbab50d7d1512c7c2ae41bcc589db5082e1350bae00b599c5f74e93f1 | 29906902 | 47,650 | ✅ success |
| 04 | Permit2 approve USDC → PositionManager (500,000) | 0xbe7a3ee5747bd9951bd8612540d2ed0c6f297a5a9874c1a1f2c296c986cb4bff | 29906923 | 47,386 | ✅ success |
| 05 | Burn NFT 322143 (decrease liquidity to 0 + collect) | 0x75e3c23e975380dd26a2d46710d93759d1b9dba06615c7bb3ae6dc83951507b5 | 29906943 | 156,736 | ✅ success |
| 06 | Mint new position [304080, 308520], liquidity 21,130,171,658,904 | 0xb1804c47cfc51300612a42e575f3d92132c180a8860ecdca00eb792fceaf9400 | 29906989 | 364,639 | ✅ success |

Total gas: attempt 2 = 671,789 gas (~0.0152 USDC); all 6 txs = 718,100 gas (~0.0162 USDC).

## Onchain verification (Arc block 29907044)

- **New position NFT 322298**, owner = agent wallet. Liquidity **21,130,171,658,904** (exactly the computed value). Ticks [304080, 308520], fee 3000, tickSpacing 60, hook 0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044.
- **Old position 322143: liquidity 0, ownerOf reverts (BURNED).**
- **Pool unchanged:** sqrtPriceX96 354319114228591420592203432321452013, tick 306282, price still exactly $5e-11 per MUSE. No swaps have ever run on mainnet.
- **Mint consumed:** 499,999 / 500,000 USDC and 9,854,945,315 / 10,000,000,000 MUSE — exactly as modelled (LiquidityAmounts).
- **Agent wallet after:** MUSE 145,054,684.84 (leftover from the 10B), USDC **1.439483** (was 1.454687; −0.015204 USDC gas for txs 02–06).
- **Depth verified independently** with the V4 exact-input swap math (not just the model): 0.05 USDC buy → 989,528,467 MUSE out, **1.05%** execution impact (was 9.09%); 0.5 USDC buy → 9,043,034,732 MUSE out, **9.57%** (was 50.00%). Marginal price moves: 2.08% and 18.22%.

## Notes / risks

- **Range-out risk:** if the price rises 25.08% or falls 20.24%, the position goes single-sided and stops providing liquidity at the current price until repositioned again (more gas each time).
- **Airdrop readiness:** the pool is now ~9.5x deeper, so a single 2B MUSE airdrop sale moves the price ~1.8% instead of ~17%. The repositioning-first prerequisite for the airdrop is now satisfied.
- **Privy session fragility:** the session broke 6 times across the two attempts (VM replacement changes the machine-id). Attempt 2 succeeded only because the re-login happened minutes before the sends. Any future onchain work should re-verify the session immediately before sending.
- **Calldata:** `~/workspace/tokens/muse-ai-agent/reposition/01–06-*.json` (deadline unix 1794010532 — expired after the run; rebuild before any reuse). Scripts: `verify-pool-state.js`, `build-reposition-calldata.js`, `script/ComputeReposition.s.sol`.
- **Leftover MUSE:** 145,054,684.84 MUSE now sits in the agent wallet (not in the pool). It is the rounding leftover from the mint.
