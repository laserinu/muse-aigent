# $MUSE Relaunch — Fork-Test Report

**Date:** 2026-11-06 (fork test completed ~23:50 GMT+7)
**Chain:** Arc (5042), anvil fork of `https://rpc.mainnet.arc.io`
**Status:** ALL TESTS PASSED on the fork. Nothing deployed to mainnet.

## Final launch parameters (user-chosen)
- Seed: **0.5 USDC + 10,000,000,000 MUSE (10B)**
  - USDC: 500,000 base units (6 dec)
  - MUSE: 1e19 base units (9 dec)
- Starting price: $5e-11 per MUSE → implied FDV **$5,000** (100T total supply)
- Pool fee: 3000 (0.3% LP fee) + 3% hook fee to the agent wallet
- Tick spacing: 60; position range: full range [-887220, 887220]
- Leftover: **~99.99T MUSE stays LOCKED in the MuseDeployer** (owner-only `release()`, owner = agent wallet). Position NFT goes to the agent wallet.

## Contracts (in `~/workspace/tokens/muse-ai-agent/src/`)
- `MuseAiAgent.sol` — unchanged (OZ ERC20 v5.7.0, 100T, 9 dec, mints to deployer)
- `MuseFeeHook.sol` — afterSwap-only, 3% (300 bps) of every swap's output to the agent wallet (0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4). Flags AFTER_SWAP (0x40) + AFTER_SWAP_RETURNS_DELTA (0x04) = 0x44. PoolId-gated (reverts `WrongPool()` on any other pool). No owner, no setters. Emits `FeeTaken(recipient, currency, fee)`.
- `MuseDeployer.sol` — own deployer factory. `launch(hook, museAmount, usdcAmount, sqrtPriceX96, tickLower, tickUpper)` deploys the token (CREATE2, fixed salt), pulls the USDC seed, initialises the V4 pool, mints the position (NFT to agent), locks the leftover MUSE. `release(to, amount)` owner-only. USDC address is a constructor arg (mainnet: real USDC 0x3600...). Permit2 address is read from the PositionManager in the constructor (see the Permit2 finding below).
- `MockUSDC.sol` — test-only mock (6 dec) used on the fork only. See "Fork limitations".
- `test/SwapHelper.sol` — test-only swap helper (unlock + settle/take).

## Fork-test results (anvil fork, block ~29,868,481)
| Item | Value |
|---|---|
| MockUSDC (fork only) | 0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0 |
| Factory (MuseDeployer) | 0x7cD275db55234479919Aa6097cf85ED51E8bEe24 |
| Token (new $MUSE) | 0xE61e7626B64Bb6E4b37129852f199eD56db29372 |
| Hook (MuseFeeHook) | 0x51c4FCC1db76c9a14c8496c798FC778a027E0044 (low 14 bits = 0x0044) |
| Hook CREATE2 salt | 0x0000000000000000000000000000000000000000000000000000000000001d32 (= 7474) |
| PoolId | 0x7c39ac45416cf973537ad132107385fd58913e0afb3f6418d166fa2d779e7c33 |
| Position NFT tokenId | 322135, owner = agent wallet 0x0A1D… |
| Position liquidity | 2,236,067,997,499 |
| sqrtPriceX96 (launch) | 354319114228591420592203432321452013 |
| sqrtPriceX96 (after swaps) | 339858965185922031172234091551323323 (tick 305449) |
| Token name / symbol / decimals / totalSupply | "Muse Ai Agent" / "MUSE" / 9 / 1e23 (100T) |
| Factory MUSE after launch | 99,990,000,000,000,035,316,29 base units ≈ 99.99T (see rounding note) |
| Agent MUSE after launch | 0 |
| Agent native USDC after all fork txs | 0.6298 USDC (started 0.7059; total gas ≈ 0.0761 USDC) |

### Buy test (0.05 USDC → MUSE, exact input)
- Paid: 50,000 mock USDC. Gross MUSE output: 906,610,893,880,120,103.
- Fee (hook, to agent): **27,198,326,816,403,603 MUSE** = exactly `floor(gross × 300 / 10000)` = 3.000% of gross.
- Trader (agent) net received: 879,412,567,063,716,500 MUSE (97%).
- FeeTaken event emitted with the exact fee. ✓

### Sell test (500M MUSE → USDC, exact input)
- Paid: 500,000,000,000,000,000 MUSE (500M). Gross USDC output: 28,576.
- Fee (hook, to agent): **857 USDC** = exactly `floor(gross × 300 / 10000)` = 3.000% of gross.
- Trader (agent) net received: 27,719 USDC (97%).
- FeeTaken event emitted with the exact fee. ✓

