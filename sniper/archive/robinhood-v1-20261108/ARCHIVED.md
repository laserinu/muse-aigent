# v1 Robinhood Sniper — ARCHIVED

**Retired by user order 2026-11-08 ~09:08 WIB ("Stop and archive v1").**

- Watcher cron `robinhood-token-sniper-watcher` DISABLED (was every 2 min). No more v1 scans, buys, or position management.
- Code + STATE.json + LOG.md preserved here exactly as they were at retirement. Do not delete.
- v2's memory loop still reads this STATE.json (path updated in `v2/memory-followup.js` + `v2/memory-backfill.js`) so deployer outcomes for v1-bought tokens keep resolving.
- To revive v1 one day: move this directory back to `~/workspace/tokens/sniper/robinhood/` and re-enable the cron. Do NOT do that without an explicit user go-ahead.

## Open positions at retirement (5, all bought 2026-11-08 08:57–09:00 WIB, 0.00001 ETH each)

| Token | Amount | Buy tx |
|---|---|---|
| perp (0x2a8427838d06792ac02a43161b3038c26ca00087) | 16,246.9 | 0x9d9060994b47698f158b33c06b57cd875d40e6f220c24641a44846a51e164809 |
| debtdog (0x114b335faa3343ff0faf9d69d45261f48f26d3e4) | 968.0 | 0xb1e22fdd68d3e4294b920cc50d284506e8780f6fca84bf618722a49bb527e591 |
| Quesadilla (0x4ca5214e469e55886a82943ef00e349251e80087) | 16,251.6 | 0xf55b3c680c1b1c3c3472fee791098fbd8d08389bbc2c52a6503cfcde479121e5 |
| BAMBI (0x64d62a8d2dacebc82f20e193913328d8c63c0087) | 16,251.6 | 0x3ea9e6d2ea6a665ddbf160014180d0afd346240b2f10fd0bed728e595a55e819 |
| eve (0xc5076830f12eaa0b2b52922899828ff4ec070087) | 16,251.6 | 0x1f9b04c8e14461ae9b03f202b9aac8877b28e496d214d9204f13981dd97773a2 |

These are UNMANAGED now — the v1 sell rules (50% at +100%, all at −50%) no longer run. Sell them with `sell-all.js --live` from this directory if the user orders it, or leave them held.

## History (10 earlier positions, all sold)

- First 5 (Alon, GHOST, KYLIE, BAG, MAGATARD) — sold 2026-11-08 ~02:26 WIB, recovered 0.000048594 WETH.
- Second 5 (bottom, GOOGLECAT, Firstkille, SKIMS, Canary) — sold in the cleanup 2026-11-08 ~07:53 WIB, WETH +0.0000485.

## Why retired

v1 does not carry the Part 51 gates (token-age <24h, min-500 tokens) — those are v2/v3 only. Minutes after the fresh-start re-enable it filled all 5 slots with a batch deploy (4 of 5 share the unidentified hook 0x2c668601…). v2 + v3 remain live.
