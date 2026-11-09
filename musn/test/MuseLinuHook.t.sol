// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MuseLinuToken} from "../src/MuseLinuToken.sol";
import {MuseLinuFeeCollector} from "../src/MuseLinuFeeCollector.sol";
import {MuseLinuHook} from "../src/MuseLinuHook.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockWETH9} from "./mocks/MockWETH9.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// @title MuseLinu hook tests (local, no RPC)
/// @notice Proves, with exact numbers, the approved spec on a fresh local
/// v4 PoolManager:
///  - Buy: 2% of the quote input to the collector, 1% of the MUSN output
///    burned to the dead address (total 3%).
///  - Sell: 1% of the MUSN input burned, 2% of the quote output to the
///    collector (total 3%).
///  - Burn floor: burning stops at 12.5T circulating supply (capped, then
///    zero), while the 2% fee keeps flowing.
///  - Only the agent wallet (owner) can withdraw from the collector.
///  - Plain MUSN transfers are untaxed.
///  - The hook rejects any pool other than its registered one.
///  - The hook can only deploy at a flag-valid address (0xCC).
contract MuseLinuHookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant FLAGS = 0xCC; // beforeSwap|afterSwap|both return deltas
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BURN_FLOOR = 12_500_000_000_000 * 1e9;

    MuseLinuToken internal token;
    MuseLinuFeeCollector internal collector;
    MockUSDC internal usdc;

    // Note: Deployers.sol already provides receive(), so this test contract
    // can accept native currency from swaps and collector withdrawals.

    function setUp() public {
        deployFreshManagerAndRouters();
        vm.deal(address(this), 100 ether);
        token = new MuseLinuToken(address(this));
        collector = new MuseLinuFeeCollector(address(this));
        usdc = new MockUSDC();
        // Top up the mock USDC so the test can seed deep pools (the mock
        // constructor only mints 1M; a 1e15-liquidity position needs ~3e13).
        usdc.mint(address(this), 1_000_000_000 * 1e6);
    }

    // ---- helpers ----

    /// @notice Mines a flag-valid hook salt and deploys the hook for a
    /// (token, quote) pair. Returns the hook and its pool key.
    function _deployHook(address tokenAddr, address quoteAddr) internal returns (MuseLinuHook hook, PoolKey memory key) {
        bytes memory creationCode = type(MuseLinuHook).creationCode;
        bytes memory constructorArgs =
            abi.encode(manager, tokenAddr, quoteAddr, address(collector), POOL_FEE, TICK_SPACING);
        (address hookAddress, bytes32 salt) = HookMiner.find(address(this), FLAGS, creationCode, constructorArgs);
        hook = new MuseLinuHook{salt: salt}(manager, tokenAddr, quoteAddr, address(collector), POOL_FEE, TICK_SPACING);
        assertEq(address(hook), hookAddress, "hook address mismatch");

        (Currency c0, Currency c1) = tokenAddr < quoteAddr
            ? (Currency.wrap(tokenAddr), Currency.wrap(quoteAddr))
            : (Currency.wrap(quoteAddr), Currency.wrap(tokenAddr));
        key = PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))});
    }

    /// @notice Initializes the pool at price 1:1 and adds a concentrated
    /// position (tick range [-600, 600], `liquidity` liquidityDelta) funded
    /// by this test contract. For a native quote, `nativeValue` must be sent.
    /// @dev Each side of the position holds ~2.96% of `liquidity` in base
    /// units, so swaps must stay well below ~3% of the position's side.
    function _initPoolWithLiquidity(
        PoolKey memory key,
        address tokenAddr,
        address quoteAddr,
        int256 liquidity,
        uint256 nativeValue
    ) internal {
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        // Approve the liquidity router for both ERC-20s.
        if (tokenAddr != address(0)) IERC20(tokenAddr).approve(address(modifyLiquidityRouter), type(uint256).max);
        if (quoteAddr != address(0)) IERC20(quoteAddr).approve(address(modifyLiquidityRouter), type(uint256).max);
        IPoolManager.ModifyLiquidityParams memory params = IPoolManager.ModifyLiquidityParams({
            tickLower: -600,
            tickUpper: 600,
            liquidityDelta: liquidity,
            salt: 0
        });
        modifyLiquidityRouter.modifyLiquidity{value: nativeValue}(key, params, new bytes(0));
    }

    /// @notice Exact-input swap through SwapRouterNoChecks. `inputIsCurrency0`
    /// selects zeroForOne. For a native input, `nativeValue` must be sent.
    function _swap(PoolKey memory key, bool inputIsCurrency0, int256 inputAmount, uint256 nativeValue) internal {
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: inputIsCurrency0,
            amountSpecified: -inputAmount,
            sqrtPriceLimitX96: inputIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        swapRouterNoChecks.swap{value: nativeValue}(key, params);
    }

    // ---- token basics ----

    function test_TokenSupplyDecimalsAndHolder() public view {
        assertEq(token.name(), "MuseLinu");
        assertEq(token.symbol(), "MUSN");
        assertEq(token.decimals(), 9);
        assertEq(token.totalSupply(), 25_000_000_000_000 * 1e9);
        assertEq(token.balanceOf(address(this)), 25_000_000_000_000 * 1e9);
    }

    function test_PlainTransferNoTax() public {
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");
        token.transfer(alice, 1_000_000 * 1e9);
        assertEq(token.balanceOf(alice), 1_000_000 * 1e9, "transfer taxed or short");
        vm.prank(alice);
        token.transfer(bob, 400_000 * 1e9);
        assertEq(token.balanceOf(bob), 400_000 * 1e9, "second transfer taxed or short");
        assertEq(token.balanceOf(alice), 600_000 * 1e9);
    }

    // ---- buy: 2% fee (input) + 1% burn (output) ----

    function test_BuyFeeAndBurn_USDC() public {
        (MuseLinuHook hook, PoolKey memory key) = _deployHook(address(token), address(usdc));
        _initPoolWithLiquidity(key, address(token), address(usdc), 1e15, 0);
        bool musnIsC0 = address(token) < address(usdc);

        uint256 usdcIn = 100 * 1e6; // 100 USDC
        usdc.approve(address(swapRouterNoChecks), type(uint256).max);

        uint256 musnBefore = token.balanceOf(address(this));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 collectorBefore = usdc.balanceOf(address(collector));
        uint256 deadBefore = token.balanceOf(DEAD);

        // Buy MUSN with USDC: input is USDC (currency1 if MUSN is currency0).
        _swap(key, !musnIsC0, int256(usdcIn), 0);

        uint256 usdcPaid = usdcBefore - usdc.balanceOf(address(this));
        uint256 musnReceived = token.balanceOf(address(this)) - musnBefore;
        uint256 fee = usdc.balanceOf(address(collector)) - collectorBefore;
        uint256 burn = token.balanceOf(DEAD) - deadBefore;

        // The buyer pays exactly the specified input; the hook skims 2% of it.
        assertEq(usdcPaid, usdcIn, "buyer paid more/less than specified input");
        assertEq(fee, usdcIn * 200 / 10000, "collector fee is not exactly 2% of input");
        // Burn is 1% of the CORE MUSN output (received + burned).
        assertEq(burn, (musnReceived + burn) / 100, "burn is not exactly 1% of MUSN output");
        assertGt(musnReceived, 0, "no MUSN received");
        assertEq(hook.collector(), address(collector));
    }

    // ---- sell: 1% burn (input) + 2% fee (output) ----

    function test_SellFeeAndBurn_USDC() public {
        (MuseLinuHook hook, PoolKey memory key) = _deployHook(address(token), address(usdc));
        _initPoolWithLiquidity(key, address(token), address(usdc), 1e15, 0);
        bool musnIsC0 = address(token) < address(usdc);

        uint256 musnIn = 1_000 * 1e9; // 1,000 MUSN (~3% of the pool's MUSN side)
        token.approve(address(swapRouterNoChecks), type(uint256).max);
        usdc.approve(address(swapRouterNoChecks), type(uint256).max);

        uint256 musnBefore = token.balanceOf(address(this));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 collectorBefore = usdc.balanceOf(address(collector));
        uint256 deadBefore = token.balanceOf(DEAD);

        // Sell MUSN for USDC: input is MUSN.
        _swap(key, musnIsC0, int256(musnIn), 0);

        uint256 musnPaid = musnBefore - token.balanceOf(address(this));
        uint256 usdcReceived = usdc.balanceOf(address(this)) - usdcBefore;
        uint256 fee = usdc.balanceOf(address(collector)) - collectorBefore;
        uint256 burn = token.balanceOf(DEAD) - deadBefore;

        assertEq(musnPaid, musnIn, "seller paid more/less than specified input");
        assertEq(burn, musnIn / 100, "burn is not exactly 1% of MUSN input");
        // Fee is 2% of the CORE USDC output (received + fee).
        assertEq(fee, (usdcReceived + fee) * 200 / 10000, "collector fee is not exactly 2% of output");
        assertGt(usdcReceived, 0, "no USDC received");
        assertEq(hook.token(), address(token));
    }

    // ---- native quote pool (Polygon POL path) ----

    /// @notice Deploys the MUSN/native hook + pool and seeds it. Native is
    /// always currency0 (address 0 is the lowest address).
    function _setupNativePool() internal returns (MuseLinuHook hook, PoolKey memory key) {
        (hook, key) = _deployHook(address(token), address(0));
        // Deep native side (~2.96 ETH) so a 0.01 ETH buy is a small trade.
        _initPoolWithLiquidity(key, address(token), address(0), 1e20, 5 ether);
        assertEq(Currency.unwrap(key.currency0), address(0), "native must be currency0");
        token.approve(address(swapRouterNoChecks), type(uint256).max);
    }

    function test_Buy_NativeQuote() public {
        (MuseLinuHook hook, PoolKey memory key) = _setupNativePool();

        // Buy MUSN with native: input is currency0, zeroForOne = true.
        uint256 nativeIn = 0.01 ether;
        uint256 musnBefore = token.balanceOf(address(this));
        uint256 collectorBefore = address(collector).balance;
        uint256 deadBefore = token.balanceOf(DEAD);
        _swap(key, true, int256(nativeIn), nativeIn);
        uint256 musnReceived = token.balanceOf(address(this)) - musnBefore;
        uint256 fee = address(collector).balance - collectorBefore;
        uint256 burn = token.balanceOf(DEAD) - deadBefore;
        assertEq(fee, nativeIn * 200 / 10000, "native buy fee is not exactly 2% of input");
        assertEq(burn, (musnReceived + burn) / 100, "native buy burn is not exactly 1% of MUSN output");
        assertGt(musnReceived, 0);
        assertEq(hook.quote(), address(0));
    }

    function test_Sell_NativeQuote() public {
        (, PoolKey memory key) = _setupNativePool();

        // Sell MUSN for native: input is MUSN (currency1), zeroForOne = false.
        uint256 musnIn = 1_000 * 1e9;
        uint256 ethBefore = address(this).balance;
        uint256 collectorBefore = address(collector).balance;
        uint256 deadBefore = token.balanceOf(DEAD);
        _swap(key, false, int256(musnIn), 0);
        uint256 ethReceived = address(this).balance - ethBefore;
        uint256 fee = address(collector).balance - collectorBefore;
        uint256 burn = token.balanceOf(DEAD) - deadBefore;
        assertEq(burn, musnIn / 100, "native sell burn is not exactly 1% of MUSN input");
        assertEq(fee, (ethReceived + fee) * 200 / 10000, "native sell fee is not exactly 2% of output");
        assertGt(ethReceived, 0);
    }

    // ---- burn floor ----

    function test_FloorCap() public {
        // Supply just above the floor: FLOOR + 10 MUSN.
        MockToken mock = new MockToken(address(this), BURN_FLOOR + 10 * 1e9);
        (MuseLinuHook hook, PoolKey memory key) = _deployHook(address(mock), address(usdc));
        _initPoolWithLiquidity(key, address(mock), address(usdc), 1e15, 0);
        bool musnIsC0 = address(mock) < address(usdc);
        mock.approve(address(swapRouterNoChecks), type(uint256).max);
        usdc.approve(address(swapRouterNoChecks), type(uint256).max);

        // Sell 1,000 MUSN: raw burn would be 10 MUSN, which is exactly the
        // 10 MUSN of headroom above the floor — the cap binds exactly.
        uint256 deadBefore = mock.balanceOf(DEAD);
        _swap(key, musnIsC0, int256(1_000 * 1e9), 0);
        uint256 burn = mock.balanceOf(DEAD) - deadBefore;
        assertEq(burn, 10 * 1e9, "burn was not capped at the floor");
        assertEq(mock.totalSupply() - mock.balanceOf(DEAD), BURN_FLOOR, "circulating supply not at floor");

        // Second sell: floor reached, burn is 0, but the swap still works.
        uint256 deadBefore2 = mock.balanceOf(DEAD);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        _swap(key, musnIsC0, int256(1_000 * 1e9), 0);
        assertEq(mock.balanceOf(DEAD) - deadBefore2, 0, "burn did not stop at the floor");
        assertGt(usdc.balanceOf(address(this)) - usdcBefore, 0, "sell stopped working at floor");
        assertEq(hook.BURN_FLOOR(), BURN_FLOOR);
    }

    function test_FloorReached_FeeStillFlows() public {
        // Supply already below the floor (1T < 12.5T): no burn at all, but
        // the 2% fee to the collector keeps flowing on buys and sells.
        MockToken mock = new MockToken(address(this), 1_000_000_000_000 * 1e9);
        (MuseLinuHook hook, PoolKey memory key) = _deployHook(address(mock), address(usdc));
        _initPoolWithLiquidity(key, address(mock), address(usdc), 1e15, 0);
        bool musnIsC0 = address(mock) < address(usdc);
        mock.approve(address(swapRouterNoChecks), type(uint256).max);
        usdc.approve(address(swapRouterNoChecks), type(uint256).max);

        // Sell: burn 0, fee 2% of USDC output.
        uint256 deadBefore = mock.balanceOf(DEAD);
        uint256 collectorBefore = usdc.balanceOf(address(collector));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        _swap(key, musnIsC0, int256(1_000 * 1e9), 0);
        assertEq(mock.balanceOf(DEAD) - deadBefore, 0, "burn should be 0 below floor");
        uint256 feeSell = usdc.balanceOf(address(collector)) - collectorBefore;
        uint256 receivedSell = usdc.balanceOf(address(this)) - usdcBefore;
        assertEq(feeSell, (receivedSell + feeSell) * 200 / 10000, "sell fee stopped below floor");
        assertGt(feeSell, 0);

        // Buy: burn 0, fee exactly 2% of USDC input.
        uint256 deadBefore2 = mock.balanceOf(DEAD);
        uint256 collectorBefore2 = usdc.balanceOf(address(collector));
        _swap(key, !musnIsC0, int256(100 * 1e6), 0);
        assertEq(mock.balanceOf(DEAD) - deadBefore2, 0, "buy burn should be 0 below floor");
        assertEq(usdc.balanceOf(address(collector)) - collectorBefore2, 100 * 1e6 * 200 / 10000, "buy fee stopped below floor");
        assertEq(hook.BURN_BPS(), 100);
    }

    // ---- collector access control ----

    function test_CollectorWithdrawAccessControl() public {
        // ERC-20 withdrawal: non-owner reverts, owner succeeds.
        usdc.transfer(address(collector), 50 * 1e6);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(MuseLinuFeeCollector.OnlyOwner.selector);
        collector.withdraw(address(usdc), 1 * 1e6);

        uint256 ownerBefore = usdc.balanceOf(address(this));
        collector.withdraw(address(usdc), 50 * 1e6);
        assertEq(usdc.balanceOf(address(this)) - ownerBefore, 50 * 1e6, "owner ERC-20 withdraw failed");
        assertEq(usdc.balanceOf(address(collector)), 0);

        // Native withdrawal: non-owner reverts, owner succeeds.
        vm.deal(address(collector), 1 ether);
        vm.prank(attacker);
        vm.expectRevert(MuseLinuFeeCollector.OnlyOwner.selector);
        collector.withdraw(address(0), 0.5 ether);

        uint256 ethBefore = address(this).balance;
        collector.withdraw(address(0), 1 ether);
        assertEq(address(this).balance - ethBefore, 1 ether, "owner native withdraw failed");
        assertEq(address(collector).balance, 0);
        assertEq(collector.owner(), address(this));
    }

    // ---- hook safety ----

    function test_HookRejectsWrongPool() public {
        (MuseLinuHook hook, PoolKey memory key) = _deployHook(address(token), address(usdc));
        // A different pool (different fee) must revert with WrongPool.
        PoolKey memory otherKey = PoolKey({
            currency0: key.currency0,
            currency1: key.currency1,
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -100,
            sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        vm.expectRevert(MuseLinuHook.WrongPool.selector);
        hook.beforeSwap(address(this), otherKey, params, new bytes(0));
    }

    function test_HookFlagsEnforced() public {
        // Deploying the hook at an unmined address (no 0xCC flags) must
        // revert in the constructor's validateHookPermissions check.
        vm.expectRevert();
        new MuseLinuHook(manager, address(token), address(usdc), address(collector), POOL_FEE, TICK_SPACING);
    }
}
