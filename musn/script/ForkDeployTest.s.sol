// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPoolInitializer_v4} from "@uniswap/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MuseLinuToken} from "../src/MuseLinuToken.sol";
import {MuseLinuFeeCollector} from "../src/MuseLinuFeeCollector.sol";
import {MuseLinuHook} from "../src/MuseLinuHook.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {SwapHelper} from "./SwapHelper.sol";
import {NativeSwapHelper} from "./NativeSwapHelper.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title MUSN fork deploy + test
/// @notice Deploys MuseLinu + FeeCollector + hook on a local anvil fork of a
/// real chain (via the Arachnid CREATE2 proxy), creates the V4 pool, seeds
/// 100% of the 25T supply + $0.25 of quote, runs a buy and a sell through a
/// swap helper, and verifies the 2% fee + 1% burn with exact numbers.
/// @dev Run per chain against a local anvil fork (low gas price so the
/// agent's fork balance covers the deploys):
///   anvil --fork-url <rpc> --gas-price 1000000000 --port 8545 &
///   MUSN_CHAIN=base forge script script/ForkDeployTest.s.sol \
///     --fork-url http://localhost:8545 --sender 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4 \
///     --unlocked --broadcast
/// Env: MUSN_CHAIN (base|polygon|arc|robinhood, required),
/// MUSN_TOKEN_SALT / MUSN_COLLECTOR_SALT (bytes32 hex, default 0 = mechanics
/// test; pass the ground salts for the vanity run).
/// Arc uses MockUSDC on the fork (the real Arc USDC moves balances through
/// system precompiles anvil cannot emulate); mainnet uses the real USDC.
contract ForkDeployTest is Script {
    address constant AGENT = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4;
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant WPOL = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270; // Polygon WPOL (verified onchain: "Wrapped Polygon Ecosystem Token" / WPOL)

    uint256 constant MUSN_AMOUNT = 25_000_000_000_000 * 1e9; // 25T, 9 dec
    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;

    struct ChainCfg {
        address poolManager;
        address positionManager;
        address quote; // address(0) = native
        uint256 seedQuote;
        bool fullRange;
        bool useMockUSDC;
    }

    struct Deploy {
        address token;
        address collector;
        address hook;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        address quote;
        bool isNative;
    }

    function _cfg(string memory chain) internal pure returns (ChainCfg memory) {
        if (keccak256(bytes(chain)) == keccak256(bytes("base"))) {
            return ChainCfg({
                poolManager: 0x498581fF718922c3f8e6A244956aF099B2652b2b,
                positionManager: 0x7C5f5A4bBd8fD63184577525326123B519429bDc,
                quote: 0x4200000000000000000000000000000000000006, // WETH
                seedQuote: 118_700_000_000_000, // 0.0001187 ETH
                fullRange: false,
                useMockUSDC: false
            });
        } else if (keccak256(bytes(chain)) == keccak256(bytes("polygon"))) {
            return ChainCfg({
                poolManager: 0x67366782805870060151383F4BbFF9daB53e5cD6,
                positionManager: 0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9,
                quote: 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270, // WPOL (was native POL; Polygon pools standardly use WPOL — report §13)
                seedQuote: 1_980_000_000_000_000_000, // 1.98 WPOL
                fullRange: false,
                useMockUSDC: false
            });
        } else if (keccak256(bytes(chain)) == keccak256(bytes("arc"))) {
            return ChainCfg({
                poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
                positionManager: 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B,
                quote: address(0), // replaced by MockUSDC below
                seedQuote: 250_000, // 0.25 USDC, 6 dec
                fullRange: false,
                useMockUSDC: true
            });
        } else if (keccak256(bytes(chain)) == keccak256(bytes("robinhood"))) {
            return ChainCfg({
                poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
                positionManager: 0x58daec3116aae6D93017bAAea7749052E8a04fA7,
                quote: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73, // WETH
                seedQuote: 118_700_000_000_000, // 0.0001187 ETH
                fullRange: true,
                useMockUSDC: false
            });
        }
        revert("unknown chain");
    }

    function run() external {
        string memory chain = vm.envString("MUSN_CHAIN");
        ChainCfg memory cfg = _cfg(chain);
        bytes32 tokenSalt = vm.envOr("MUSN_TOKEN_SALT", bytes32(0));
        bytes32 collectorSalt = vm.envOr("MUSN_COLLECTOR_SALT", bytes32(0));

        // Fund the agent on the fork so the deploys + seed are covered.
        vm.deal(AGENT, 100 ether);
        vm.startBroadcast(AGENT);

        Deploy memory d = _deploy(cfg, tokenSalt, collectorSalt);
        _seed(cfg, d);
        _testSwaps(cfg, d);
        _automationDryRun(cfg, d);

        // ---- collector withdraw (owner only) ----
        uint256 collectorBal =
            d.isNative ? address(d.collector).balance : IERC20(d.quote).balanceOf(d.collector);
        console.log("collector balance before withdraw:", collectorBal);
        if (collectorBal > 0) {
            uint256 before = d.isNative ? AGENT.balance : IERC20(d.quote).balanceOf(AGENT);
            MuseLinuFeeCollector(payable(d.collector)).withdraw(d.quote, collectorBal);
            uint256 after_ = d.isNative ? AGENT.balance : IERC20(d.quote).balanceOf(AGENT);
            console.log("collector withdraw received by agent:", after_ - before);
            require(after_ - before == collectorBal, "withdraw short");
        }

        console.log("FORK TEST DONE:", chain);
        vm.stopBroadcast();
    }

    /// @notice Deploys token + collector + hook (Arachnid CREATE2) and builds
    /// the pool key + tick range. Returns everything the seed step needs.
    function _deploy(ChainCfg memory cfg, bytes32 tokenSalt, bytes32 collectorSalt)
        internal
        returns (Deploy memory d)
    {
        address quote = cfg.quote;
        if (cfg.useMockUSDC) {
            MockUSDC mock = new MockUSDC();
            quote = address(mock);
            console.log("mockUSDC:", quote);
        } else if (quote != address(0)) {
            // WETH chains: wrap the seed ETH plus the buy-test amount (10%
            // of the seed), so the agent still holds the buy funds after the
            // seed consumes the full seedQuote.
            uint256 wrapAmount = cfg.seedQuote + cfg.seedQuote / 10;
            IWETH(quote).deposit{value: wrapAmount}();
            console.log("wrapped WETH (seed + buy):", wrapAmount);
        }
        d.isNative = quote == address(0);
        d.quote = quote;

        bytes memory tokenInit = abi.encodePacked(type(MuseLinuToken).creationCode, abi.encode(AGENT));
        d.token = _arachnidDeploy(tokenSalt, tokenInit);
        console.log("token:", d.token);
        require(IERC20(d.token).balanceOf(AGENT) == MUSN_AMOUNT, "token mint wrong");

        bytes memory collectorInit =
            abi.encodePacked(type(MuseLinuFeeCollector).creationCode, abi.encode(AGENT));
        d.collector = _arachnidDeploy(collectorSalt, collectorInit);
        console.log("collector:", d.collector);
        require(MuseLinuFeeCollector(payable(d.collector)).owner() == AGENT, "collector owner wrong");

        bytes memory hookCreation = type(MuseLinuHook).creationCode;
        bytes memory hookArgs = abi.encode(
            IPoolManager(cfg.poolManager), d.token, quote, d.collector, POOL_FEE, TICK_SPACING
        );
        d.hook = _deployHook(cfg.poolManager, hookCreation, hookArgs);

        (Currency c0, Currency c1) = d.token < quote
            ? (Currency.wrap(d.token), Currency.wrap(quote))
            : (Currency.wrap(quote), Currency.wrap(d.token));
        d.key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(d.hook)
        });
        (d.tickLower, d.tickUpper) = _tickRange(cfg, d.token, quote);
        console.log("tickLower:", d.tickLower);
        console.log("tickUpper:", d.tickUpper);
    }

    /// @notice Mines the hook salt (flags 0xCC) and deploys the hook via
    /// Arachnid. Returns the hook address.
    function _deployHook(address poolManager, bytes memory hookCreation, bytes memory hookArgs)
        internal
        returns (address hook)
    {
        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddr, bytes32 hookSalt) = HookMiner.find(ARACHNID, flags, hookCreation, hookArgs);
        console.log("hook:", hookAddr);
        console.logBytes32(hookSalt);
        require(uint160(hookAddr) & 0x3fff == 0xCC, "hook flags not 0xCC");
        hook = _arachnidDeploy(hookSalt, abi.encodePacked(hookCreation, hookArgs));
        require(hook == hookAddr, "hook addr mismatch");
    }

    /// @notice Concentrated range (+/-2220 ticks around the seed tick) or
    /// full range for Robinhood. Returns (tickLower, tickUpper).
    function _tickRange(ChainCfg memory cfg, address token, address quote)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        if (cfg.fullRange) {
            return (-887220, 887220);
        }
        uint160 sqrtPriceX96 = _seedSqrtPrice(token, quote, cfg.seedQuote);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        return (_floorToSpacing(tick - 2220, TICK_SPACING), _ceilToSpacing(tick + 2220, TICK_SPACING));
    }

    /// @notice sqrtPriceX96 for the seed ratio, from the actual currency order.
    function _seedSqrtPrice(address token, address quote, uint256 seedQuote) internal pure returns (uint160) {
        return token < quote
            ? _sqrtPriceX96(seedQuote, MUSN_AMOUNT)
            : _sqrtPriceX96(MUSN_AMOUNT, seedQuote);
    }

    /// @notice Seeds 100% of the supply + the quote via PositionManager
    /// multicall (initialize + mint). Native quotes send value.
    function _seed(ChainCfg memory cfg, Deploy memory d) internal {
        uint160 sqrtPriceX96 = _seedSqrtPrice(d.token, d.quote, cfg.seedQuote);
        console.log("sqrtPriceX96:", sqrtPriceX96);
        (uint256 amount0, uint256 amount1) = d.token < d.quote
            ? (MUSN_AMOUNT, cfg.seedQuote)
            : (cfg.seedQuote, MUSN_AMOUNT);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(d.tickLower),
            TickMath.getSqrtPriceAtTick(d.tickUpper),
            amount0,
            amount1
        );
        console.log("seed liquidity:", liquidity);

        if (!d.isNative) {
            IERC20(d.token).approve(PERMIT2, MUSN_AMOUNT);
            IERC20(d.quote).approve(PERMIT2, cfg.seedQuote);
            IPermit2(PERMIT2).approve(d.token, cfg.positionManager, uint160(MUSN_AMOUNT), type(uint48).max);
            IPermit2(PERMIT2).approve(d.quote, cfg.positionManager, uint160(cfg.seedQuote), type(uint48).max);
        } else {
            IERC20(d.token).approve(PERMIT2, MUSN_AMOUNT);
            IPermit2(PERMIT2).approve(d.token, cfg.positionManager, uint160(MUSN_AMOUNT), type(uint48).max);
        }

        IPositionManager pm = IPositionManager(cfg.positionManager);
        uint256 positionTokenId = pm.nextTokenId();
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(IPoolInitializer_v4.initializePool.selector, d.key, sqrtPriceX96);
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] = abi.encode(
            d.key, d.tickLower, d.tickUpper, liquidity, uint128(amount0), uint128(amount1), AGENT, bytes("")
        );
        mintParams[1] = abi.encode(d.key.currency0, d.key.currency1);
        calls[1] = abi.encodeWithSelector(
            IPositionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), block.timestamp + 3600
        );
        if (d.isNative) {
            pm.multicall{value: cfg.seedQuote}(calls);
        } else {
            pm.multicall(calls);
        }
        console.log("positionTokenId:", positionTokenId);
        console.log("agent MUSN after seed:", IERC20(d.token).balanceOf(AGENT));
    }

    /// @notice Buy (10% of the seed quote) + sell (1% of the MUSN supply)
    /// through a swap helper, asserting the exact 2% fee + 1% burn on each
    /// leg. The sell is 1% of supply so its quote output is measurable even
    /// on the $0.25 Arc pool (a 1M-MUSN sell returns ~0 USDC there).
    function _testSwaps(ChainCfg memory cfg, Deploy memory d) internal {
        bool musnIsC0 = d.token < d.quote;
        uint256 quoteIn = cfg.seedQuote / 10;
        uint256 musnIn = MUSN_AMOUNT / 100; // 1% of supply = 250B MUSN
        if (d.isNative) {
            NativeSwapHelper helper = new NativeSwapHelper(IPoolManager(cfg.poolManager));
            _buyNative(helper, d.key, quoteIn, d.token, d.collector);
            _sellNative(helper, d.key, musnIn, d.token, d.collector);
        } else {
            SwapHelper helper = new SwapHelper(IPoolManager(cfg.poolManager));
            _buyERC20(helper, d.key, musnIsC0, quoteIn, d.token, d.quote, d.collector);
            _sellERC20(helper, d.key, musnIsC0, musnIn, d.token, d.quote, d.collector);
        }
    }

    /// @notice Automation dry-run: simulates accumulated fees (1.5x the $0.05
    /// threshold), then runs the approved 50/25/25 split of the collector
    /// fee — 50% stays collectable, 25% buyback-and-burn, 25% add-liquidity.
    /// @dev The $0.05 threshold is deliberately small relative to the $0.25
    /// pool: the 25% buyback ($0.0125) is only 5% of the pool's quote side,
    /// so it does not drain the pool. A $1 threshold would make the buyback
    /// equal the pool's entire quote side. The threshold should rise as the
    /// pool deepens. Prices used: ETH $2,105.74, POL $0.126156, USDC $1.
    function _automationDryRun(ChainCfg memory cfg, Deploy memory d) internal {
        uint256 threshold = _automationThreshold(cfg, d);
        uint256 simFees = (threshold * 3) / 2; // 1.5x threshold
        _fundCollectorSimFees(cfg, d, simFees);

        uint256 balance = d.isNative
            ? address(d.collector).balance
            : IERC20(d.quote).balanceOf(d.collector);
        console.log("AUTOMATION collector balance:", balance);
        console.log("AUTOMATION threshold:", threshold);
        if (balance < threshold) {
            console.log("AUTOMATION below threshold, no action");
            return;
        }
        uint256 buybackShare = balance / 4;
        uint256 addLiqShare = balance / 4;
        uint256 collectable = balance - buybackShare - addLiqShare;
        console.log("AUTOMATION collectable (50%, stays):", collectable);
        console.log("AUTOMATION buyback share (25%):", buybackShare);
        console.log("AUTOMATION add-liquidity share (25%):", addLiqShare);

        // ---- 25% buyback-and-burn: withdraw, swap quote -> MUSN, burn MUSN.
        uint256 deadBefore = IERC20(d.token).balanceOf(DEAD);
        uint256 burned = _automationBuyback(cfg, d, buybackShare);
        uint256 burnedTotal = IERC20(d.token).balanceOf(DEAD) - deadBefore;
        console.log("AUTOMATION MUSN bought + burned:", burned);
        console.log("AUTOMATION dead-balance increase:", burnedTotal);
        // The dead-balance increase EXCEEDS the buyback amount by the hook's
        // own 1% burn on the buyback swap itself (every swap burns 1% of
        // the MUSN leg): I received 99% of the core output, the hook burned
        // the other 1%, so burnedTotal = burned + burned*1/99. Both are
        // genuine burns; assert the increase is at least the buyback.
        require(burnedTotal >= burned, "buyback burn mismatch");

        // ---- 25% add-liquidity: withdraw, swap half -> MUSN, add both.
        uint256 liq = _automationAddLiquidity(cfg, d, addLiqShare);
        console.log("AUTOMATION liquidity added:", liq);

        uint256 remaining = d.isNative
            ? address(d.collector).balance
            : IERC20(d.quote).balanceOf(d.collector);
        console.log("AUTOMATION collector remaining (collectable):", remaining);
        // The automation's own swaps pay the hook's 2% fee back into the
        // collector (buyback swap on buybackShare, add-liquidity swap on
        // half of addLiqShare), so the remaining exceeds the collectable
        // by exactly those recursive fees. The collector never loses.
        uint256 recursiveFees = (buybackShare * 200) / 10000 + ((addLiqShare / 2) * 200) / 10000;
        console.log("AUTOMATION recursive fees from own swaps:", recursiveFees);
        require(remaining == collectable + recursiveFees, "collectable mismatch");
    }

    /// @notice $0.05 of fees in the quote's base units (see _automationDryRun).
    function _automationThreshold(ChainCfg memory cfg, Deploy memory d) internal pure returns (uint256) {
        if (d.isNative || d.quote == WPOL) {
            // $0.05 / $0.126156 per POL, 18 dec. (WPOL is priced 1:1 with POL;
            // the threshold is a POL-denominated amount either way.)
            return 396_300_000_000_000_000; // ~0.3963 POL
        }
        if (cfg.useMockUSDC) {
            return 50_000; // $0.05 USDC, 6 dec
        }
        // $0.05 / $2,105.74 per ETH, 18 dec.
        return 23_740_000_000_000; // ~0.00002374 ETH
    }

    /// @notice Funds the collector with simulated accumulated fees (1.5x the
    /// threshold) so the dry-run triggers. Arc: mock USDC transfer. WETH
    /// chains: wrap + transfer. Polygon: native transfer.
    function _fundCollectorSimFees(ChainCfg memory cfg, Deploy memory d, uint256 simFees) internal {
        if (d.isNative) {
            (bool ok, ) = address(d.collector).call{value: simFees}("");
            require(ok, "native fund failed");
        } else {
            if (!cfg.useMockUSDC) {
                IWETH(d.quote).deposit{value: simFees}();
            }
            IERC20(d.quote).transfer(d.collector, simFees);
        }
        console.log("AUTOMATION simulated fees funded:", simFees);
    }

    /// @notice Buyback: withdraw `amount` of quote from the collector, swap
    /// it for MUSN, and burn the MUSN to the dead address. Returns MUSN burned.
    function _automationBuyback(ChainCfg memory cfg, Deploy memory d, uint256 amount)
        internal
        returns (uint256 burned)
    {
        MuseLinuFeeCollector(payable(d.collector)).withdraw(d.quote, amount);
        bool musnIsC0 = d.token < d.quote;
        if (d.isNative) {
            NativeSwapHelper helper = new NativeSwapHelper(IPoolManager(cfg.poolManager));
            uint256 musnBefore = IERC20(d.token).balanceOf(AGENT);
            helper.swap{value: amount}(d.key, true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1, AGENT);
            burned = IERC20(d.token).balanceOf(AGENT) - musnBefore;
        } else {
            SwapHelper helper = new SwapHelper(IPoolManager(cfg.poolManager));
            IERC20(d.quote).transfer(address(helper), amount);
            uint256 musnBefore = IERC20(d.token).balanceOf(AGENT);
            helper.swap(
                d.key,
                !musnIsC0,
                -int256(amount),
                !musnIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
                AGENT
            );
            burned = IERC20(d.token).balanceOf(AGENT) - musnBefore;
        }
        IERC20(d.token).transfer(DEAD, burned);
    }

    /// @notice Add-liquidity: withdraw `amount` of quote, swap half for
    /// MUSN, and add (MUSN + remaining quote) as a new position in the seed
    /// tick range. Returns the liquidity added.
    function _automationAddLiquidity(ChainCfg memory cfg, Deploy memory d, uint256 amount)
        internal
        returns (uint128 liquidity)
    {
        MuseLinuFeeCollector(payable(d.collector)).withdraw(d.quote, amount);
        uint256 half = amount / 2;
        bool musnIsC0 = d.token < d.quote;
        uint256 musnBought;
        if (d.isNative) {
            NativeSwapHelper helper = new NativeSwapHelper(IPoolManager(cfg.poolManager));
            uint256 musnBefore = IERC20(d.token).balanceOf(AGENT);
            helper.swap{value: half}(d.key, true, -int256(half), TickMath.MIN_SQRT_PRICE + 1, AGENT);
            musnBought = IERC20(d.token).balanceOf(AGENT) - musnBefore;
        } else {
            SwapHelper helper = new SwapHelper(IPoolManager(cfg.poolManager));
            IERC20(d.quote).transfer(address(helper), half);
            uint256 musnBefore = IERC20(d.token).balanceOf(AGENT);
            helper.swap(
                d.key,
                !musnIsC0,
                -int256(half),
                !musnIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
                AGENT
            );
            musnBought = IERC20(d.token).balanceOf(AGENT) - musnBefore;
        }
        uint256 quoteLeft = amount - half;
        liquidity = _mintPosition(cfg, d, musnBought, quoteLeft);
    }

    /// @notice Mints a new concentrated position (seed tick range) with the
    /// given MUSN + quote amounts. Returns the liquidity added.
    /// @dev Liquidity is computed from the CURRENT pool price (read from
    /// PoolManager.getSlot0), not the seed price — the trades move the price,
    /// and computing from a stale price overstates the liquidity so the
    /// mint reverts MaximumAmountExceeded.
    function _mintPosition(ChainCfg memory cfg, Deploy memory d, uint256 musnAmount, uint256 quoteAmount)
        internal
        returns (uint128 liquidity)
    {
        (uint160 sqrtPriceX96, , , ) = StateLibrary.getSlot0(IPoolManager(cfg.poolManager), d.key.toId());
        (uint256 amount0, uint256 amount1) = d.token < d.quote
            ? (musnAmount, quoteAmount)
            : (quoteAmount, musnAmount);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(d.tickLower),
            TickMath.getSqrtPriceAtTick(d.tickUpper),
            amount0,
            amount1
        );
        require(liquidity > 0, "no liquidity from add-liquidity amounts");

        if (!d.isNative) {
            IERC20(d.token).approve(PERMIT2, musnAmount);
            IERC20(d.quote).approve(PERMIT2, quoteAmount);
            IPermit2(PERMIT2).approve(d.token, cfg.positionManager, uint160(musnAmount), type(uint48).max);
            IPermit2(PERMIT2).approve(d.quote, cfg.positionManager, uint160(quoteAmount), type(uint48).max);
        } else {
            IERC20(d.token).approve(PERMIT2, musnAmount);
            IPermit2(PERMIT2).approve(d.token, cfg.positionManager, uint160(musnAmount), type(uint48).max);
        }

        IPositionManager pm = IPositionManager(cfg.positionManager);
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] = abi.encode(
            d.key, d.tickLower, d.tickUpper, liquidity, uint128(amount0), uint128(amount1), AGENT, bytes("")
        );
        mintParams[1] = abi.encode(d.key.currency0, d.key.currency1);
        bytes memory actionsAndParams = abi.encode(actions, mintParams);
        if (d.isNative) {
            pm.modifyLiquidities{value: quoteAmount}(actionsAndParams, block.timestamp + 3600);
        } else {
            pm.modifyLiquidities(actionsAndParams, block.timestamp + 3600);
        }
    }

    function _buyERC20(
        SwapHelper helper,
        PoolKey memory key,
        bool musnIsC0,
        uint256 quoteIn,
        address token,
        address quote,
        address collector
    ) internal {
        IERC20(quote).transfer(address(helper), quoteIn);
        uint256 musnBefore = IERC20(token).balanceOf(AGENT);
        uint256 collectorBefore = IERC20(quote).balanceOf(collector);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        BalanceDelta d = helper.swap(
            key,
            !musnIsC0,
            -int256(quoteIn),
            !musnIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            AGENT
        );
        uint256 musnReceived = IERC20(token).balanceOf(AGENT) - musnBefore;
        uint256 fee = IERC20(quote).balanceOf(collector) - collectorBefore;
        uint256 burn = IERC20(token).balanceOf(DEAD) - deadBefore;
        console.log("BUY quoteIn:", quoteIn);
        console.log("BUY fee (expect 2% of input):", fee);
        console.log("BUY musnReceived:", musnReceived);
        console.log("BUY burn (expect 1% of core out):", burn);
        console.log("BUY delta0:", d.amount0());
        console.log("BUY delta1:", d.amount1());
        require(fee == (quoteIn * 200) / 10000, "buy fee not 2%");
        require(burn == (musnReceived + burn) / 100, "buy burn not 1%");
    }

    function _sellERC20(
        SwapHelper helper,
        PoolKey memory key,
        bool musnIsC0,
        uint256 musnIn,
        address token,
        address quote,
        address collector
    ) internal {
        IERC20(token).transfer(address(helper), musnIn);
        uint256 quoteBefore = IERC20(quote).balanceOf(AGENT);
        uint256 collectorBefore = IERC20(quote).balanceOf(collector);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        BalanceDelta d = helper.swap(
            key,
            musnIsC0,
            -int256(musnIn),
            musnIsC0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            AGENT
        );
        uint256 quoteReceived = IERC20(quote).balanceOf(AGENT) - quoteBefore;
        uint256 fee = IERC20(quote).balanceOf(collector) - collectorBefore;
        uint256 burn = IERC20(token).balanceOf(DEAD) - deadBefore;
        console.log("SELL musnIn:", musnIn);
        console.log("SELL burn (expect 1% of input):", burn);
        console.log("SELL quoteReceived:", quoteReceived);
        console.log("SELL fee (expect 2% of core out):", fee);
        console.log("SELL delta0:", d.amount0());
        console.log("SELL delta1:", d.amount1());
        require(burn == musnIn / 100, "sell burn not 1%");
        require(fee == ((quoteReceived + fee) * 200) / 10000, "sell fee not 2%");
    }

    function _buyNative(
        NativeSwapHelper helper,
        PoolKey memory key,
        uint256 quoteIn,
        address token,
        address collector
    ) internal {
        uint256 musnBefore = IERC20(token).balanceOf(AGENT);
        uint256 collectorBefore = address(collector).balance;
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        // Native is always currency0, so buying MUSN means zeroForOne = true
        // (price moves down -> limit is MIN_SQRT_PRICE + 1).
        BalanceDelta d =
            helper.swap{value: quoteIn}(key, true, -int256(quoteIn), TickMath.MIN_SQRT_PRICE + 1, AGENT);
        uint256 musnReceived = IERC20(token).balanceOf(AGENT) - musnBefore;
        uint256 fee = address(collector).balance - collectorBefore;
        uint256 burn = IERC20(token).balanceOf(DEAD) - deadBefore;
        console.log("BUY nativeIn:", quoteIn);
        console.log("BUY fee (expect 2% of input):", fee);
        console.log("BUY musnReceived:", musnReceived);
        console.log("BUY burn (expect 1% of core out):", burn);
        console.log("BUY delta0:", d.amount0());
        console.log("BUY delta1:", d.amount1());
        require(fee == (quoteIn * 200) / 10000, "buy fee not 2%");
        require(burn == (musnReceived + burn) / 100, "buy burn not 1%");
    }

    function _sellNative(
        NativeSwapHelper helper,
        PoolKey memory key,
        uint256 musnIn,
        address token,
        address collector
    ) internal {
        IERC20(token).transfer(address(helper), musnIn);
        uint256 nativeBefore = AGENT.balance;
        uint256 collectorBefore = address(collector).balance;
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        // Selling MUSN for native: input is MUSN (currency1), zeroForOne =
        // false (price moves up -> limit is MAX_SQRT_PRICE - 1).
        BalanceDelta d = helper.swap(key, false, -int256(musnIn), TickMath.MAX_SQRT_PRICE - 1, AGENT);
        uint256 nativeReceived = AGENT.balance - nativeBefore;
        uint256 fee = address(collector).balance - collectorBefore;
        uint256 burn = IERC20(token).balanceOf(DEAD) - deadBefore;
        console.log("SELL musnIn:", musnIn);
        console.log("SELL burn (expect 1% of input):", burn);
        console.log("SELL nativeReceived:", nativeReceived);
        console.log("SELL fee (expect 2% of core out):", fee);
        console.log("SELL delta0:", d.amount0());
        console.log("SELL delta1:", d.amount1());
        require(burn == musnIn / 100, "sell burn not 1%");
        require(fee == ((nativeReceived + fee) * 200) / 10000, "sell fee not 2%");
    }

    // ---- helpers ----

    /// @notice Deploys `initCode` via the Arachnid proxy (raw salt ++ initCode
    /// calldata, no selector) and returns the deployed address.
    function _arachnidDeploy(bytes32 salt, bytes memory initCode) internal returns (address) {
        (bool ok, bytes memory ret) = ARACHNID.call(abi.encodePacked(salt, initCode));
        require(ok, "arachnid deploy failed");
        require(ret.length == 20, "bad arachnid return");
        return address(bytes20(ret));
    }

    /// @notice sqrtPriceX96 = sqrt(amount1 / amount0) * 2^96.
    /// @dev Uses FullMath.mulDiv: the plain (amount1 * 2^192) overflows
    /// uint256 for MUSN's 25T supply (2.5e22 * 2^192 = 1.57e80 > 2^256).
    function _sqrtPriceX96(uint256 amount1, uint256 amount0) internal pure returns (uint160) {
        uint256 v = FullMath.mulDiv(amount1, 1 << 192, amount0);
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

    function _floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 r = tick % spacing;
        if (r == 0) return tick;
        if (tick < 0) return tick - (spacing + r);
        return tick - r;
    }

    function _ceilToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 r = tick % spacing;
        if (r == 0) return tick;
        if (tick < 0) return tick - r;
        return tick + (spacing - r);
    }
}
