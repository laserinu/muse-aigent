# $MUSE Relaunch — MAINNET Deployment Record

**Date:** 2026-11-07 ~00:07 GMT+7 (all txs confirmed)
**Chain:** Arc (5042). Agent wallet: 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4 (nonces 11–14 used).
**Status:** LAUNCHED AND VERIFIED on mainnet. Supersedes the old token 0xD7Fc2E1D5A65DDc834f0b62c50782E47c1fa79d4 (and the dead 0x9514DB43552F590Fb798CFAfdE1d796e00b59154).

## Contracts
| Item | Address |
|---|---|
| MuseDeployer (factory) | 0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0 |
| New $MUSE token | 0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198 |
| MuseFeeHook (3% buy/sell) | 0xD8791D64Be0ecca433BBe30c2A4Ff36D7Eca0044 |
| Hook CREATE2 salt | 0x0000000000000000000000000000000000000000000000000000000000000839 (= 2105) |
| PoolId | 0x5a14e63c9943a180d24b31f45964bc11e24639e9f055f88f33a3ac58b6b27ff1 |
| Position NFT tokenId | 322143 (owner = agent wallet) |
| Position liquidity | 2,236,067,997,499 |

## Transactions (all status 1)
| Step | Tx hash | Block | Gas used | Effective gas price |
|---|---|---|---|---|
| 1. Factory deploy (plain creation) | 0xff169f1c60bbc4e80341fc5977c51148a21306b8ac141ff5f6736b6904679b85 | 29870460 | 2,242,221 | 20.001 gwei |
| 2. Hook deploy (Arachnid CREATE2) | 0x39fc214edd5d98dec21f75611f45ff30895ce52281270b49ae141fa0525a1a48 | 29870617 | 661,322 | 20.001 gwei |
| 3. Approve USDC 500000 | 0xb1510b8b3ae05cfa1b73130276590e70fde185c117635c03cb2895779f32b4b2 | 29870671 | 55,438 | 20.00115 gwei |
| 4. launch() | 0x1040a88a88c9ee2954356ba840f37e6d334d8fc7072bc890aa35322af16bd095 | 29870713 | 1,157,256 | 20.00123625 gwei |

## Launch parameters (executed)
- Seed: 0.5 USDC (500,000 base units) + 10B MUSE (1e19 base units) → $5k FDV
- sqrtPriceX96: 354319114228591420592203432321452013 (token 0xd124… > USDC 0x3600…, so currency0 = USDC, currency1 = MUSE)
- Pool: fee 3000 (0.3% LP) + 3% hook fee, tickSpacing 60, full range [-887220, 887220]
- Token salt: keccak256("MUSE-RELAUNCH-1") = 0xf86a0e808971e6e73eb3e8f5ba4ebd859f0e31c4a7fdbd6ca54be7313553f06c

## Verified onchain (after launch)
- Token: name "Muse Ai Agent", symbol "MUSE", decimals 9, totalSupply 1e23 (100T)
- Factory MUSE balance: 99,990,000,000,000,035,316,29 base units ≈ 99.99T (3,531,629 base units over nominal — same rounding as the fork; the pool took 3,531,629 fewer MUSE than the 10B seed). LOCKED in the factory (owner-only release(), not called).
- Agent MUSE balance: 0
- Position NFT 322143 owner: agent wallet
- Pool slot0 (via extsload): sqrtPriceX96 = 354319114228591420592203432321452013 (exact match), tick 306282, protocolFee 0, lpFee 3000. (Note: `getSlot0` is NOT a PoolManager function in v4-core v4.0.0 — it lives in StateLibrary and reads via extsload; a direct getSlot0 call reverts. The poolId was also verified independently: keccak256(PoolKey) = hook.poolId() = 0x5a14e63c….)
- Agent USDC after: 123,572 base units = 0.123572 USDC (started 0.705902)

## Cost
- Total gas: 4,116,237 → 0.082330 USDC
- Seed: 0.5 USDC
- Total spent: 0.582330 USDC (balance change confirms: 0.705902 − 0.123572)
- Agent USDC remaining: 0.123572

## Notes / deviations
- No deviations from the plan. Every step verified before the next.
- Factory's Permit2 (read from PositionManager): 0x000000000022D473030F116dDEE9F6B43aC78BA3 (F6B, not canonical F7B) — confirmed on mainnet.
- No swaps were executed on mainnet. The 3% hook fee was proven on the fork only; the first real swap will be the live proof.
- No release() call was made. The locked 99.99T MUSE stays in the factory until the user decides.
- Tx JSONs: mainnet/01-factory-deploy.json, 02-hook-deploy.json, 03-approve-usdc.json, 04-launch.json. Hook-mining script: script/MineHookSalt.s.sol (token hardcoded to the mainnet token).
