# $MUSE Pool Balance — Recommendations (no new USDC)

Prepared 2026-11-07. Analysis only — no transaction was executed, no funds moved, no position changed.

## Current pool state (verified onchain, Arc block 29901059)

- Token: "Muse Ai Agent" ($MUSE), `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, 9 decimals, 100T fixed supply.
- Pool: Uniswap V4 MUSE/USDC, PoolId `0x5a14e63c9943a180d24b31f45964bc11e24639e9f055f88f33a3ac58b6b27ff1`.
- PoolManager: `0x8366a39CC670B4001A1121B8F6A443A643e40951`. Fee 3000 (0.3% LP) + 3% hook fee to the agent wallet.
- Hook: `0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044` (afterSwap only).
- **sqrtPriceX96 = 354319114228591420592203432321452013, tick = 306282 — identical to launch. No swap has ever run on mainnet.** Price is still the seed price: **$5e-11 per MUSE** (1 USDC = 20,000,000,000 MUSE; FDV $5,000).
- Reserves: **10,000,000,000 MUSE + 0.5 USDC** (PoolManager MUSE balance confirms 9,999,999,999.996 MUSE; the USDC is the seed amount, unchanged since no swaps). Liquidity 2,236,067,997,499. Full range [-887220, 887220]. Position NFT 322143, owner = agent wallet.
- Locked: factory `0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0` holds **99,990,000,000,000 MUSE (~99.99T)**. Agent wallet holds **0 MUSE** and **0.12264 USDC** (native gas + ERC-20 are the same underlying value on Arc — do not double-count).
- Arc gas price at check: **25 gwei**. Repositioning (burn old position + mint new) is estimated at ~800k–1.2M gas = **~0.02–0.03 USDC**, which the wallet's 0.12264 USDC covers with ~0.09–0.10 USDC left. Gas price can vary; if it spiked to 100 gwei the same move would cost ~0.08–0.12 USDC and nearly drain the wallet.

## The problem, in numbers (full-range pool, as it stands)

A 0.05 USDC buy gets 909,090,910 MUSE pre-fee (881,818,183 after the 3% hook) at **9.1% price impact**. A 0.5 USDC buy — the entire USDC reserve — has **50% price impact**. A 1 USDC buy has 66.7% impact; a 5 USDC buy has 90.9%. The pool is so thin that any real trade moves the price violently. "Balanced" here means: deeper at the current price (so normal trades barely move it), and a supply story that does not overhang the market.

## 1. REPOSITION TO A CONCENTRATED RANGE — the #1 recommendation

Move the SAME 10B MUSE + 0.5 USDC from the full range into a narrower tick range around the current price. Same capital, far deeper where it matters. Modelled with the V4 swap math (verified: the 0.05 USDC buy reproduces 909M MUSE pre-fee, matching the earlier MEV research).

| Range | Liquidity multiplier vs full range | 0.05 USDC buy price impact | 0.5 USDC buy price impact | 5 USDC buy |
|---|---|---|---|---|
| Full range (now) | 1.0x | 9.1% | 50.0% | 90.9% |
| ±50% | 5.4x | 1.8% | 15.5% | range exhausted |
| **±25%** | **9.5x** | **1.0%** | **9.5%** | range exhausted |
| ±10% | 21.5x | 0.5% | 4.4% | range exhausted |
| ±5% | 41.5x | 0.2% | 2.4% | range exhausted |

**Recommended: ±25%.** It makes the pool ~9.5x deeper at the current price (a 0.05 USDC buy drops from 9.1% to 1.0% impact; a 0.5 USDC buy from 50% to 9.5%), while tolerating a 25% price rise or a 20% fall before the position goes out of range. ±10% is the aggressive alternative (21.5x deeper, 0.5% impact on a 0.05 USDC buy) but exits on a 10% move — very likely for a new token, so it needs more frequent repositioning. ±5% (41.5x) is the deepest but exits on a 5% move — too fragile.

**Trade-off (the real cost): range-out.** If the price moves outside the range, the position goes single-sided (all MUSE if the price rose above, all USDC if it fell below) and stops providing liquidity at the new price. The pool then has NO liquidity until someone repositions or adds a new position, and each repositioning costs ~0.02–0.03 USDC in gas. A ±25% range will exit if the token moves 25% — which a new token can do in a day. That is the price of depth. The full-range position never exits, but it is too thin to be usable. The concentrated range is the right call; just expect to reposition when the price runs.

**What it does NOT do:** it does not add USDC, does not change the token supply, and does not cap how large a single buy can be — a 5 USDC buy exhausts even a ±50% range (it is 10x the pool's USDC reserve). It makes normal small trades sane; it does not make the pool deep in absolute terms.

**Execution (when the user approves):** burn position NFT 322143 (returns 10B MUSE + 0.5 USDC to the agent wallet), then mint a new position with the same tokens in the chosen range. Both steps go through the PositionManager via the Privy CLI. Gas ~0.02–0.03 USDC at current 25 gwei. Do NOT do this unprompted.

## 2. DO NOT SELL LOCKED MUSE FOR USDC TO DEEPEN THE POOL — strong warning

Releasing locked MUSE and selling it into this thin pool to "get USDC to deepen the pool" destroys the price. Constant-product math on the current reserves:

| Sell | USDC received | Price drop |
|---|---|---|
| 0.1B MUSE | 0.0050 USDC | −2.0% |
| 1B MUSE | 0.0455 USDC | −17.4% |
| 10B MUSE | 0.2500 USDC | −75.0% |
| 50B MUSE | 0.4167 USDC | −97.2% |

Selling 1B MUSE crashes the price 17% to gain just $0.045 of USDC. Selling 10B crashes it 75% for $0.25. The pool is too thin to absorb any meaningful MUSE sale. This is the worst way to get USDC. Do not do it.

## 3. BURN A PORTION OF THE LOCKED MUSE — supply story, not pool depth

Burning locked MUSE does NOT change the pool's reserves or price. It reduces max supply, which changes the FDV math at the current price:

| Burn | Max supply after | FDV at $5e-11 (was $5,000) |
|---|---|---|
| 50T | 50T | $2,500 |
| 90T | 10T | $500 |
| 99T | 1T | $50 |

This is a tokenomics/cleanliness move: it removes the overhang narrative ("99.99T locked in a deployer") and makes the supply credible. It does not deepen the pool by a single cent. If the user wants a cleaner supply story, burn a large portion (e.g., 90T, leaving 10T max) — but understand it is cosmetic to the pool, not a fix for it. It also permanently destroys that MUSE, so it cannot later be used for airdrops, incentives, or a multichain bridge reserve. Decide once.

## 4. AIRDROP / DISTRIBUTE SOME LOCKED MUSE — holders and demand, not pool depth

Releasing some locked MUSE to early supporters or holders creates holders and organic demand, which is good for the token's story and for TrustWallet/CoinGecko eligibility (holder count matters). It does NOT deepen the pool — the MUSE goes to wallets, not into the pool. It also increases circulating supply, which (at a fixed price) increases the circulating market cap. A small, targeted distribution (e.g., a few hundred million MUSE to early supporters) is a reasonable growth lever. A large distribution without demand behind it just creates sellers. Do this for distribution, not for pool balance.

## 5. RE-ADD COLLECTED HOOK FEES AS LIQUIDITY OVER TIME — slow compounding

As trading happens, the 3% hook fee accumulates in the agent wallet: MUSE on buys, USDC on sells. Once both sides are available, those fees can be re-added as liquidity — deepening the pool using only revenue, no new USDC. But it is slow: accumulating 0.5 USDC of sell-side fees needs ~$16.7 of sell volume (3% of volume). At $10/day of sell volume that takes ~1.7 days; at $1/day, ~17 days. And fees only arrive as USDC from sell volume (buys pay MUSE). This is a long-term compounding lever that only works once there is real trading volume. It is not an immediate fix, but it is the correct "no new USDC" way to grow the pool over time.

## 6. SINGLE-SIDED MUSE RANGE ABOVE THE CURRENT PRICE — sell-side depth only

Use some locked MUSE to add a position in a range ABOVE the current price, funded with MUSE only. When the price rises into that range, the MUSE sells for USDC. This adds depth/resistance above the current price (so a rally does not run away as fast) and puts the locked MUSE to productive use without selling it now. It does NOT deepen the pool AT the current price — a buyer at the current price sees no benefit. It is a secondary, optional lever, not a substitute for repositioning the main position. It also locks that MUSE into a range that may sit idle if the price never rises there.

## 7. KEEP THE FEE TIER (3000) — do not create a new pool

The pool uses fee 3000 (0.3% LP fee). Changing the fee tier requires creating a NEW pool (the fee is part of the pool key), which would fragment the already-thin liquidity across two pools. Do not do it. Keep the single pool and deepen it by repositioning.

## 8. USE UNISWAPX V3 FOR PROTECTED TRADES — execution, not depth

UniswapX V3 is live on Arc 5042 (verified in the Flashbots research). It offers MEV-protected execution, which matters for larger trades. But it has a per-chain minimum quotable size, and whether a 0.05 USDC trade qualifies is untested — test with a live `/quote` first. This improves how trades execute; it does not deepen the pool.

## Ranked recommendations

1. **Reposition the main position to a ±25% concentrated range** (9.5x deeper; 0.05 USDC buy 9.1% → 1.0% impact; 0.5 USDC buy 50% → 9.5%). Cost ~0.02–0.03 USDC gas, affordable. Risk: exits on a 25% rise / 20% fall; reposition again when it does. Do this first.
2. **Do NOT sell locked MUSE for USDC** — it crashes the price for pennies. (Anti-recommendation; the most important thing to avoid.)
3. **Burn a large portion of the locked MUSE (e.g., 90T)** for a cleaner supply story — optional, cosmetic to the pool, irreversible. Decide once.
4. **Airdrop a small, targeted amount of locked MUSE** to early supporters for holders/demand — optional, growth lever, not pool depth.
5. **Re-add hook fees as liquidity over time** — the slow, no-new-USDC way to grow the pool once trading starts. Needs ~$16.7 of sell volume per 0.5 USDC of fees.
6. **Single-sided MUSE range above the price** — optional sell-side depth; does not help buyers at the current price.
7. **Keep the 3000 fee tier; do not create a second pool.** Use UniswapX for protected execution of larger trades (test the minimum size first).

## What "balanced" means here

- **Deeper at the current price:** the ±25% repositioning (9.5x). This is the main fix.
- **Less volatile for normal trades:** same repositioning — small trades stop moving the price 9–50%.
- **Better distributed supply:** airdrop (holders) and/or burn (cleaner max supply). These fix the supply story, not the pool.
- **Growing depth over time without new capital:** re-adding hook fees as liquidity.
- **What none of these do:** they do not make the pool deep in absolute terms (it is still 0.5 USDC). Real depth only comes from more USDC entering the pool — from trading volume (fees), from new buyers, or from the user adding USDC later. Without any new USDC, the concentrated range is the best available lever.

## Risks and caveats

- Repositioning costs gas (~0.02–0.03 USDC at 25 gwei) and the range can exit quickly on a volatile new token, requiring repeated repositioning (more gas each time).
- The 5 USDC buy exhausts even a ±50% range — the pool cannot absorb a trade 10x its USDC reserve in any configuration without new capital.
- Burning is irreversible; selling locked MUSE is destructive (see section 2); airdropping without demand creates sellers.
- The 3% hook fee is proven on the fork only — no mainnet swap has run yet, so the fee revenue lever is unproven on mainnet.
- All models assume the current price ($5e-11) and reserves (10B MUSE + 0.5 USDC). If the price moves before repositioning, the range must be centred on the NEW price.
