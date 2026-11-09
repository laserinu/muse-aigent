// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title SwapHelper
/// @notice Test-only contract that swaps on a v4 pool by unlocking the
/// PoolManager directly. The caller funds this contract with the input
/// token; the output goes to the given recipient.
/// @dev Delta sign convention (v4): positive = the PoolManager owes the
/// caller (the caller receives), negative = the caller owes the PoolManager
/// (the caller pays). So a negative delta is settled (sync + transfer +
/// settle) and a positive delta is taken.
contract SwapHelper is IUnlockCallback {
    IPoolManager public immutable poolManager;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// @notice Exact-input swap. amountSpecified < 0 means exact input of
    /// |amountSpecified| of the input currency.
    function swap(
        PoolKey memory key,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        address recipient
    ) external returns (BalanceDelta delta) {
        bytes memory result = poolManager.unlock(
            abi.encode(key, zeroForOne, amountSpecified, sqrtPriceLimitX96, recipient)
        );
        return abi.decode(result, (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, address recipient) =
            abi.decode(data, (PoolKey, bool, int256, uint160, address));
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });
        BalanceDelta delta = poolManager.swap(key, params, "");
        // Pay what we owe (negative delta): sync + transfer, then settle()
        // pays it off. Then take what we are owed (positive delta).
        if (delta.amount0() < 0) {
            poolManager.sync(key.currency0);
            IERC20(Currency.unwrap(key.currency0)).transfer(address(poolManager), uint128(-delta.amount0()));
        }
        if (delta.amount1() < 0) {
            poolManager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).transfer(address(poolManager), uint128(-delta.amount1()));
        }
        if (delta.amount0() < 0 || delta.amount1() < 0) {
            poolManager.settle();
        }
        if (delta.amount0() > 0) {
            poolManager.take(key.currency0, recipient, uint128(delta.amount0()));
        }
        if (delta.amount1() > 0) {
            poolManager.take(key.currency1, recipient, uint128(delta.amount1()));
        }
        return abi.encode(delta);
    }
}
