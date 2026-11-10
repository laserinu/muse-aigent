# Why "No quote available" for $MUSE swaps — diagnosis

**Date:** 2026-11-07 ~05:47 GMT+7
**Token:** $MUSE `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`, Arc (5042), 9 decimals
**Pool:** Uniswap V4 MUSE/USDC, PoolId `0x5a14e63c9943a180d24b31f45964bc11e24639e9f055f88f33a3ac58b6b27ff1`,
fee 3000, tickSpacing 60, concentrated range [304080, 308520], liquidity 21,130,171,658,904
**Hook:** `0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044` — 3% fee on buy and sell via
`afterSwap` (positive `hookDeltaUnspecified` + `poolManager.take` to the agent wallet)
**Price:** $5e-11 per MUSE (1 USDC = 20B MUSE). Reserves 10B MUSE + 0.5 USDC. **Zero trades ever.**

## Symptom

The user tried to buy ~0.059 USDC of $MUSE on Bitget Wallet and got
"No quote available. Please try again later." (Trade button disabled).
Same failure when selling $MUSE. The user then confirmed the SAME failure on
**web3.okx.com (OKX Wallet web) and MetaMask Swap**, and then that it happens on
**ALL platforms and ALL native wallet apps**. The chart also shows
"Unable to get data. Pull down to reload."

So this is **not** a Bitget-specific issue. No wallet aggregator can currently
quote this pool.

## Root cause — ranked

### 1. (PRIMARY) The custom 3% afterSwap hook reverts the official V4Quoter

**This is the deterministic cause. It fails regardless of indexing, volume, or TVL.**

- The canonical Uniswap V4Quoter on Arc (`0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94`,
  confirmed by Faze docs, Dedaub monitoring, o1 Exchange, TSUKIPAD) was called
  directly onchain for this pool (`quoteExactInputSingle`, correct PoolKey
  USDC/MUSE, fee 3000, tickSpacing 60, hook `0xD879…`).
- **All four quotes reverted with a bare revert (no data, no reason string):**
  buy 0.05 USDC, buy 0.059064 USDC (the user's amount), sell 2B MUSE, sell 0.5B MUSE.
  Verified twice: once via viem `client.call`, once via a raw JSON-RPC `eth_call`
  (error code 3, `"execution reverted"`, no `data` field). The quoter has code
  (6,118 bytes); the PoolManager and the hook also have code. The pool itself is
  live and at the seed price (tick 306282, sqrtPriceX96 unchanged, block 29910572).
- This is a **known phenomenon**, not a bug in our pool: a documented Uniswap V4
  skill states verbatim — *"Some hooks revert the official Quoter even though
  real swaps work"* and *"Aggregators (LI.FI included) often cannot route V4
  pools, especially hooked ones — so a token can be genuinely liquid and still
  return [no quote]."* The same source notes the workaround is to "quote by
  simulation" (simulate the actual swap) rather than using the quoter.
- **Why it matters:** every wallet swap aggregator (Bitget, OKX, MetaMask) and
  every routing API obtains a quote by simulating the swap through a quoter.
  When the quoter reverts, the aggregator has no price and returns "no quote" /
  "route not found" / an error. The hook is the thing that makes the quoter
  revert. (The fork test proved real swaps through the Universal Router DO work
  with this hook — the hook breaks *quoting*, not *execution*.)
- **Corroborating evidence that hookless V4 pools on Arc ARE quotable:**
  the Ophis Arc route-verification doc records a KyberSwap API quote for
  1,000 USDC → EURC split between Uniswap V3 and **hookless Uniswap V4**
  (61.0833%). So the quoter/aggregator infrastructure on Arc works for
  hookless V4 pools — it is our *hooked* pool that fails.

### 2. (SECONDARY / contributing) The pool is brand new, tiny, and has zero volume

- Created 2026-11-07 ~00:12 GMT+7 (~5.5 hours before the report). TVL $0.50.
  **Zero trades, zero volume ever.** No price history exists.
- Aggregators that rely on an off-chain token/pool index (rather than reading
  the PoolManager directly) may not have indexed this pool yet, or may filter
  out pools below a TVL/volume threshold. This alone would cause "no route"
  on index-based aggregators.
- But this is **secondary**: even if the pool were indexed, the quoter revert
  (cause 1) would still make every quoter-based aggregator fail. Indexing
  alone does not explain the V4Quoter revert or the Uniswap Routing API 500.

### 3. (NOT a cause) Chain support, pool existence, or thinness alone

- **Arc IS supported** by Bitget's aggregator (Bitget Wallet Developer Docs,
  Chain & API Support Matrix: Arc 5042, Instruction Mode ✅, Order Mode ✅,
  same-chain swap ✅, cross-chain ✅). Bitget integrated Arc at mainnet launch.
