# $MUSE Airdrop Plan — Active Arc DEX Traders (EOAs Only)

Prepared 2026-11-07. Analysis and planning only — **no tokens sent, no `release()` called, no contract deployed.**

## Token & pool (verified facts)

- Token: "Muse Ai Agent" ($MUSE), `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, Arc 5042, 9 decimals, 100T fixed supply.
- Price: **$5e-11 per MUSE** (1 USDC = 20B MUSE). Pool: Uniswap V4 MUSE/USDC, 10B MUSE + 0.5 USDC, $5k FDV, **very thin**.
- Deployer/factory `0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0` holds **~99.99T MUSE locked**. Agent wallet `0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4` is the owner and can call `release(to, amount)`. Agent wallet holds 0 MUSE + **0.12264 USDC**. Arc gas ~25 gwei.
- $MUSE has **2 holders**. The airdrop goal is holder-count growth and distribution (helps TrustWallet >2,500 eligibility and listings), **NOT** pool depth (airdropped MUSE goes to wallets, not the pool).

## Criteria as applied (user-approved; correct if wrong)

- **Chain:** Arc (5042) — recipients must be on Arc to hold/trade the Arc token.
- **Trading activity:** wallets that executed at least one DEX swap/trade on Arc (Uniswap V4, V3, Aerodrome, Archery, etc.). Source: GeckoTerminal trades for the top 40 Arc pools by 24h volume (the per-instance Blockscout API is Cloudflare-gated from this VM, and the main Arc RPC `rpc.mainnet.arc.io` returns **0 logs** for `eth_getLogs` — it is broken for log queries; the Blockdaemon RPC `https://rpc.blockdaemon.mainnet.arc.io` works for logs and `eth_getCode`).
- **Active only:** all recipients traded within the last ~24 hours (2026-11-05 22:02 UTC to 2026-11-06 21:43 UTC). The dataset covers recent activity; a full 90-day enumeration would require an indexer (Blockscout PRO API with a key). Recency is the strongest "active" signal, and these traders are by definition active now.
- **EOAs only:** every candidate was checked with `eth_getCode` — if code is non-empty it is a contract and was excluded. Only EOAs remain.

## Eligible count

- **1,850 eligible EOA traders** (from 11,545 trades across the top 40 Arc pools).
- 1,913 unique traders found; **63 were smart contracts and were excluded** (routers, bots, aggregator contracts).
- Total volume of the 1,850: **$1,036,451**. Median trader volume **$2.28**; median trade count **3**; max 602 trades (one wallet), top volume $83,883.
- Volume buckets: >=$1,000: 200 · $100–1,000: 314 · $10–100: 232 · $1–10: 504 · <$1: 600.
- Trade-count buckets: >=10 trades: 253 · >=5: 701 · >=20: 38.
- Last-trade date: 2026-11-06: 1,847 · 2026-11-05: 3. All within ~24h.
- Full list: `recipients.csv` (1,850 rows, sorted by volume desc) in this folder. Raw data: `traders-raw.json`, `traders-eoa.json`, `eoa-check.json`, `arc-pools.json`.

## Distribution — per-wallet amount options

Price $5e-11 per MUSE (20B MUSE = $1). All amounts are in MUSE (9 decimals).

### Option A — Flat, modest (simplest)
- **2B MUSE ($0.10) each × 1,850 = 3.7T MUSE (3.7% of locked supply). Total value $185.**
- Pros: simplest Merkle tree (one amount), easy to explain. Cons: rewards a $0.01 trader the same as an $83k whale.

### Option B — Flat, meaningful
- **10B MUSE ($0.50) each × 1,850 = 18.5T MUSE (18.5% of locked supply). Total value $925.**
- Pros: feels real to recipients. Cons: gives away nearly a fifth of the locked supply; much larger dump risk.

### Option C — Tiered by volume (RECOMMENDED)
| Tier (24h volume) | Wallets | MUSE each | USD each | Subtotal MUSE |
|---|---|---|---|---|
| >= $1,000 | 200 | 10B | $0.50 | 2.00T |
| $100–1,000 | 314 | 5B | $0.25 | 1.57T |
| $10–100 | 232 | 2B | $0.10 | 0.464T |
| $1–10 | 504 | 1B | $0.05 | 0.504T |
| < $1 | 600 | 0.5B | $0.025 | 0.30T |
| **Total** | **1,850** | — | — | **~4.84T MUSE (4.8% of locked), ~$242** |

Rewards the most active traders more, keeps the total modest (~4.8% of the locked supply), and gives every recipient a non-trivial amount.

## Distribution method — Merkle distributor (RECOMMENDED)

### Why NOT direct `release()` transfers
Direct transfers would need **1,850 separate `release()` transactions** from the agent wallet. Each costs ~65,000–100,000 gas at 25 gwei ≈ **0.0016–0.0025 USDC**, so 1,850 transfers cost **~3.0–4.6 USDC in gas**. The agent wallet holds only **0.12264 USDC** — direct distribution to all 1,850 is **not affordable** and is not recommended.

