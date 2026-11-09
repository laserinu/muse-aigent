# Low-Gas Direct Disperse for the $MUSE Airdrop — Analysis

**Date:** 2026-11-07
**Question:** can the airdrop be pushed DIRECTLY to all 1,850 eligible wallets (no claim step) with VERY LOW gas?
**Answer: no — not at Arc's gas price and the wallet's balance. The floor is ~1.02 USDC, and the wallet holds 0.12264 USDC.**

## 0. Inputs (verified)

- Token: $MUSE `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, Arc 5042, 9 decimals, standard OpenZeppelin ERC20 v5.7.0, immutable (no owner controls, not upgradeable).
- Recipients: 1,850 EOAs in `recipients.csv` (active Arc DEX traders, last ~24h, contracts excluded).
- Amounts (Option C, tiered): 200×10B, 314×5B, 232×2B, 504×1B, 600×0.5B = **4,838B MUSE (~$241.90)**.
- Agent wallet: `0x0A1D…` holds **0.12264 USDC** (= 6,132,000 gas at 20 gwei).
- Arc gas: **baseFee is EXACTLY 20 gwei** — verified over the last 1,000 blocks (`eth_feeHistory`, single unique value `20000000000`). It does not move. `eth_gasPrice` = 20.00115 gwei (baseFee + dust tip). **There is no cheaper gas to wait for.**
- Arc block gas limit: **30,000,000**.

## 1. Measured gas (Foundry simulation, real token + real addresses/amounts)

A minimal `Disperse` contract (`src/Disperse.sol`: loop of `IERC20(token).transfer(to, amount)`) was tested against the real `MuseAiAgent` contract with the exact 1,850 addresses and tiered amounts from `recipients.csv` (`test/DisperseGas.t.sol`).

| Test | Gas (execution only) | Per recipient |
|---|---|---|
| 1 transfer to a fresh address | 56,681 | — |
| 50 recipients | 1,371,892 | 27,438 |
| 100 recipients | 2,706,316 | 27,063 |
| 200 recipients | 5,375,522 | 26,878 |
| 500 recipients | 13,386,128 | 26,772 |
| 1,000 recipients | 26,741,512 | 26,742 |
| **1,850 recipients** | **49,474,239** | **26,743** |

Notes on measurement:
- The first (naive) full-1,850 run read 57,178,234 gas — that included ~7.7M gas of cold `SLOAD`s from the test harness reading storage arrays. A real transaction passes the arrays as **calldata**, so the sliced run (49,474,239) is the correct execution figure; the per-recipient cost is flat at ~26,743 from 500 up, confirming it.
- Execution-only figures exclude the 21,000 base tx cost and calldata. Calldata was computed exactly from the real addresses/amounts: **989,560 gas for 1,850** (~535/recipient; addresses are ~20 non-zero bytes each).

Cost split per recipient (26,743 gas execution + ~535 calldata):
- **Recipient balance SSTORE (zero → non-zero): 20,000 gas = 75%** — dominates everything.
- Transfer event (LOG3): ~1,756 gas = ~7%.
- Sender balance update + SLOADs + loop/call overhead: ~4,450 gas = ~17%.
- Calldata: ~535 gas = ~2%.

Other measured costs:
- Deploy `Disperse`: **241,602 gas (0.00483 USDC)**.
- One funding transfer (`release()`-equivalent, deployer → disperse): **52,043 gas (0.00104 USDC)**.
- Deploy `MerkleDistributor` (for comparison): **392,666 gas (0.00785 USDC)**.

## 2. The floor — why direct push cannot be "very low" gas

For a standard ERC-20, every new holder's balance is a separate storage slot. Writing a zero slot to non-zero costs **20,000 gas by protocol**, and it cannot be avoided, batched away, or optimised around:

- 1,850 × 20,000 = **37,000,000 gas = 0.7400 USDC** — balance writes alone.
- + Transfer events 1,850 × 1,756 = 3,248,600 gas = 0.0650 USDC.
- + Calldata 989,560 gas = 0.0198 USDC.
- **Hard floor ≈ 0.825 USDC** before sender-balance updates, loop overhead, and dispatch — realistic total ≈ **1.02 USDC** (measured above).

Things that do NOT help:
- **Assembly-optimised disperse:** saves ~100–200 gas/recipient on loop overhead (~1%). The SSTORE is 75% of the cost and untouched.
- **Helper contract calling `release()` in a loop:** strictly MORE expensive — adds one external CALL plus deployer logic per recipient on top of the identical transfer cost.
- **`transferFrom` with allowance:** same transfer cost PLUS an allowance SSTORE. Worse.
- **Waiting for cheaper gas:** Arc's baseFee is fixed at exactly 20 gwei (verified over 1,000 blocks). It does not drop.
- **Assigning balances without individual SSTOREs:** impossible for this token. It is a standard ERC-20, deployed and immutable; each holder needs their own balance slot for the tokens to be real, spendable, and visible in wallets/explorers.

## 3. Option (a) — Batched multisend to all 1,850, no claim

- Execution 49,474,239 + calldata 989,560 + 2× base tx 21,000 = **50,505,799 gas**.
- **Block gas limit 30M forces ≥2 chunks** (max ~1,080 recipients per chunk at a 29.5M cap). Chunking does not change the total — same execution + calldata, plus one extra 21,000 base.
- \+ Deploy disperse 241,602 + funding release() 52,043.
- **Grand total: 50,799,444 gas = 1.0160 USDC at 20 gwei.**
- Per recipient all-in: **0.000549 USDC**.
- Wallet has 0.12264 USDC → **shortfall 0.8933 USDC**.
- For comparison: 1,850 separate `release()` txs ≈ 135M gas ≈ **2.70 USDC** (batching saves ~62%, but the storage writes remain). Merkle claim-only agent cost = 0.0089 USDC (recipients pay their own claim gas).

## 4. Option (b) — Reduced recipient count, within the 0.12264 USDC budget

Budget = 6,132,000 gas. All figures include deploy + funding + one chunk tx.

| Recipients (top by volume) | Total gas | USDC | Fits? |
|---|---|---|---|
| 50 | 1,714,681 | 0.0343 | yes |
| 100 | 3,076,293 | 0.0615 | yes |
| 150 | 4,408,567 | 0.0882 | yes |
| 200 | 5,799,815 | 0.1160 | yes |
| **213 (max affordable)** | **6,127,612** | **0.1226** | **yes — exactly at budget** |
| 500 | 13,973,357 | 0.2795 | no |

**Max affordable direct push: the top 213 wallets by volume.** That covers the ≥$1,000 tier (200) plus 13 of the $100–1,000 tier. Note: spending the whole budget on the airdrop leaves ~0 USDC for the pool repositioning (~0.02–0.03 USDC) — do not max it out if the repositioning is also planned.

## 5. Option (c) — Hybrid: batched direct push to the top tier + Merkle claim for the rest

Claim part (fixed): Merkle deploy 392,666 + funding transfer 52,043 = 444,709 gas = **0.0089 USDC** (agent cost; each recipient pays ~60–80k gas ≈ 0.0012–0.0016 USDC to claim).

| Top-N direct | Direct cost | + claim part | Total | Fits 0.12264? |
|---|---|---|---|---|
| 100 | 0.0615 | 0.0089 | **0.0704 USDC** | yes (leaves 0.0522) |
| 150 | 0.0882 | 0.0089 | **0.0971 USDC** | yes (leaves 0.0256) |
| 200 | 0.1160 | 0.0089 | **0.1249 USDC** | **no — over by 0.0023** |

Top-150 direct + claim for the remaining 1,700 is the largest hybrid that fits, and it leaves enough for the pool repositioning.

## 6. Option (d) — Fund the wallet with ~1 USDC of gas

The cleanest way to get **all 1,850, direct, no claim**: top the agent wallet up with **~0.90 USDC** (1.00 USDC to be safe). Then the full batched push costs 1.0160 USDC, leaving ~0.107 USDC — enough for the pool repositioning too. The top-up is a one-time gas payment; the 4,838B MUSE itself comes from the deployer's locked supply at no extra cost.

## 7. Recommendation

**"All 1,850 + no claim + very low gas" is mutually impossible.** The protocol floor for giving 1,850 fresh wallets a real ERC-20 balance is ~0.83 USDC (realistically ~1.02 USDC), Arc gas is fixed at 20 gwei, and the wallet holds 0.12264 USDC. Something has to give:

1. **Best if the user will fund ~1 USDC of gas:** do the full batched direct push to all 1,850 (Option a, 2 chunks, 1.0160 USDC). No claim, everyone just receives it.
2. **Best within the current balance:** hybrid (Option c) — batched direct push to the **top 150** by volume (0.0882 USDC) + Merkle claim for the remaining 1,700 (0.0089 USDC) = **0.0971 USDC total**, leaving ~0.0256 USDC. The most active traders get a surprise push; everyone else claims.
3. **If the user insists on direct-only with no top-up:** cap at the **top 213** wallets (0.1226 USDC) — but that spends the entire balance and leaves nothing for the pool repositioning, so top 200 (0.1160 USDC) is the practical cap.

Whichever path is chosen, **reposition the pool to ±25% first** (see `POOL-BALANCE-RECOMMENDATIONS.md`): the dump-risk analysis stands — one 2B MUSE sale moves the price ~17% on the current full-range pool vs ~1.8% after repositioning.

## 8. Files and reproducibility

- `src/Disperse.sol` — minimal disperse contract (analysis artifact, not deployed).
- `src/MerkleDistributor.sol` — minimal claim distributor used only to measure deploy gas (not deployed).
- `test/DisperseGas.t.sol` — Foundry gas measurement with the exact 1,850 addresses/amounts from `recipients.csv`.
- `test/MerkleGas.t.sol` — Merkle deploy + funding gas measurement.
- Run: `export PATH="$HOME/.foundry/bin:$PATH" && forge test --match-contract "DisperseGasTest|MerkleGasTest" -vv`.