- The pool **exists and is live** (verified onchain: sqrtPriceX96 and tick
  identical to launch, liquidity 21,130,171,658,904, NFT 322298).
- Thinness alone does not cause "no quote": a 0.059 USDC buy is ~12% of the
  0.5 USDC reserve, but quoters return a (bad) price for thin pools, not "no
  quote". The quoter revert is the cause, not the size.

## Evidence table — every quoter tested fails

| Quoter / aggregator | Test | Result |
|---|---|---|
| V4Quoter on Arc (direct, onchain) | `quoteExactInputSingle` buy 0.05, buy 0.059064, sell 2B, sell 0.5B | **Reverts, no data** (all four) |
| Bitget Wallet swap | User buy ~0.059 USDC, and sell | "No quote available" |
| OKX Wallet web (web3.okx.com) | User buy/sell | "No quote available" |
| MetaMask Swap | User buy/sell | "No quote available" |
| KyberSwap Aggregator API (Arc) | `GET /arc/api/v1/routes` USDC→MUSE 0.05; MUSE→USDC 2B | `{"code":4008,"message":"route not found"}` (both) |
| Uniswap Routing API (api.uniswap.org/v2/quote) | POST buy 0.05 USDC; sell 2B MUSE, protocols V4 | **HTTP 500 "Internal server error"** (both) |
| AchSwap (Arc-native aggregator) | Quote API endpoints probed | Inconclusive (one endpoint closed the connection, one returned 401 "Missing or invalid quote token" — wrong endpoint/auth). AchSwap docs say it covers "V4 pools with hooks", but its V4 adapter warns "a hook that changes the amount being swapped makes the step revert, because exact input is enforced." Not confirmed as a working route. |

Note: the Uniswap Routing API 500 (not a clean "no route") is consistent with
its quoter simulation reverting on this pool.

## The chart "Unable to get data" — same root cause (mostly)

The chart provider has **no price history** for this pool because the pool has
**zero trades ever**. There is nothing to chart. This is the same underlying
fact (a brand-new pool with no volume) as cause 2, not a separate wallet bug.
Once the first swap executes onchain, chart/indexing providers will have a
first trade to display. (The "no quote" itself, though, is cause 1 — the hook
reverting the quoter — not the lack of chart data.)

## Note on the screenshot balance

The screenshot shows a USDC balance of **0.155064**, which matches the agent
wallet's post-airdrop Arc USDC balance exactly (1.439483 − 1.284419 airdrop gas
= 0.155064). This may be a coincidence, or the user may be viewing the agent
wallet as a watch-only address in Bitget Wallet. The agent wallet's private key
is held by Privy and **cannot** be imported into Bitget Wallet, so the user
cannot sign a swap from the agent wallet inside Bitget Wallet. This diagnosis
does not assume the user imported the agent wallet; the "no quote" failure is
independent of which wallet is selected (the pool is unquotable for any wallet).

## Expected outputs (verified V4 math, net of the 3% hook fee)

These are the outputs a direct swap would produce (gross output from the
repositioning verification, net = 97% after the 3% hook fee). Use these as the
`amountOutMinimum` basis (minus slippage) for a direct router call.

