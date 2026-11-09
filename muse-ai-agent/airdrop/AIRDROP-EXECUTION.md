# $MUSE Airdrop — Direct Push Execution

**Date:** 2026-11-07 ~05:20–05:30 WIB
**Status: COMPLETE — all 1,850 eligible wallets received their MUSE, verified onchain (0 mismatches).**

## Summary

Direct (push, no claim) distribution of **4.838T MUSE (~$241.90 at $5e-11)** to **1,850 active Arc DEX traders** (EOAs only, contracts excluded), tiered by 24h trading volume. Executed via a minimal `Disperse` contract (loop of `transfer` calls), funded once from the deployer's locked supply via `release()`.

## Recipients and amounts (Option C, tiered)

| Tier (24h volume) | Per wallet | Wallets | Subtotal |
|---|---|---|---|
| ≥ $1,000 | 10B MUSE | 200 | 2.000T |
| $100–1,000 | 5B MUSE | 314 | 1.570T |
| $10–100 | 2B MUSE | 232 | 0.464T |
| $1–10 | 1B MUSE | 504 | 0.504T |
| < $1 | 0.5B MUSE | 600 | 0.300T |
| **Total** | | **1,850** | **4.838T** |

Recipient list: `recipients.csv` (1,850 unique EOAs, sorted by volume desc). Full plan: `AIRDROP-PLAN.md`.

## Contracts

