// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPoolInitializer_v4} from "@uniswap/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MuseAiAgent} from "./MuseAiAgent.sol";

/// @notice Minimal interface for the Permit2 contract (canonical deployment).
/// Only the approve function is needed: it authorises a spender (the
/// PositionManager) to pull the factory's tokens through Permit2.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice Minimal interface to read the Permit2 address a PositionManager
/// was deployed with. Arc's Permit2 is NOT at the canonical address
/// (0x000000000022D473030F116dDEE9F7B43aC78BA3 has no code on Arc); the
/// PositionManager on Arc uses 0x000000000022D473030F116dDEE9F6B43aC78BA3.
/// Reading it from the PositionManager is correct on every chain.
interface IHasPermit2 {
    function permit2() external view returns (address);
}

/// @title MuseDeployer
/// @notice Own deployer factory for the $MUSE relaunch on Uniswap v4 (Arc).
/// One launch() transaction deploys the MuseAiAgent token, initialises the
/// MUSE/USDC v4 pool with the 3% fee hook, and seeds the initial liquidity
/// position. The leftover MUSE (total supply minus the seed) stays LOCKED
/// inside this contract; only the owner (the agent wallet) can release it,
/// via release(), and only when the user decides. The position NFT goes to
/// the agent wallet. The USDC seed is pulled from the agent wallet (the agent
/// approves this factory first).
/// @dev The token is deployed with CREATE2 (fixed salt) so its address is
/// deterministic. The token mints the full 100T supply to this factory
/// (msg.sender at construction). The hook address is a launch() parameter:
/// the hook must be deployed (via the Arachnid CREATE2 factory, mined salt)
/// BEFORE launch() is called, because the hook's constructor needs the token
/// address (computed from this factory's address + the fixed salt).
contract MuseDeployer {
    using PoolIdLibrary for PoolKey;

    /// @notice USDC ERC-20 used as the pool's quote currency. Passed in the
    /// constructor so the contract is testable (a mock USDC can be used on a
    /// fork); on Arc mainnet this is 0x3600000000000000000000000000000000000000.
    address public immutable usdc;

    /// @notice The Permit2 contract the PositionManager uses. Read from the
    /// PositionManager in the constructor (Arc's is non-canonical).
    address public immutable permit2;

    /// @notice The agent wallet: owner of this factory, fee recipient, and
    /// recipient of the position NFT. Only the owner can launch() or release().
    address public immutable owner;

    /// @notice The v4 PoolManager on Arc.
    IPoolManager public immutable poolManager;

    /// @notice The v4 PositionManager on Arc.
    IPositionManager public immutable positionManager;

    /// @notice Fixed CREATE2 salt for the token deployment.
    bytes32 public constant TOKEN_SALT = keccak256("MUSE-RELAUNCH-1");

    /// @notice Pool fee: 3000 = 0.3% LP fee (separate from the 3% hook fee).
    uint24 public constant POOL_FEE = 3000;

    /// @notice Pool tick spacing.
    int24 public constant TICK_SPACING = 60;

    /// @notice The deployed $MUSE token address. Set by launch().
    address public token;

    /// @notice Emitted when a launch completes.
    event Launched(
        address indexed token,
        PoolId indexed poolId,
        uint256 indexed positionTokenId,
        uint256 museAmount,
        uint256 usdcAmount,
        uint160 sqrtPriceX96
    );

    /// @notice Emitted when the owner releases locked MUSE.
    event Released(address indexed to, uint256 amount);

    error OnlyOwner();
    error AlreadyLaunched();
    error NotLaunched();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(IPoolManager _poolManager, IPositionManager _positionManager, address _owner, address _usdc) {
        poolManager = _poolManager;
        positionManager = _positionManager;
        owner = _owner;
        usdc = _usdc;
        permit2 = IHasPermit2(address(_positionManager)).permit2();
    }

    /// @notice Deploys the token, initialises the v4 pool, and seeds the
    /// initial liquidity position, in one transaction.
    /// @dev Only the owner (agent wallet) can call. The caller must have
    /// approved this factory to pull `usdcAmount` of USDC beforehand.
    /// The leftover MUSE stays locked in this contract (see release()).
    /// Any leftover USDC (rounding) is returned to the owner.
    /// @param hook The deployed MuseFeeHook address (mined CREATE2, flags 0x44).
    /// @param museAmount Amount of MUSE (9 dec) to seed into the pool.
    /// @param usdcAmount Amount of USDC (6 dec) to seed into the pool.
    /// @param sqrtPriceX96 The pool's starting sqrt price (Q64.96).
    /// @param tickLower Lower tick of the initial position (multiple of 60).
    /// @param tickUpper Upper tick of the initial position (multiple of 60).
    /// @return positionTokenId The ERC-721 id of the liquidity position (owned by the agent wallet).
    /// @return poolId The id of the new pool.
    function launch(
        address hook,
        uint256 museAmount,
        uint256 usdcAmount,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper
    ) external onlyOwner returns (uint256 positionTokenId, PoolId poolId) {
        if (token != address(0)) revert AlreadyLaunched();

        // (a) Deploy the token. CREATE2 with the fixed salt; the full 100T
        // supply mints to this factory (msg.sender).
        token = address(new MuseAiAgent{salt: TOKEN_SALT}());

        // (b) Pull the USDC seed from the agent wallet.
        IERC20(usdc).transferFrom(owner, address(this), usdcAmount);

        // (c) Build the pool key and seed the position (initialise pool +
        // mint + settle).
        PoolKey memory key = _buildKey(hook);
        poolId = key.toId();
        positionTokenId = _seed(key, museAmount, usdcAmount, sqrtPriceX96, tickLower, tickUpper);

        // (d) Return any leftover USDC (rounding) to the owner. The leftover
        // MUSE stays locked in this contract by design.
        uint256 usdcLeft = IERC20(usdc).balanceOf(address(this));
        if (usdcLeft > 0) IERC20(usdc).transfer(owner, usdcLeft);

        emit Launched(token, poolId, positionTokenId, museAmount, usdcAmount, sqrtPriceX96);
    }

    /// @notice Builds the pool key for the token/USDC pool with the hook.
    function _buildKey(address hook) internal view returns (PoolKey memory key) {
        (Currency currency0, Currency currency1) = token < usdc
            ? (Currency.wrap(token), Currency.wrap(usdc))
            : (Currency.wrap(usdc), Currency.wrap(token));
        key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @notice Computes the liquidity, approves Permit2, and multicalls the
    /// PositionManager (initializePool + MINT_POSITION + SETTLE_PAIR).
    /// Returns the ERC-721 id of the minted position (owned by the agent wallet).
    function _seed(
        PoolKey memory key,
        uint256 museAmount,
        uint256 usdcAmount,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper
    ) internal returns (uint256 positionTokenId) {
        (uint256 amount0, uint256 amount1) = token < usdc
            ? (museAmount, usdcAmount)
            : (usdcAmount, museAmount);

        uint160 sqrtPriceLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtPriceUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            sqrtPriceLower,
            sqrtPriceUpper,
            amount0,
            amount1
        );

        // Approve Permit2 so the PositionManager can pull the seed. Both
        // layers are needed: the ERC20 allowance (so Permit2 can move the
        // factory's tokens) and the Permit2 allowance (so the PositionManager
        // is authorised to instruct Permit2).
        IERC20(token).approve(permit2, museAmount);
        IERC20(usdc).approve(permit2, usdcAmount);
        IPermit2(permit2).approve(token, address(positionManager), uint160(museAmount), type(uint48).max);
        IPermit2(permit2).approve(usdc, address(positionManager), uint160(usdcAmount), type(uint48).max);

        positionTokenId = positionManager.nextTokenId();
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(IPoolInitializer_v4.initializePool.selector, key, sqrtPriceX96);

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            liquidity,
            uint128(amount0),
            uint128(amount1),
            owner,
            bytes("")
        );
        mintParams[1] = abi.encode(key.currency0, key.currency1);
        calls[1] = abi.encodeWithSelector(
            IPositionManager.modifyLiquidities.selector,
            abi.encode(actions, mintParams),
            block.timestamp + 3600
        );
        positionManager.multicall(calls);
    }

    /// @notice Releases locked MUSE from this contract. Only the owner can
    /// call, and only when the user decides. Not called during launch().
    /// @param to The address to send MUSE to.
    /// @param amount The amount of MUSE (9 dec) to release.
    function release(address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert NotLaunched();
        IERC20(token).transfer(to, amount);
        emit Released(to, amount);
    }

    /// @notice Returns the deterministic token address for this factory,
    /// without deploying. Useful to compute the hook's constructor args
    /// before launch().
    function predictTokenAddress() external view returns (address) {
        bytes32 initCodeHash = keccak256(type(MuseAiAgent).creationCode);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), TOKEN_SALT, initCodeHash)))));
    }
}
