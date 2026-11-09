// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {MuseDeployer} from "../src/MuseDeployer.sol";
import {MuseFeeHook} from "../src/MuseFeeHook.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fork-test deployment script (anvil fork of Arc). Uses a MockUSDC
/// because Arc's real USDC moves balances through system precompiles
/// (0x1800...0000/0001) that anvil cannot emulate. Everything else (pool,
/// hook, factory, token) is the real code. On mainnet, pass the real USDC
/// (0x3600...) as the factory's usdc and the hook's usdc.
/// Run with: forge script script/DeployLaunch.s.sol --fork-url http://localhost:8545
///   --sender <agent> --unlocked --broadcast
contract DeployLaunch is Script {
    address constant AGENT = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSITION_MANAGER = 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B;
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // Final launch parameters (user-chosen): 0.5 USDC + 10B MUSE, $5k FDV.
    uint256 constant MUSE_AMOUNT = 10_000_000_000 * 1e9; // 10B MUSE, 9 dec = 1e19
    uint256 constant USDC_AMOUNT = 500_000; // 0.5 USDC, 6 dec
    int24 constant TICK_LOWER = -887220; // full range, tickSpacing 60
    int24 constant TICK_UPPER = 887220;

    function run() external {
        vm.startBroadcast(AGENT);

        // 0. Deploy mock USDC (mints 1M to the agent in its constructor).
        MockUSDC usdc = new MockUSDC();
        console.log("mockUSDC:", address(usdc));

        // 1. Deploy the factory.
        MuseDeployer factory = new MuseDeployer(
            IPoolManager(POOL_MANAGER), IPositionManager(POSITION_MANAGER), AGENT, address(usdc)
        );
        console.log("factory:", address(factory));

        // 2. Predict the token address (view, not broadcast).
        address token = factory.predictTokenAddress();
        console.log("token:", token);

        // 3. Compute the starting sqrtPriceX96 from the seed ratio, using
        // the actual currency ordering (token vs mock USDC).
        // price = amount1 / amount0 (base units); sqrtPriceX96 = sqrt(price) * 2^96.
        uint160 sqrtPriceX96;
        if (token < address(usdc)) {
            // currency0 = MUSE, currency1 = USDC; price = usdc / muse.
            sqrtPriceX96 = _sqrtPriceX96(USDC_AMOUNT, MUSE_AMOUNT);
        } else {
            // currency0 = USDC, currency1 = MUSE; price = muse / usdc.
            sqrtPriceX96 = _sqrtPriceX96(MUSE_AMOUNT, USDC_AMOUNT);
        }
        console.log("sqrtPriceX96:", sqrtPriceX96);

        // 4. Mine the hook salt for deployer = Arachnid, flags 0x44.
        bytes memory creationCode = type(MuseFeeHook).creationCode;
        bytes memory constructorArgs = abi.encode(
            IPoolManager(POOL_MANAGER), token, address(usdc), uint24(3000), int24(60)
        );
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        (address hookAddr, bytes32 salt) = HookMiner.find(ARACHNID, flags, creationCode, constructorArgs);
        console.log("hook:", hookAddr);
        console.logBytes32(salt);
        require(uint160(hookAddr) & 0x3fff == 0x44, "hook flags not 0x44");

        // 5. Deploy the hook via the Arachnid factory (raw salt ++ initCode).
        // The Arachnid factory returns the raw 20-byte address (not ABI-encoded).
        bytes memory initCode = abi.encodePacked(creationCode, constructorArgs);
        (bool ok, bytes memory ret) = ARACHNID.call(abi.encodePacked(salt, initCode));
        require(ok, "arachnid deploy failed");
        require(ret.length == 20, "bad arachnid return");
        address deployedHook = address(bytes20(ret));
        console.log("deployed hook:", deployedHook);
        require(deployedHook == hookAddr, "hook addr mismatch");

        // 6. Approve the factory to pull the USDC seed.
        IERC20(address(usdc)).approve(address(factory), USDC_AMOUNT);

        // 7. Launch: token + pool + liquidity, leftover MUSE locked in factory.
        (uint256 positionTokenId, ) = factory.launch(
            hookAddr, MUSE_AMOUNT, USDC_AMOUNT, sqrtPriceX96, TICK_LOWER, TICK_UPPER
        );
        console.log("positionTokenId:", positionTokenId);

        vm.stopBroadcast();
    }

    /// @notice sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96.
    function _sqrtPriceX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        uint256 v = (amount1 * (1 << 192)) / amount0;
        return uint160(_isqrt(v));
    }

    function _isqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
