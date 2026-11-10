# Archive: old sniper build versions (2026-11-09)

Moved here 2026-11-09 ~14:22 GMT+7 on the user's order: "Archive all the old build versions. Use all the new ones" (for the sniper).

Everything in this dir is MOVED, not deleted — it is preserved for reference and can be restored. Nothing here is imported or read by the live watchers.

## What was moved and why

- `sniper-v2-build.zip` — the original v2 build snapshot from 2026-11-07. The live v2 has since gained Parts 45/48/49/50/51/53/55 (memory loop, GoPlus, holders, registries, token-age + min-500 gates, recheck fix, smart-money signal) plus the min-500 → 250 loosening (2026-11-09). Superseded.
- `STATE.json.pre-fresh-reset-20261108` — v2 state backup from before the 2026-11-08 fresh-start counter reset. Superseded by live `v2/STATE.json`.
- `config.json.bak-pre-expansion`, `config.json.bak-pre-v2-switch` — old config backups. Superseded by live `v2/config.json`.
- `v3-trade.js` — DEAD Universal Router V3 builders (buildV3Buy/buildV3Sell). The Robinhood-fork UR command 0x00 is dead for EOAs; the live V3 path is `v2/v3-helper-trade.js` via V3SwapHelper. Only ever imported by the three microtest scripts below. Must NOT be used.
- `v3-microtest.js`, `v3-microtest-diag.js`, `v3-microtest-retry.js` — pre-live V3 micro-test scripts (they imported the dead v3-trade.js). The helper micro-test PASSED 2026-11-08 and v3 is live; these are dev scaffolding.
- `v3-buy-sim.js` — pre-live V3 buy-path proof (dry-run eth_call sim). Superseded by the live helper path.
- `v3-run.js` — V3 DRY-RUN watcher (writes only v3-STATE-DRYRUN.json + v3-DRYRUN-LOG.md). Superseded by the live `v2/v3-live-run.js`.
- `v3-STATE-DRYRUN.json`, `v3-DRYRUN-LOG.md`, `v3-MICROTEST-20261108-0305-diag.json` — dry-run state/logs from the v3 pre-live testing.

## What stays live (do NOT move these)

- v2 watcher: `v2/run.js` (cron `sniper-v2-watcher-arc-base`, every 2 min)
- v3 watcher: `v2/v3-live-run.js` (cron `sniper-v3-watcher-robinhood`, every 2 min)
- Evaluators: `v2/evaluate.js`, `v2/v3.js`; execution: `v2/trade.js`, `v2/v3-helper-trade.js`
- State: `v2/STATE.json`, `v2/v3-STATE.json`, `v2/memory.sqlite`, `v2/smart-money-watchlist.json`
- Tests (`*-test.js`, `*-replay.js`) and one-off sell scripts (`sell-ant-now.js`, `sell-fobo-*.js`, `convert-weth-proceeds-usdg.js`) stay with the live code — they are the current test suite and evidence, not old builds.
- v1 is archived separately at `archive/robinhood-v1-20261108/` (retired 2026-11-08).

## Verification (2026-11-09, after the move)

Live entry points intact and loading: run.js, v3-live-run.js, evaluate.js, v3.js, trade.js all pass `node --check`. The copy-trader build (in progress, subagent) writes new files into v2/ and reads only the live modules above.