### Wrong-pool test
- `afterSwap` with a different pool key (fee 10000 instead of 3000) reverts `WrongPool()`. ✓

### release() test
- Owner released 1 MUSE (1e9 base units) to the agent: factory decreased by exactly 1e9, agent increased by exactly 1e9. ✓
- Non-owner `release()` reverts `OnlyOwner`. ✓
- (The 1 MUSE released in the test is why the factory now holds 99,989,999,999,999,003,531,629 instead of the launch-time 99,990,000,000,000,035,316,29.)

### Rounding note
The factory holds 99,990,000,000,000,035,316,29 base units after launch, i.e. 3,531,629 base units (0.0035 MUSE) MORE than the nominal 99.99T. That is because `LiquidityAmounts.getLiquidityForAmounts` rounds the position down very slightly, so the pool took 3,531,629 fewer MUSE base units than the 10B seed. Negligible (3.5e-12 relative). The pool was seeded with 500,000 USDC and (10B − 0.0035) MUSE.

## Gas used (fork, representative for mainnet)
| Step | Gas |
|---|---|
| Factory deploy (plain creation) | 2,242,449 |
| Hook deploy (CREATE2 via Arachnid) | 661,550 |
| USDC approve (0.5 USDC to factory) | 46,335 |
| launch() | 1,147,717 |
| **Mainnet total (excl. mock USDC)** | **4,098,051** |
| MockUSDC deploy (fork only) | 574,778 |
| SwapHelper deploy (test only) | 709,340 |
| BUY swap | 145,606 |
| SELL swap | 128,639 |

At Arc's ~20 gwei base fee, the mainnet total is ≈ 0.082 USDC gas + 0.5 USDC seed = **≈ 0.582 USDC**. The agent holds 0.7059 USDC → fits with ~0.124 USDC spare.

## sqrtPriceX96 formula (for the parent / mainnet)
`sqrtPriceX96 = isqrt(price × 2^192)` where `price = amount1 / amount0` in base units
(amount1 = the currency1 amount, amount0 = the currency0 amount; currencies are sorted by address).
- If the token address **> USDC** (currency0 = USDC, currency1 = MUSE): price = 1e19 / 500000 = 2e13 → **sqrtPriceX96 = 354319114228591420592203432321452013**
- If the token address **< USDC** (currency0 = MUSE, currency1 = USDC): price = 500000 / 1e19 = 5e-14 → **sqrtPriceX96 = 17715955711429571029610**
- The parent MUST check the ordering at mainnet deploy time (the token address is not known until the factory is deployed) and use the matching value. The fork used the first case (token 0xE61e… > mock USDC 0xD594…).

