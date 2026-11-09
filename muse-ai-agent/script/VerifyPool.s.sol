// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
contract VerifyPool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B;
    address constant MOCK_USDC = 0xD5941aedf552ab2B9Ff1bB20C1C4bd7813B561e0;
    address constant TOKEN = 0xE61e7626B64Bb6E4b37129852f199eD56db29372;
    address constant HOOK = 0x51c4FCC1db76c9a14c8496c798FC778a027E0044;
    address constant AGENT = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4;
    address constant FACTORY = 0x7cD275db55234479919Aa6097cf85ED51E8bEe24;
    function run() external view {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(MOCK_USDC),
            currency1: Currency.wrap(TOKEN),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) =
            IPoolManager(POOL_MANAGER).getSlot0(poolId);
        console.log("poolId:");
        console.logBytes32(PoolId.unwrap(poolId));
        console.log("sqrtPriceX96:", sqrtPriceX96);
        console.log("tick:", tick);
        console.log("lpFee:", lpFee);
        console.log("position liquidity:", IPositionManager(POSITION_MANAGER).getPositionLiquidity(322135));
        console.log("factory MUSE:", IERC20(TOKEN).balanceOf(FACTORY));
        console.log("agent MUSE:", IERC20(TOKEN).balanceOf(AGENT));
        console.log("agent mockUSDC:", IERC20(MOCK_USDC).balanceOf(AGENT));
        console.log("agent native USDC (gas token):", AGENT.balance);
    }
}