### Merkle distributor (recommended)
- Deploy **one** Merkle distributor contract (e.g., the standard Uniswap-style `MerkleDistributor`). Deploy cost ~1–1.5M gas ≈ **0.025–0.04 USDC**. Then **one** `release()` call funds it with the total airdrop amount (~0.002 USDC). Total agent cost **~0.03–0.04 USDC** — affordable within the 0.12264 USDC balance.
- Recipients **claim** their MUSE by calling the distributor and paying their **own** claim gas (~0.002 USDC each). A $0.10–$0.50 claim for $0.002 gas is a good deal for them, so claim rates should be decent.
- Set a **claim window (e.g., 90 days)** so claims (and any sells) are spread over time rather than all at once. Unclaimed MUSE after the window can be reclaimed by the owner.
- The Merkle root is computed from `recipients.csv` + the per-wallet amounts (Option C tiers). Deployment is a plain contract creation via the Privy CLI (proven to work), and funding is a single `release()`.

## Dump risk — the most important warning

**The pool is extremely thin (0.5 USDC). Any meaningful airdrop that recipients sell will crash the price.** Quantified on the current full-range pool (constant-product, 10B MUSE + 0.5 USDC):

- A **single** recipient selling a 2B MUSE airdrop moves the price down **~17%**.
- **10** recipients selling 2B each (20B total) crashes the price **~89%**.
- If **all 1,850** sold even a modest allocation, the pool's 0.5 USDC would be drained and the price would go to ~0.

This is not a reason to skip the airdrop — it is a reason to **mitigate it**:
1. **Reposition the pool to ±25% FIRST (before the airdrop).** A concentrated ±25% range is ~9.5x deeper at the current price (a 0.05 USDC buy drops from 9.1% → 1.0% impact). The same 9.5x applies to sells: a single 2B MUSE sale would move the price ~1.8% instead of ~17%. This is the single most effective mitigation and costs only ~0.02–0.03 USDC in gas. See `POOL-BALANCE-RECOMMENDATIONS.md`.
2. **Keep per-wallet amounts small** (Option A or C, not B) so each individual sale is small.
3. **Use the Merkle distributor with a long claim window (90 days)** so claims/sells are spread out, not simultaneous.
4. **Accept some price impact.** The airdrop's goal is holder count and distribution; a modest, spread-out price dip is the cost of growing holders. The 3% hook fee taxes sellers (3% per sell leg, paid to the agent wallet), which partially offsets it.
5. **Do NOT airdrop a large amount to a small group** — that concentrates sell pressure. The tiered Option C spreads it.

**Bottom line:** do the ±25% reposition first, then run the airdrop with Option C (tiered, ~4.84T MUSE) via a Merkle distributor with a 90-day claim window.

## Sybil / farming concerns

- The list is derived from **actual past DEX trades**, not self-reported claims — it cannot be gamed retroactively (the trades already happened). That is the strongest anti-farm property.
- **Bots are in the list.** The highest-volume addresses (top $83k, $82k, $71k) are likely MEV/bot/aggregator wallets, not humans. They are EOAs (not contracts) so they passed the filter, but they may not be the "community" the user wants. Consider excluding the top ~1% by volume (top ~19 wallets) or capping the top tier, and/or requiring a minimum trade count (e.g., >=2 trades) to filter one-off dust trades. 600 wallets have <$1 volume and 1 trade — some may be dust/sybil; the <$1 tier's small amount (0.5B MUSE) limits the value of farming it.
- The claim gas (~$0.002) is a natural sybil filter: claiming a $0.025 allocation costs $0.002 in gas, so low-value farming is barely profitable.
- **Do not publish the recipient list publicly before the claim opens** — that invites targeted farming/impersonation. Announce the airdrop and the claim link, not the raw list.

## Recommended approach (summary)

1. **Reposition the pool to ±25% first** (see `POOL-BALANCE-RECOMMENDATIONS.md`) — makes the pool ~9.5x deeper so it can absorb airdrop sells.
2. **Use Option C (tiered, ~4.84T MUSE, ~$242 total)** for the 1,850 eligible EOAs in `recipients.csv`.
3. **Distribute via a Merkle distributor** with a 90-day claim window. Agent cost ~0.03–0.04 USDC (deploy + one funding `release()`). Recipients pay their own claim gas.
4. **Do not publish the raw recipient list**; announce the claim.
5. **Monitor** Blockscout `/tokens/{address}/transfers` for the sandwich/dump fingerprint after the claim opens.

## Files

- `recipients.csv` — 1,850 eligible EOA traders, sorted by volume desc (address, trade_count, volume_usd, last_trade, first_trade, pool_count).
- `traders-raw.json` — all 1,913 traders before the EOA filter.
- `traders-eoa.json` — the 1,850 eligible EOAs with stats.
- `eoa-check.json` — the EOA/contract classification for all 1,913 addresses.
- `arc-pools.json` — the top 40 Arc pools by 24h volume (source for the trades).
- `AIRDROP-PLAN.md` — this file.