## Critical findings (for mainnet)
1. **Arc's Permit2 is NOT at the canonical address.** The canonical `0x000000000022D473030F116dDEE9F7B43aC78BA3` has NO code on Arc. The PositionManager on Arc uses `0x000000000022D473030F116dDEE9F6B43aC78BA3` (note `F6B`, not `F7B`; 9,152 bytes of code). The factory now reads the Permit2 address from the PositionManager (`positionManager.permit2()`) instead of hardcoding the canonical address. **Do NOT use the canonical Permit2 address on Arc.**
2. **Arc's USDC precompiles break anvil forks.** Real USDC (0x3600...) moves balances through system precompiles at 0x1800...0000 (transfer) and 0x1800...0001 (isBlocklisted), which have code `0xef` on real Arc and cannot be emulated by anvil. On the fork, `transferFrom` reverts with `OpcodeNotFound`. The fork test therefore used a MockUSDC. **Mainnet is unaffected** (the precompiles exist on real Arc — the Relay bridges already proved USDC transferFrom works there). The factory takes the USDC address as a constructor arg; pass the real USDC (0x3600...) on mainnet.
3. **The Arachnid factory returns a raw 20-byte address**, not an ABI-encoded 32-byte address. Decode with `address(bytes20(ret))`, not `abi.decode(ret, (address))`.
4. **The hook salt is NOT fixed.** It depends on the hook's init code, which includes the token address, which depends on the factory address, which depends on the agent's nonce. The fork salt (0x1d32) will NOT work on mainnet. Mine it fresh at mainnet deploy time (after the factory is deployed and the token address is known) using `HookMiner.find` (forge script `script/DeployLaunch.s.sol` does this).
5. **Arc EVM / PUSH0:** all contracts compile with `evm_version = "paris"` (solc 0.8.24, optimizer 200). The hook/factory/token init code starts with `PUSH1 0x00` (no PUSH0). The anvil fork was run with `--hardfork cancun` (needed because of the USDC precompile issue above), so the fork does NOT re-verify the PUSH0 behaviour — that is verified at compile time (paris) and by the earlier $MUSE deploy on real Arc.
6. **Permit2 approvals need BOTH layers:** the factory ERC20-approves Permit2 AND calls `permit2.approve(token, positionManager, amount, type(uint48).max)`. Both are required for the PositionManager's SETTLE_PAIR to pull the seed.
7. **`IPoolManager.settle()` takes no arguments** in v4-core v4.0.0 (it settles the caller's whole open delta after `sync` + transfer). The SwapHelper uses that pattern.

## Mainnet deployment steps (for the parent to execute)
Prereq: Privy CLI session logged in (re-login with the device-code flow if the VM was replaced — `list-wallets` says "Not logged in"). Agent wallet must hold ≥ ~0.6 USDC (has 0.7059) plus the 0.5 USDC seed is part of that (total ≈ 0.582 USDC needed).
1. **Deploy the factory** (plain creation, from the agent wallet via Privy CLI `eth_sendTransaction`, no `to`). Constructor args: `poolManager = 0x8366a39CC670B4001A1121B8F6A443A643e40951`, `positionManager = 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B`, `owner = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4`, `usdc = 0x3600000000000000000000000000000000000000` (real USDC). Record the factory address.
2. **Predict the token address**: call `factory.predictTokenAddress()` (view) — or CREATE2(factory, salt 0xf86a0e808971e6e73eb3e8f5ba4ebd859f0e31c4a7fdbd6ca54be7313553f06c, token init-code hash). Token salt = `keccak256("MUSE-RELAUNCH-1")` = `0xf86a0e808971e6e73eb3e8f5ba4ebd859f0e31c4a7fdbd6ca54be7313553f06c`.
3. **Mine the hook salt**: run the forge script (or a HookMiner call) with deployer = Arachnid `0x4e59b44847b379578588920cA78FbF26c0B4956C`, flags `0x44`, creationCode = `type(MuseFeeHook).creationCode`, constructorArgs = `abi.encode(poolManager, token, realUSDC, 3000, 60)`. Record `(hookAddress, salt)`. Verify `hookAddress & 0x3fff == 0x44`.
4. **Deploy the hook** via the Arachnid factory: Privy CLI `eth_sendTransaction` to `0x4e59b44847b379578588920cA78FbF26c0B4956C` with `data` = `salt (32 bytes) ++ initCode` (creation code + constructor args), `value` 0. Verify the deployed address equals the mined `hookAddress`.
5. **Approve the factory** for the USDC seed: Privy CLI `eth_sendTransaction` to real USDC, `approve(factory, 500000)`.
6. **Call launch()**: Privy CLI `eth_sendTransaction` to the factory, calldata = `launch(hook, 10000000000000000000, 500000, sqrtPriceX96, -887220, 887220)` (selector `0x3fe9ef83`; use the sqrtPriceX96 matching the token/USDC ordering — see the formula section). Verify the receipt status is 1, then verify: token name/symbol/decimals/totalSupply, factory MUSE ≈ 99.99T, agent MUSE = 0, position NFT owner = agent, pool `getSlot0` returns the set price.
7. **Update records**: new token address (supersedes 0xD7Fc… and the dead 0x9514…), new pool, the $MUSE website, portfolio.md, MEMORY.md, tools-and-sites.md part 16.

## Files
- `src/MuseFeeHook.sol`, `src/MuseDeployer.sol`, `src/MuseAiAgent.sol`, `src/MockUSDC.sol` (test-only)
- `test/SwapHelper.sol` (test-only)
- `script/DeployLaunch.s.sol` (deploy + mine + launch), `script/TestSwaps.s.sol` (buy/sell + wrong-pool), `script/VerifyPool.s.sol` (read pool state)
- `broadcast/DeployLaunch.s.sol/5042/run-latest.json`, `broadcast/TestSwaps.s.sol/5042/run-latest.json` (fork tx receipts)
- Dependencies (pinned, shallow clones in `lib/`): v4-core@v4.0.0, v4-periphery@main (commit c6e4754), permit2@main, forge-std@main. Note: v4-periphery main is newer than v4-core v4.0.0 but the interfaces/libraries used here compile and work against core v4.0.0. `BaseHook` does not exist in this periphery version — the hook implements `IHooks` directly. `IHooks` in core v4.0.0 has no `getHookPermissions`; permissions come from the address flags only.
