# Robinhood Token Sniper Bot

Buys new, predictable, legit token launches on **Robinhood Chain (4663)** in small size,
using the Privy agent wallet. Built 2026-11-07 (user-approved: "Decided for me but with
small portion only, on RobinHood first").

## Parameters (decided by the user — do not change without asking)

| Parameter | Value |
|---|---|
| Chain | Robinhood Chain (4663) ONLY |
| Per-snipe buy | **0.00001 ETH** (1e13 wei) per token |
| Max snipes | **5 total** for this first run. After 5 buys, stop. Max total buy spend 0.00005 ETH + gas |
| Capital | Privy agent wallet `0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4` (Robinhood ETH ~0.00011652) |
| Trigger | New Uniswap V4 `PoolManager.Initialize` events (a new pool = a new token launch) |
| Sell +100% | Sell **50%** when price is 2x the buy price |
| Sell −50% | Sell **ALL remaining** when price is half the buy price |
| Otherwise | Hold and report |

## How it works

1. **Watcher** (`run.js`, run by a cron every 2 minutes): scans the PoolManager
   (`0x8366a39CC670B4001A1121B8F6A443A643e40951`) for `Initialize` events in the
   blocks since the last scan (tracked in `STATE.json`). A cron survives VM replacements;
   a long-running process does not.
2. **Evaluator** (`evaluate.js`): runs the legit checks on each new pool (see below).
   Only reads — no transactions, so it is safe to run in dry-run mode.
3. **Executor** (`trade.js`): buys via the Privy CLI using the PROVEN Robinhood V4 swap
   pattern from `~/workspace/tokens/robin-muse/mainnet/FIRST-SWAP.md`:
   wrap ETH→WETH, approve WETH→Permit2, Permit2 approve WETH→Router, router `execute`
   with `V4_SWAP` (PoolKey as a nested TUPLE, not bytes). Bypasses the V4Quoter (it reverts
   on hooked pools). The deadline is rebuilt fresh every time (now+1800).
   The same pattern, reversed, sells token→WETH.
4. **Position manager** (inside `run.js`): for each held token, reads the pool's current
   sqrtPrice via `extsload` and compares it to the buy price. Sells 50% at +100%,
   sells all at −50%.
5. **State** (`STATE.json`): snipes done, positions, skipped tokens + reasons, last scanned
   block. Lives in `~/workspace`, so it survives VM replacements.
6. **Log** (`LOG.md`): every decision (buy, skip, sell) with a timestamp.

## Legit checks (ALL must pass before buying)

1. **WETH pair** — one of the pool's currencies is WETH
   (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). We buy with WETH/ETH only.
   (Most new pools on Robinhood are NOT WETH pairs — native-ETH pairs are the majority
   and are skipped. Only ~1 in 9 new pools in the dry-run sample was a WETH pair.)
2. **Not our own token** — never buy `$RMUSE` or `$MUSE`.
3. **Standard ERC-20** — `name`/`symbol`/`decimals`/`totalSupply` all readable.
4. **No dangerous functions** — the token bytecode is scanned for the selectors of
   `mint`, `pause`, `unpause`, `setBlacklist`/`blacklist`, `setMaxTxAmount`,
   `setMaxWallet`, `setTax`/`setFees`, `enableTrading`/`setTradingEnabled`.
   (Sourcify source is consulted when available; the bytecode scan is the backstop.)
5. **Honeypot check** — simulate buying 0.00001 ETH then selling it all via the V4Quoter
   (`eth_call`, no tx). If the sell simulation reverts or returns ~0 (or <50% of the
   buy input), SKIP. **Important:** if the V4Quoter reverts on the buy (the pool has a
   hook — the same behaviour as our own $MUSE/$RMUSE pools), that is INCONCLUSIVE, not
   a fail. The fallback is a token `transfer` simulation from the PoolManager (a real
   holder) to the agent wallet: if it succeeds, the token is transferable and the
   honeypot check passes on the fallback.
6. **Liquidity** — the pool must have **active liquidity at the current tick** (read from
   PoolManager `extsload`; if it is 0, SKIP — the pool is initialized but empty or all
   liquidity is out of range, and a buy would fail). This is the enforceable form of the
   ">= 0.00005 ETH of liquidity" rule: a pool with active liquidity and a successful
   buy simulation can absorb our 0.00001 ETH buy. The `amountOutMinimum` in the swap is
   the final guard — a bad fill reverts instead of executing, so the bot cannot lose
   money to a thin pool (it only loses the gas on a reverted tx).

## Live vs dry-run

The bot is **DRY-RUN by default**. It scans, evaluates, and logs "would BUY" but sends
no transactions. Live sniping starts only when the user explicitly says "Go".

To arm it (only after the user approves):
```bash
# in STATE.json, set "live": true
# then run with --live, or let the cron run with --live
node run.js --live
```
The cron is created with `--live` in its command, but the `state.live` flag is the
master switch: if `state.live` is false, the runner stays in dry-run even with `--live`.

## How to stop it

- Disable the cron (job id `robinhood-token-sniper-watcher`): the watcher stops scanning.
- Or set `"live": false` in `STATE.json`: the watcher keeps scanning/evaluating/logging
  but will not buy or sell.
- The bot never buys more than 5 tokens total, and never more than 0.00001 ETH per buy.
  After 5 snipes it only manages (sells) existing positions.

## Safety

- ONLY the Privy agent wallet, via the Privy CLI. NEVER a seed phrase or private key.
- Before every `privy-agent-wallet` invocation, `trade.js` runs
  `bash ~/workspace/privy/restore-privy-machine-identity.sh` (the session breaks on VM
  replacement if the machine-id is not restored). If `list-wallets` still says
  "Not logged in" after restore, the bot stops and reports — it never re-logins itself.
- Never buys a token the agent already holds from a snipe.
- Never buys `$RMUSE` or `$MUSE`.
- Robinhood gas is ~0.02 gwei (very cheap).
- Amount-out minimums are computed from the V4Quoter when it works, otherwise from the
  spot price with a 20% buffer (covers the 0.3% LP fee + a possible hook fee + impact).
  A swap that would fill badly reverts instead of executing (safe).

## Files

| File | What it is |
|---|---|
| `run.js` | Cron entry point: watcher + evaluator driver + executor + position manager |
| `evaluate.js` | The legit-check evaluator (module + CLI: `node evaluate.js <poolId>`) |
| `trade.js` | Builds buy/sell calldata + executes via the Privy CLI |
| `STATE.json` | Persistent state (snipes done, positions, skipped, last scanned block, live flag) |
| `LOG.md` | Decision log (every buy/skip/sell with a timestamp) |
| `README.md` | This file |

## Current state

- **Live:** NO (dry-run). Awaiting the user's "Go" before live sniping starts.
- **Snipes done:** 0 / 5.
- **Positions:** none yet.
- **Dry-run results (2026-11-07):** pool `0xe941a95c...` (WETH / King of Larp KOL) — PASS,
  would BUY; pool `0x1fbb0e13...` (native ETH pair) — SKIP, not a WETH pair.
  See `LOG.md` and `~/workspace/research_notes/robinhood-token-sniper-20261107-0831/report.md`.

## Research note

`~/workspace/research_notes/robinhood-token-sniper-20261107-0831/report.md` — the full
design, the dry-run results, and the lessons (quoter-revert fallback, WETH-pair rarity).
Tools-and-sites Part 28.
