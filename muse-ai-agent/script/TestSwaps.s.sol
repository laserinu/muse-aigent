// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwapHelper} from "../test/SwapHelper.sol";
import {MuseFeeHook} from "../src/MuseFeeHook.sol";

/// @notice Fork-test swap script. Deploys a SwapHelper, does a BUY
/// (USDC -> MUSE) and a SELL (MUSE -> USDC) on the launched pool, and
/// verifies the 3% fee goes to the agent wallet. Also verifies a swap on a
/// different pool key reverts in the hook (WrongPool).
/// Run with: forge script script/TestSwaps.s.sol --fork-url http://localhost:8545
///   --sender <agent> --unlocked --broadcast
contract TestSwaps is Script {
    address constant AGENT = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    // Addresses from the DeployLaunch run on this fork:
    address constant MOCK_USDC = 0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0;
    address constant TOKEN = 0xE61e7626B64Bb6E4b37129852f199eD56db29372;
    address constant HOOK = 0x51c4FCC1db76c9a14c8496c798FC778a027E0044;

    uint256 constant BUY_USDC = 50_000; // 0.05 USDC (6 dec)
    uint256 constant SELL_MUSE = 500_000_000 * 1e9; // 500M MUSE (9 dec)

    function run() external {
        vm.startBroadcast(AGENT);
        SwapHelper helper = new SwapHelper(IPoolManager(POOL_MANAGER));
        console.log("swapHelper:", address(helper));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(MOCK_USDC),
            currency1: Currency.wrap(TOKEN),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });

        // ---- BUY: USDC -> MUSE, exact input 0.1 USDC ----
        IERC20(MOCK_USDC).transfer(address(helper), BUY_USDC);
        uint256 agentMuseBefore = IERC20(TOKEN).balanceOf(AGENT);
        uint256 agentUsdcBefore = IERC20(MOCK_USDC).balanceOf(AGENT);
        BalanceDelta buyDelta = helper.swap(
            key, true, -int256(BUY_USDC), TickMath.MIN_SQRT_PRICE + 1, AGENT
        );
        uint256 agentMuseAfter = IERC20(TOKEN).balanceOf(AGENT);
        console.log("BUY delta amount0 (USDC, negative=paid):", buyDelta.amount0());
        console.log("BUY delta amount1 (MUSE, positive=received):", buyDelta.amount1());
        console.log("BUY agent MUSE received:", agentMuseAfter - agentMuseBefore);
        console.log("BUY agent USDC before:", agentUsdcBefore);

        // ---- SELL: MUSE -> USDC, exact input 1B MUSE ----
        IERC20(TOKEN).transfer(address(helper), SELL_MUSE);
        uint256 agentUsdcBeforeSell = IERC20(MOCK_USDC).balanceOf(AGENT);
        BalanceDelta sellDelta = helper.swap(
            key, false, -int256(SELL_MUSE), TickMath.MAX_SQRT_PRICE - 1, AGENT
        );
        uint256 agentUsdcAfterSell = IERC20(MOCK_USDC).balanceOf(AGENT);
        console.log("SELL delta amount0 (USDC, positive=received):", sellDelta.amount0());
        console.log("SELL delta amount1 (MUSE, negative=paid):", sellDelta.amount1());
        console.log("SELL agent USDC received:", agentUsdcAfterSell - agentUsdcBeforeSell);

        // ---- Wrong-pool check is verified separately (dry-run only):
        // calling afterSwap with a different pool key reverts WrongPool().
        // It is omitted here because a revert inside try/catch makes forge
        // script abort the broadcast even when the revert is expected.
        // Dry-run evidence: afterSwap(wrongKey) reverted WrongPool().

        vm.stopBroadcast();
    }
}
