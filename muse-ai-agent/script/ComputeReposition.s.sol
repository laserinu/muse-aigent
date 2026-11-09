// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @notice Computes the exact repositioning numbers for the $MUSE pool.
/// Read-only: no broadcast, no transaction. Run:
///   forge script script/ComputeReposition.s.sol -vv
contract ComputeReposition is Script {
    uint160 constant SQRT_PRICE_X96 = 354319114228591420592203432321452013;
    int24 constant TICK_LOWER = 304080;
    int24 constant TICK_UPPER = 308520;
    uint256 constant USDC_AMOUNT = 500000; // 0.5 USDC, 6 dec
    uint256 constant MUSE_AMOUNT = 10_000_000_000 * 1e9; // 10B MUSE, 9 dec

    function run() external view {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        console.log("sqrtLower:", sqrtLower);
        console.log("sqrtUpper:", sqrtUpper);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            SQRT_PRICE_X96, sqrtLower, sqrtUpper, USDC_AMOUNT, MUSE_AMOUNT
        );
        console.log("liquidity:", liquidity);
        console.log("tickLower:", TICK_LOWER);
        console.log("tickUpper:", TICK_UPPER);
    }
}