- **Disperse contract:** `0x02C5521E5f8d8e141d214e6300736DB7f440C607` (src/Disperse.sol, minimal loop of `IERC20.transfer`, no claim step, no owner, no fee)
- Token: $MUSE `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, Arc 5042
- Deployer (source of funds): `0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0` (holds ~99.99T locked; released 4.838T for this airdrop)

## Transactions (Arc 5042, agent wallet 0x0A1D… via Privy CLI)

| Step | Action | Hash | Block | Gas |
|---|---|---|---|---|
| 0 | Deploy Disperse | `0xeb13b9542f54066da24bd2f25a6652b4a36e874410cb18902469cb2f28fc8ba6` | 29907609 | 209,354 |
| 1 | Fund: `release()` deployer → Disperse (4.838T MUSE) | `0xda06b9abcb093c3fcb1f92409324a07a476014d042525cc51c9767620c37815d` | 29907654 | 58,631 |
| 2 | Chunk 1 — 200 wallets (recips 1–200), 2.000T | `0x826c2ee96d0c713db3a6d2bcad1b0a1c014c0a2a008523fb9addde66f2bf5410` | 29908045 | 5,335,480 |
| 3 | Chunk 2 — 200 wallets (recips 201–400), 1.000T | `0x42dbdfd52240cacbc808b2d6aa4832be4e7be3f01569165887c0a70fb619d66e` | 29908070 | 5,335,420 |
| 4 | Chunk 3 — 200 wallets (recips 401–600), 0.742T | `0xb6163ba3acb9e84d087385024ecb2d183cb0670601bdc14a2acb3dd73c03e217` | 29908099 | 5,335,504 |
| 5 | Chunk 4 — 200 wallets (recips 601–800), 0.346T | `0x083d568c4a0dc3aa8990ff16d152324fea5cbd892c07e7bf27041908071b0c78` | 29908123 | 5,335,468 |
| 6 | Chunk 5 — 200 wallets (recips 801–1000), 0.200T | `0xfff9e630e39978404a2d05b626925b857dc21d197b272c6ffa5b84742a365207` | 29908144 | 5,335,444 |
| 7 | Chunk 6 — 200 wallets (recips 1001–1200), 0.200T | `0x7233b1b31b2dcffdb061bcf6641b786e9b383f89827dc2fb847f56475c3d9d84` | 29908167 | 5,335,420 |
| 8 | Chunk 7 — 200 wallets (recips 1201–1400), 0.125T | `0x2721d7f512073a23c886d4295b4acb9fdd4afd31023fd0ce5b981445643dfc8d` | 29908196 | 5,335,420 |
| 9 | Chunk 8 — 200 wallets (recips 1401–1600), 0.100T | `0xf4f2a07f5816ae70a2976b5df479e114b84833ffccc002a0a5906c0e019fb054` | 29908227 | 5,335,420 |
| 10 | Chunk 9 — 200 wallets (recips 1601–1800), 0.100T | `0x207ce238c68971010284d85f075d82cde673e255d74c0e160d91cbaabf60fc6d` | 29908254 | 5,335,360 |
| 11 | Chunk 10 — 50 wallets (recips 1801–1850), 0.025T | `0xcfbf2ed83c42bb030a59fd0a62eae0932110eea3245bc031cae18e0825f533de` | 29908274 | 1,351,662 |

**Total gas: 49,638,583** (deploy 209,354 + release 58,631 + 10 chunks 49,370,598).
**Total USDC spent on gas: 1.284419 USDC** (agent USDC 1.439483 → 0.155064). Higher than the 1.0160 USDC estimate because effective gas prices ran ~23–26 gwei (not exactly the 20 gwei baseFee) and the run used 10 chunks instead of 2 (see the chunk-size finding below).

## Verification (all onchain)

- **Full balance check:** all 1,850 recipient balances read onchain and compared to the expected tiered amounts — **1,850 correct, 0 mismatches**. Total distributed exactly **4,838,000,000,000,000,000,000 base units (4.838T MUSE)**.
- **Disperse contract balance after: 0** — fully distributed, no dust left in the distributor.
- **Spot-checks during the run:** first/last recipient of every chunk verified at the exact tiered amount (10B/5B/2B/1B/0.5B), including tier boundaries (recip 600 = 2B, recip 800 = 1B, recip 1400 = 0.5B). Disperse balance decreased by exactly each chunk's total after every chunk.
- **Agent wallet after:** USDC **0.155064**, MUSE **145,054,684.84** (unchanged leftover from the repositioning mint).
- **Deployer after:** ~95.152T MUSE still locked (99.99T − 4.838T).

## Execution notes and findings

1. **Deploy JSON bug (caught before any funds moved):** the first deploy attempt failed with "Invalid params" because the node script prepended `0x` to `bytecode.object`, which already carries a `0x` prefix, producing `0x0x6080…`. Fixed by using the artifact bytecode as-is. No funds were at risk.
2. **Chunk-size finding (new):** the original plan used 2 chunks of 925, but the 925-recipient call reverted at gas estimation. Measured on the Arc RPC: n=500 estimates fine (13.4M gas), n=600 works (16.07M), n=650 reverts — the estimator/broadcast path caps out around ~16–17M gas, well below the 30M block limit. The run therefore used **10 chunks of 200 (max) + 50**. A 600-recipient chunk estimates fine, so future disperses can use up to ~600/chunk, but 200 proved the most reliable for broadcast.
3. **Broadcast quirk:** two 600-recipient attempts returned "Transaction submission state is unclear" with a hash, but neither hash exists onchain and the agent nonce stayed at 24 — both were failed broadcasts, not landed txs. Verified by nonce + tx lookup before retrying; nothing was double-paid. The 200-recipient chunks all broadcast cleanly on the first try.
4. **Session held:** the Privy session survived the whole run (deploy + release + 10 chunks, ~10 min). No re-login was needed mid-run.
5. **Pool context:** the pool had just been repositioned to ±25% (NFT 322298, 9.4497x deeper) before this airdrop, so a single 2B MUSE sale now moves the price ~1.8% (was ~17%). Recipients selling remains the main post-airdrop price risk — watch the pool and the token transfers.

## Files

- Recipient list: `recipients.csv` (do NOT publish raw)
- Plan: `AIRDROP-PLAN.md` · Low-gas analysis: `LOW-GAS-DISPERSE.md`
- Execution calldata: `airdrop/exec/` (deploy + release + 10 chunk JSONs, `chunk-manifest.json`)
- Disperse source: `src/Disperse.sol`
