// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title V3SwapHelper
/// @notice Minimal owner-only helper that executes exact-input swaps on a
/// Uniswap V3 pool by calling pool.swap() directly and paying the pool in
/// `uniswapV3SwapCallback`. Built for the Muse sniper on Robinhood Chain
/// (4663), where the forked Universal Router's V3 path (command 0x00)
/// reverts for EOAs — the router is bypassed entirely.
///
/// Funding model (transfer-first, no approvals):
///   1. The owner transfers `amountIn` of `tokenIn` to this contract.
///   2. The owner calls `swapExactInputSingle(...)`.
///   3. The contract swaps, then sends the entire `tokenOut` output
///      straight back to the owner in the same transaction.
/// The contract never holds funds beyond a single in-flight swap. If a
/// swap reverts, the input stays in the contract and the owner can pull
/// it back with `rescueToken`.
///
/// Safety:
///   - Only the owner (the agent wallet) can call swap/rescue.
///   - The callback only pays the pool of the in-flight swap: `activePool`
///     is set before pool.swap() and cleared after, and the callback
///     requires msg.sender == activePool. No other contract can trigger
///     a payment out of the helper.
///   - No delegatecall, no selfdestruct, no upgradeability, no arbitrary
///     calls, no ETH handling (no receive/fallback).
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

contract V3SwapHelper {
    /// @notice The agent wallet. Set once at deploy; immutable.
    address public immutable owner;

    /// @notice The pool of the swap currently in flight. Set before
    /// pool.swap() and cleared after; the callback only pays this pool.
    address private activePool;

    /// @dev TickMath bounds. sqrtPriceLimitX96 must stay strictly inside
    /// these, so we use MIN+1 / MAX-1 (effectively no price bound) and
    /// enforce the real slippage bound with `amountOutMinimum` instead.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 14614467034852101032872730580574079481275333;

    error NotOwner();
    error BadPool();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientOutput();
    error TransferFailed();

    event Swapped(address indexed pool, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event Rescued(address indexed token, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Swap an exact `amountIn` of `tokenIn` for `tokenOut` on `pool`.
    /// The caller must have transferred `amountIn` of `tokenIn` to this
    /// contract beforehand. The full output is sent to the owner.
    /// @return amountOut The amount of `tokenOut` received and forwarded.
    function swapExactInputSingle(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) external onlyOwner returns (uint256 amountOut) {
        if (pool == address(0) || tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        address token0 = IUniswapV3Pool(pool).token0();
        address token1 = IUniswapV3Pool(pool).token1();
        bool inputIsToken0;
        if (tokenIn == token0 && tokenOut == token1) {
            inputIsToken0 = true;
        } else if (tokenIn == token1 && tokenOut == token0) {
            inputIsToken0 = false;
        } else {
            revert BadPool();
        }
        if (IERC20(tokenIn).balanceOf(address(this)) < amountIn) revert InsufficientBalance();

        // Price limit: no bound (MIN+1 / MAX-1). Slippage is enforced
        // by amountOutMinimum below.
        uint160 sqrtPriceLimitX96 = inputIsToken0 ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;

        activePool = pool;
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            address(this),
            inputIsToken0,
            int256(amountIn),
            sqrtPriceLimitX96,
            ""
        );
        activePool = address(0);

        // Pool deltas: positive = the pool received it (we paid);
        // negative = the pool sent it (we received it). The output
        // is the negative leg.
        int256 outDelta = inputIsToken0 ? -amount1 : -amount0;
        if (outDelta <= 0 || uint256(outDelta) < amountOutMinimum) revert InsufficientOutput();
        amountOut = uint256(outDelta);

        // Forward the entire output to the owner; nothing stays here.
        if (!IERC20(tokenOut).transfer(owner, amountOut)) revert TransferFailed();
        emit Swapped(pool, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Called by the V3 pool during swap(). Pays the pool the exact
    /// amount owed, from this contract's balance. Only the pool of the
    /// in-flight swap can trigger a payment (see `activePool`).
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata /* data */) external {
        if (msg.sender != activePool) revert BadPool();
        if (amount0Delta > 0) {
            address token0 = IUniswapV3Pool(msg.sender).token0();
            if (!IERC20(token0).transfer(msg.sender, uint256(amount0Delta))) revert TransferFailed();
        } else if (amount1Delta > 0) {
            address token1 = IUniswapV3Pool(msg.sender).token1();
            if (!IERC20(token1).transfer(msg.sender, uint256(amount1Delta))) revert TransferFailed();
        }
    }

    /// @notice Owner-only rescue for tokens stranded in the helper (e.g.
    /// input left over when a swap reverts). The helper never holds ETH,
    /// so no ETH rescue exists.
    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
        emit Rescued(token, amount);
    }
}
