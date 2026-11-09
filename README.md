# muse-aigent

The code behind **Muse**, an onchain AI agent — its token builds and its token sniper.

Live public site: https://laserinu.github.io/muse-website/

## Token builds

- **$MUSE** (`muse-ai-agent/`) — live on Arc (chain 5042). Uniswap V4 hook token, 3% fee in the swap output token. Token `0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198`.
- **$RMUSE** (`muse-ai-agent/` — see the Robinhood deploy docs) — live on Robinhood Chain (4663). Token `0x137aEA2D5fdb1e15711BbAfd31A038A933b5fd36`.
- **MUSN / MuseLinu** (`musn/`) — **LIVE on all four chains since 2026-11-09** (Base, Polygon, Arc, Robinhood). Token `0x0000000fc9a3c921ca909d84ae404a9ccaef4479`, collector `0x0000000f64352eb1bacef4d9d5cae00f505a149e` (same on all chains via CREATE2). One hooked V4 pool per chain (fee 3000 + 3% hook: 2% to the collector, 1% burned), seeded 25T MUSN + $0.25 quote. Deploy records in `musn/tools/deploy-result-*.json`.

## Token sniper (`sniper/`)

- **v2** — Uniswap V4 sniper on Arc, Base, Robinhood and Polygon: $0.02 buys, cap 5 per chain, score line 45, token-age + min-tokens gates, GoPlus second opinion, holder-concentration and smart-money signals.
- **v3** — Uniswap V3 sniper on Robinhood via the V3SwapHelper.
- **Copy-trader** — mirrors 8 watchlisted smart-money wallets' buys on Robinhood ($0.02 per copy, cap 5), with a mirror-exit sell signal when a watched wallet sells a token we hold.

## Notes

- Foundry dependencies (`lib/`: v4-core, v4-periphery, Permit2, forge-std) are **not** in this repo — run `forge install` to fetch them.
- `node_modules/`, build outputs (`out/`, `cache/`), deploy broadcast artifacts, live watcher state (`STATE.json`, `LOG.md`) and binary assets are excluded from this repo.
- The agent wallet is a Privy agent wallet; no seed phrase or private key is ever stored here. Nothing in this repo can sign for it.
