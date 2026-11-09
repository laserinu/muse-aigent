// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title MuseFeeHook
/// @notice Uniswap v4 hook that takes a 3% fee on every swap's output and sends it
/// to the agent wallet (0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4), on buys and
/// sells alike. afterSwap ONLY. No owner, no setters, no mint/burn.
/// @dev Fee mechanics (PopCapHook/StockStream pattern): afterSwap returns a
/// POSITIVE hookDeltaUnspecified (+fee, the hook took currency) AND calls
/// poolManager.take() to physically move the fee to the recipient. Both steps
/// are required for PoolManager accounting to balance: take() creates the
/// hook's negative balance, the returned +fee delta credits it back to zero.
/// The hook only serves the one pool whose id is stored at construction
/// (computed from the pool key in the constructor); any other pool reverts.
/// Exact-output swaps are not supported by the fee math and may revert;
/// routers use exact-input by default.
contract MuseFeeHook is IHooks {
    using PoolIdLibrary for PoolKey;

    /// @notice 3% fee, in basis points. Immutable.
    uint256 public constant FEE_BPS = 300;

    /// @notice The agent wallet that receives all fees. Hardcoded, immutable.
    address public constant FEE_RECIPIENT = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4;

    /// @notice The v4 PoolManager this hook is attached to.
    IPoolManager public immutable poolManager;

    /// @notice The one pool this hook serves. Set in the constructor; any
    /// other pool key reverts in afterSwap.
    bytes32 public immutable poolId;

    /// @notice Emitted whenever the hook takes a fee.
    event FeeTaken(address indexed recipient, Currency indexed currency, uint256 fee);

    /// @notice Thrown when afterSwap is called for a pool other than the registered one.
    error WrongPool();

    /// @notice Thrown when the deployed address does not carry the required hook flags.
    error BadHookAddress();

    /// @param _poolManager The Uniswap v4 PoolManager on Arc.
    /// @param _token The $MUSE token address (new relaunch token).
    /// @param _usdc The USDC ERC-20 on Arc (0x3600...0000).
    /// @param _fee The pool fee (3000 = 0.3%).
    /// @param _tickSpacing The pool tick spacing (60).
    constructor(IPoolManager _poolManager, address _token, address _usdc, uint24 _fee, int24 _tickSpacing) {
        poolManager = _poolManager;

        // The pool key for this hook's pool. currency0/currency1 are sorted
        // by address, as the PoolManager requires.
        (Currency currency0, Currency currency1) = _token < _usdc
            ? (Currency.wrap(_token), Currency.wrap(_usdc))
            : (Currency.wrap(_usdc), Currency.wrap(_token));
        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: _fee,
            tickSpacing: _tickSpacing,
            hooks: IHooks(address(this))
        });
        poolId = PoolId.unwrap(key.toId());

        // Self-check: the deployed address must carry AFTER_SWAP (0x40) and
        // AFTER_SWAP_RETURNS_DELTA (0x04), and nothing else.
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice Takes 3% of the swap's output and sends it to the fee recipient.
    /// @dev delta is the amount owed to the caller (positive) or owed to the
    /// pool (negative). The output currency is the one the trader receives,
    /// which has a positive delta. zeroForOne swaps give currency1 as output,
    /// the reverse gives currency0.
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override returns (bytes4, int128) {
        if (PoolId.unwrap(key.toId()) != poolId) revert WrongPool();

        bool zeroForOne = params.zeroForOne;
        Currency outputCurrency = zeroForOne ? key.currency1 : key.currency0;
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();

        // No output (or a zero/negative delta) means no fee.
        if (outputDelta <= 0) return (IHooks.afterSwap.selector, 0);

        uint256 outputAmount = uint128(outputDelta);
        uint256 fee = (outputAmount * FEE_BPS) / 10000;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        // Move the fee out of the PoolManager to the agent wallet, and tell
        // the PoolManager the hook took `fee` of the output currency.
        poolManager.take(outputCurrency, FEE_RECIPIENT, fee);
        emit FeeTaken(FEE_RECIPIENT, outputCurrency, fee);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    // ---- Unused hooks: never called (flags not set), return selectors. ----

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeDonate.selector;
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.afterDonate.selector;
    }
}
