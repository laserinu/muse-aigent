# First live $MUSE swap — TEST BUY (mainnet)

**Date:** 2026-11-07 ~06:05 WIB
**Purpose:** First-ever swap on the $MUSE pool (proves the pool works on mainnet and the 3% hook fee works live). Direct Universal Router V4_SWAP, bypassing the V4Quoter (which reverts on our hook). Full diagnosis of the quoter failure: `BITGET-NO-QUOTE.md`.

## Result: SUCCESS — the pool works, the 3% fee works

Buy 0.05 USDC → MUSE. The agent wallet is both the trader AND the fee recipient, so it received the full gross output (97% as trader + 3% as fee).

## Transactions (Arc 5042, agent wallet via Privy CLI)

| # | Action | Hash | Block | Gas |
|---|---|---|---|---|
| A | Approve USDC → Permit2 (50000) | `0xa3aac5a2b2610b31252c55b341b927287ea63386c3e027e9d1b284b91e3d6aff` | 29912864 | 55,366 |
| B | Permit2 approve USDC → Universal Router (50000, exp 1825542369) | `0xb5bb3acea707d29a525498edb9d4fb3d70e6b931afa4a6849f69076cecf48e98` | 29912894 | 47,350 |
| C | Universal Router execute V4_SWAP | `0x849ef9f90e11b648ba3202ea068e7ebe7be6453ffbdc5dab107f520161dc27ef` | 29912924 | 167,299 |

Total gas: 270,015 (~0.006953 USDC at ~25.7 gwei effective). Agent USDC: 0.155064 → **0.098111** (0.05 swap + 0.006953 gas).

## Swap (tx C) — verified onchain

- **Swap event (PoolManager):** amount0 = **-50,000** (0.05 USDC paid), amount1 = **+986,590,874,864,171,228** base units = **986,590,874.86 MUSE** gross output. sqrtPriceX96 after = 350619864481328214187958559009265530, tick **306072** (was 306282), liquidity unchanged 21,130,171,658,904.
- **FeeTaken event (hook):** recipient = agent wallet, currency = MUSE, fee = **29,597,726,245,925,136** base units = **29,597,726.25 MUSE**. That is **exactly 3.000%** of the gross output (986,590,874.86 × 0.03 = 29,597,726.25). **The 3% hook fee is PROVEN on mainnet.**
- **Net to trader:** 986,590,874.86 − 29,597,726.25 = **956,993,148.62 MUSE** (97%).
- **Total MUSE received by agent (trader + fee recipient):** **986,590,874.86 MUSE**.
- **Agent MUSE after:** 145,054,684.84 + 986,590,874.86 = **1,131,645,559.71 MUSE** (verified onchain: 1,131,645,559,706,759,421 base units).

## Expected vs actual (pre-computed from exact V4 math)

| | Expected (computed) | Actual (onchain) |
|---|---|---|
| Gross MUSE out | 986,590,472.31 | 986,590,874.86 |
| Hook fee 3% | 29,597,714.17 | 29,597,726.25 |
| Net to trader | 956,992,758.14 | 956,993,148.62 |
| New tick | ~306073 | 306072 |

Differences ≤ 0.00004% — BigInt rounding in the pre-computation (sqrt-price division truncation). No material deviation.

## Price impact

- Spot (no impact, no fees): 0.05 USDC → 1,000,000,000 MUSE.
- Gross output 986,590,874.86 MUSE is 1.34% below spot (0.30% LP fee + ~1.05% pure price impact, matching the repositioning model).
- Marginal price move: tick 306282 → 306072 (210 ticks); MUSE price $5.000e-11 → ~$5.107e-11 (+~2.1% marginal, ~1.05% average execution impact).

## Route (working — quoters all fail)

Direct Universal Router `execute` (0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1) with command V4_SWAP (0x10), actions [SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)], PoolKey (USDC/MUSE, fee 3000, tickSpacing 60, hook 0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044), zeroForOne = true, amountIn = 50000, amountOutMinimum = 937,852,902,973,854,168 (net minus 2% slippage), hookData empty, deadline +30 min.

**Key encoding finding:** `ExactInputSingleParams` must encode the PoolKey as a nested TUPLE, not as a `bytes` value. Encoding it as bytes misaligns the struct and the swap reverts with a bare revert (no data). The 6-field layout (with `minHopPriceX36`) is correct for the deployed router — proven by simulation: with the bytes encoding the sim reverted bare; with the tuple encoding it reverted with `AllowanceExpired(0)` (Permit2, expected before approvals); after the approvals the sim succeeded and the real tx confirmed.

**Approvals needed (one-time for the router):** ERC-20 approve USDC → Permit2 (exact 50000) + `permit2.approve(USDC, UniversalRouter, 50000, +1y)`. The MUSE → Permit2 approval from the repositioning (tx 01) is still set and was not needed for this buy.

## Files

- Calldata: `swap/01-approve-usdc-permit2.json`, `swap/02-permit2-approve-router.json`, `swap/03-router-execute.json`, `swap/expected.json`
- Build script: `build-swap-calldata.js`
- Diagnosis (why quoters fail): `BITGET-NO-QUOTE.md`
