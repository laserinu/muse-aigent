// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title NativeSwapHelper
/// @notice Fork-test-only swap router that handles a native-currency leg
/// (Polygon POL). Same pattern as SwapHelper, but a negative delta in the
/// native currency is settled with msg.value (sent with swap()), and a
/// positive native delta is taken to the recipient as native currency.
/// @dev The caller sends the exact native input as value with swap(). For an
/// exact-input swap the caller owes exactly the specified input amount.
contract NativeSwapHelper is IUnlockCallback {
    IPoolManager public immutable poolManager;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    receive() external payable {}

    function swap(
        PoolKey memory key,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        address recipient
    ) external payable returns (BalanceDelta delta) {
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
        _settleNegative(key.currency0, delta.amount0());
        _settleNegative(key.currency1, delta.amount1());
        if (delta.amount0() > 0) {
            poolManager.take(key.currency0, recipient, uint128(delta.amount0()));
        }
        if (delta.amount1() > 0) {
            poolManager.take(key.currency1, recipient, uint128(delta.amount1()));
        }
        return abi.encode(delta);
    }

    function _settleNegative(Currency currency, int128 amount) internal {
        if (amount >= 0) return;
        uint256 owed = uint128(-amount);
        if (Currency.unwrap(currency) == address(0)) {
            // Native: pay from this contract's balance (msg.value from swap()).
            poolManager.settle{value: owed}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).transfer(address(poolManager), owed);
            poolManager.settle();
        }
    }
}
