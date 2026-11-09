// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MuseLinuHook
/// @notice Uniswap v4 hook that takes 3% on every swap through a MUSN pool,
/// split 2% fee + 1% burn, on buys and sells alike. The fee is ALWAYS in the
/// quote currency (USDC / native / WETH), never in MUSN; the burn is ALWAYS
/// in MUSN, sent to the dead address.
/// @dev Fee mechanics (same pattern as the proven $MUSE/$RMUSE hooks):
///  - Buy (quote -> MUSN): the 2% fee is taken from the quote INPUT in
///    beforeSwap (positive specified delta + take()). The 1% burn is taken
///    from the MUSN OUTPUT in afterSwap (positive unspecified delta + take()).
///  - Sell (MUSN -> quote): the 1% burn is taken from the MUSN INPUT in
///    beforeSwap (positive specified delta + take()). The 2% fee is taken
///    from the quote OUTPUT in afterSwap (positive unspecified delta + take()).
///  In each case the returned delta credits the hook exactly what take()
///  paid out, so the hook's PoolManager balance nets to zero.
///  Exact-output swaps: the buy fee (beforeSwap) needs a specified input
///  amount, so exact-output buys pay no 2% fee (the 1% burn in afterSwap
///  still applies); exact-output sells pay the 2% fee but no 1% burn.
///  Routers use exact-input by default.
///  Burn floor: the hook reads the token's circulating supply before
///  burning. Once circulating supply reaches 12.5T per chain (50% of the
///  25T mint) the burn stops; the 2% fee keeps flowing. A burn that would
///  cross the floor is capped so circulating supply never drops below it.
///  @dev "Circulating supply" here is totalSupply() minus the dead-address
///  balance. Sending MUSN to the dead address does not reduce the ERC-20
///  totalSupply() (the tokens still exist, locked forever), so the floor
///  must be enforced on circulating supply — the quantity every explorer
///  and tracker reports — not on totalSupply() itself.
///  The hook only serves the one pool whose id is stored at construction
///  (computed from the pool key in the constructor); any other pool reverts.
///  No owner, no setters, no mint.
contract MuseLinuHook is IHooks {
    using PoolIdLibrary for PoolKey;

    /// @notice 2% fee to the collector, in basis points. Immutable.
    uint256 public constant FEE_BPS = 200;

    /// @notice 1% burn of the MUSN leg, in basis points. Immutable.
    uint256 public constant BURN_BPS = 100;

    /// @notice Burn floor: 12.5T MUSN in base units (50% of the 25T mint).
    /// Burning stops at this supply; the fee keeps flowing.
    uint256 public constant BURN_FLOOR = 12_500_000_000_000 * 1e9;

    /// @notice The dead address all burns go to. Immutable.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The FeeCollector that receives the 2% fee. Immutable.
    address public immutable collector;

    /// @notice The MUSN token. Immutable.
    address public immutable token;

    /// @notice The quote currency address (address(0) = native). Immutable.
    address public immutable quote;

    /// @notice The v4 PoolManager this hook is attached to.
    IPoolManager public immutable poolManager;

    /// @notice The one pool this hook serves. Set in the constructor; any
    /// other pool key reverts in beforeSwap/afterSwap.
    bytes32 public immutable poolId;

    /// @notice Emitted whenever the hook takes a fee.
    event FeeTaken(address indexed collector, Currency indexed currency, uint256 fee);

    /// @notice Emitted whenever the hook burns MUSN.
    event Burned(address indexed dead, uint256 amount, uint256 circulatingSupplyAfter);

    /// @notice Thrown when a hook call is for a pool other than the registered one.
    error WrongPool();

    /// @param _poolManager The Uniswap v4 PoolManager on this chain.
    /// @param _token The MUSN token address (same on all four chains).
    /// @param _quote The quote currency address (address(0) = native).
    /// @param _collector The MuseLinu FeeCollector address (same on all chains).
    /// @param _fee The pool fee (3000 = 0.3%).
    /// @param _tickSpacing The pool tick spacing (60).
    constructor(
        IPoolManager _poolManager,
        address _token,
        address _quote,
        address _collector,
        uint24 _fee,
        int24 _tickSpacing
    ) {
        poolManager = _poolManager;
        token = _token;
        quote = _quote;
        collector = _collector;

        // The pool key for this hook's pool. currency0/currency1 are sorted
        // by address, as the PoolManager requires.
        (Currency currency0, Currency currency1) = _token < _quote
            ? (Currency.wrap(_token), Currency.wrap(_quote))
            : (Currency.wrap(_quote), Currency.wrap(_token));
        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: _fee,
            tickSpacing: _tickSpacing,
            hooks: IHooks(address(this))
        });
        poolId = PoolId.unwrap(key.toId());

        // Self-check: the deployed address must carry BEFORE_SWAP (0x80),
        // BEFORE_SWAP_RETURNS_DELTA (0x08), AFTER_SWAP (0x40) and
        // AFTER_SWAP_RETURNS_DELTA (0x04), and nothing else (flags 0xCC).
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice Caps a raw burn amount at the floor: never burn circulating
    /// supply below 12.5T. Returns 0 once the floor is reached.
    /// @dev Circulating supply = totalSupply() - dead-address balance (see
    /// the floor note above).
    function _cappedBurn(uint256 rawBurn) internal view returns (uint256) {
        uint256 circulating = IERC20(token).totalSupply() - IERC20(token).balanceOf(DEAD);
        if (circulating <= BURN_FLOOR) return 0;
        uint256 maxBurn = circulating - BURN_FLOOR;
        return rawBurn > maxBurn ? maxBurn : rawBurn;
    }

    /// @notice Circulating supply after a burn (totalSupply minus dead balance).
    function _circulatingAfter() internal view returns (uint256) {
        return IERC20(token).totalSupply() - IERC20(token).balanceOf(DEAD);
    }

    /// @notice Buy fee (2% of quote input) and sell burn (1% of MUSN input).
    /// @dev Exact-input only: amountSpecified < 0. Exact-output swaps have
    /// no specified input amount, so no fee/burn is taken here.
    function beforeSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        bytes calldata
    ) external override returns (bytes4, BeforeSwapDelta, uint24) {
        if (PoolId.unwrap(key.toId()) != poolId) revert WrongPool();
        if (params.amountSpecified >= 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // Input currency: zeroForOne ? currency0 : currency1.
        Currency inputCurrency = params.zeroForOne ? key.currency0 : key.currency1;
        uint256 inputAmount = uint256(-params.amountSpecified);

        if (Currency.unwrap(inputCurrency) == quote) {
            // Buy: 2% of the quote input to the collector.
            uint256 fee = (inputAmount * FEE_BPS) / 10000;
            if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
            poolManager.take(Currency.wrap(quote), collector, fee);
            emit FeeTaken(collector, Currency.wrap(quote), fee);
            return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
        } else {
            // Sell: 1% of the MUSN input burned, capped at the floor.
            uint256 burn = _cappedBurn((inputAmount * BURN_BPS) / 10000);
            if (burn == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
            poolManager.take(Currency.wrap(token), DEAD, burn);
            emit Burned(DEAD, burn, _circulatingAfter());
            return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(burn)), 0), 0);
        }
    }

    /// @notice Sell fee (2% of quote output) and buy burn (1% of MUSN output).
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external override returns (bytes4, int128) {
        if (PoolId.unwrap(key.toId()) != poolId) revert WrongPool();

        // Output currency: zeroForOne ? currency1 : currency0.
        Currency outputCurrency = params.zeroForOne ? key.currency1 : key.currency0;
        int128 outputDelta = params.zeroForOne ? delta.amount1() : delta.amount0();
        if (outputDelta <= 0) return (IHooks.afterSwap.selector, 0);
        uint256 outputAmount = uint128(outputDelta);

        if (Currency.unwrap(outputCurrency) == quote) {
            // Sell: 2% of the quote output to the collector.
            uint256 fee = (outputAmount * FEE_BPS) / 10000;
            if (fee == 0) return (IHooks.afterSwap.selector, 0);
            poolManager.take(outputCurrency, collector, fee);
            emit FeeTaken(collector, outputCurrency, fee);
            return (IHooks.afterSwap.selector, int128(int256(fee)));
        } else {
            // Buy: 1% of the MUSN output burned, capped at the floor.
            uint256 burn = _cappedBurn((outputAmount * BURN_BPS) / 10000);
            if (burn == 0) return (IHooks.afterSwap.selector, 0);
            poolManager.take(outputCurrency, DEAD, burn);
            emit Burned(DEAD, burn, _circulatingAfter());
            return (IHooks.afterSwap.selector, int128(int256(burn)));
        }
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