| Trade | Gross output (before hook) | Net output (after 3% hook) |
|---|---|---|
| Buy 0.05 USDC → MUSE | 989,528,467 MUSE (1.05% impact) | **~959,842,613 MUSE** |
| Buy 0.059064 USDC → MUSE (user's amount) | ~1,160,000,000 MUSE (est.) | **~1,125,000,000 MUSE (est.)** |
| Buy 0.5 USDC → MUSE | 9,043,034,732 MUSE (9.57% impact) | **~8,771,743,590 MUSE** |
| Sell 2B MUSE → USDC | ~0.099 USDC gross (price moves ~1.8%) | **~0.096 USDC (est.)** |

(Net = gross × 0.97. The 0.3% LP fee is already in the gross figure. Sell figures
are estimates from the modelled ~1.8% price impact; the exact output should be
computed from the pool state at execution time.)

## WORKING ROUTE — direct Universal Router interaction (bypass the quoter)

**No wallet aggregator and no quoter-based UI can currently quote this pool.
The working route is a direct Uniswap V4 swap through the Universal Router
that does NOT call the quoter.** Real swaps through this route are proven to
work with this hook (fork test: buy and sell both paid exactly 3.000%).

### Why this works when aggregators fail

The Universal Router `execute` does not need a quoter. It executes the swap
onchain against the PoolManager. The caller supplies `amountOutMinimum`
(computed from the pool state / the table above, minus slippage) instead of
asking a quoter for the expected output. The hook runs during the swap and
takes its 3% — exactly as in the fork test.

### Route (agent wallet — Muse can execute this)

1. **Compute the expected output** from the pool state (table above; or read
   the current sqrtPriceX96/tick/liquidity from the PoolManager and apply
   the V4 exact-input math, then × 0.97 for the hook). Set
   `amountOutMinimum` = expected net output minus slippage (use 2% slippage
   for this thin pool, as the documented hook workaround recommends widening
   slippage when the quoter reverts).
2. **Approve** the input token to Permit2 (if not already approved), then
   `permit2.approve` the Universal Router — the same two-layer approval
   pattern used in the relaunch.
3. **Call Universal Router `execute`** (`0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`
   on Arc) with command `V4_SWAP (0x10)`, payload
   `abi.encode(actions, params)` where
   `actions = [SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)]`,
   the PoolKey (USDC/MUSE, fee 3000, tickSpacing 60, hook `0xD879…`),
   `zeroForOne` = true for a buy (USDC→MUSE) / false for a sell (MUSE→USDC),
   `amountIn`, `amountOutMinimum`, and `hookData = 0x`.
   Send via the Privy CLI (`eth_sendTransaction`, caip2 `eip155:5042`).
   **Do NOT execute this unprompted** — it is a real swap; run it only when
   the user asks for a specific buy/sell.
4. **Verify** the receipt and the received amount onchain.

### Route (user's own wallet in Bitget/OKX/MetaMask)

There is **no existing wallet-aggregator UI that can do this today** — that is
the finding. The user's options are:

- **(Recommended) Let Muse execute the first swap for the agent wallet**
  (route above) as a live proof. This creates the pool's first trade and
  first volume. It proves the pool is swappable end-to-end on mainnet and
  gives chart/indexing providers their first data point. It does not by
  itself fix aggregator quoting (the hook will still revert the quoter),
  but it is the necessary first step and the only route that works right now.
- **A direct-interaction UI:** Muse can build a minimal swap page that
  connects the user's wallet (WalletConnect / injected provider) and calls
  the Universal Router directly with a manually computed `amountOutMinimum`
  (bypassing the quoter). This is a real fix for the user's own wallet, but
  it needs to be built — it is not available in any existing wallet app today.
- **Wait for indexing / aggregator support:** not recommended as the primary
  plan. Even once the pool is indexed and has volume, the quoter revert
  (cause 1) will still block quoter-based aggregators unless the quoter or
  the aggregator adds hook-aware simulation. Do not expect Bitget/OKX/MetaMask
  to start quoting this pool on their own.

### What would fix aggregator quoting permanently

- A quoter/aggregator that simulates the swap (eth_call the Universal Router
  `execute`) instead of calling the V4Quoter, or a V4Quoter version that
  handles this hook's `afterSwap` + `take` pattern. This is an upstream
  (Uniswap/aggregator) fix, not something the token can change — the hook is
  immutable and is the intended 3% fee mechanism. Alternatively, a future
  pool without a fee-taking hook would quote normally (but $MUSE's 3% hook
  is the design).

## Bottom line

- **Most likely cause:** the custom 3% afterSwap hook reverts the official
  V4Quoter, so every quoter-based aggregator (Bitget, OKX, MetaMask,
  KyberSwap, Uniswap Routing API) returns no quote. This is a known V4
  phenomenon ("some hooks revert the official Quoter even though real swaps
  work"). The pool being brand new with $0.50 TVL and zero trades is a
  secondary/contributing factor (no index, no chart data), not the main cause.
- **The pool IS swappable** — real swaps through the Universal Router are
  proven (fork test, exactly 3.000% fee). It is quotable-by-quoter that is
  broken, not execution.
- **Working route:** a direct Universal Router `V4_SWAP` with a manually
  computed `amountOutMinimum` (bypassing the quoter). Muse can execute this
  for the agent wallet on request. No existing wallet app can do it today;
  a direct-interaction UI would need to be built for the user's own wallet.
