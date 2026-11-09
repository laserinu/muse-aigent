// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPoolInitializer_v4} from "@uniswap/v4-periphery/src/interfaces/IPoolInitializer_v4.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MuseLinuToken} from "../src/MuseLinuToken.sol";
import {MuseLinuFeeCollector} from "../src/MuseLinuFeeCollector.sol";
import {MuseLinuHook} from "../src/MuseLinuHook.sol";

/// @title Build MUSN mainnet deploy calldata (NO broadcast, NO state writes)
/// @notice Recomputes every deploy tx for one chain from the ground salts and
/// the deploy preview, asserts the CREATE2 addresses match the preview
/// exactly, and writes tools/deploy-<chain>.json with the ordered tx list.
/// Env: MUSN_CHAIN, MUSN_TOKEN_SALT, MUSN_COLLECTOR_SALT, MUSN_HOOK_SALT,
/// MUSN_HOOK_ADDR (expected, checksummed), MUSN_DEADLINE (uint256, unix).
contract BuildDeployCalldata is Script {
    address constant AGENT = 0x0A1D2730f4Ae736Bac3D772FaB8607BFd7F650C4;
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint256 constant MUSN_AMOUNT = 25_000_000_000_000 * 1e9; // 25T, 9 dec
    uint24 constant POOL_FEE = 3000;
    int24 constant TICK_SPACING = 60;

    struct ChainCfg {
        address poolManager;
        address positionManager;
        address quote; // address(0) = native
        uint256 seedQuote;
        bool fullRange;
    }

    function _cfg(string memory chain) internal pure returns (ChainCfg memory) {
        if (keccak256(bytes(chain)) == keccak256(bytes("base"))) {
            return ChainCfg({
                poolManager: 0x498581fF718922c3f8e6A244956aF099B2652b2b,
                positionManager: 0x7C5f5A4bBd8fD63184577525326123B519429bDc,
                quote: 0x4200000000000000000000000000000000000006,
                seedQuote: 118_700_000_000_000,
                fullRange: false
            });
        } else if (keccak256(bytes(chain)) == keccak256(bytes("polygon"))) {
            return ChainCfg({
                poolManager: 0x67366782805870060151383F4BbFF9daB53e5cD6,
                positionManager: 0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9,
                quote: address(0),
                seedQuote: 1_980_000_000_000_000_000,
                fullRange: false
            });
        } else if (keccak256(bytes(chain)) == keccak256(bytes("arc"))) {
            return ChainCfg({
                poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
                positionManager: 0x6049c9a0e26405C0985f9E3685C87d0aE917f82B,
                quote: 0x3600000000000000000000000000000000000000, // real Arc USDC
                seedQuote: 250_000,
                fullRange: false
            });
        } else if (keccak256(bytes(chain)) == keccak256(bytes("robinhood"))) {
            return ChainCfg({
                poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
                positionManager: 0x58daec3116aae6D93017bAAea7749052E8a04fA7,
                quote: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
                seedQuote: 118_700_000_000_000,
                fullRange: true
            });
        }
        revert("unknown chain");
    }

    function _create2(address factory, bytes32 salt, bytes memory initCode) internal pure returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), factory, salt, keccak256(initCode)));
        return address(uint160(uint256(h)));
    }

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

    function _seedSqrtPrice(address token, address quote, uint256 seedQuote) internal pure returns (uint160) {
        return token < quote ? _sqrtPriceX96(seedQuote, MUSN_AMOUNT) : _sqrtPriceX96(MUSN_AMOUNT, seedQuote);
    }

    function _tickRange(ChainCfg memory cfg, address token, address quote)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        if (cfg.fullRange) return (-887220, 887220);
        uint160 sqrtPriceX96 = _seedSqrtPrice(token, quote, cfg.seedQuote);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
        return (_floorToSpacing(tick - 2220, TICK_SPACING), _ceilToSpacing(tick + 2220, TICK_SPACING));
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

    function _hexAddr(address a) internal pure returns (string memory) {
        bytes memory b = abi.encodePacked(a);
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            out[2 + i * 2] = hexChars[uint8(b[i] >> 4)];
            out[3 + i * 2] = hexChars[uint8(b[i] & 0x0f)];
        }
        return string(out);
    }

    function _hexBytes(bytes memory data) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; i++) {
            out[2 + i * 2] = hexChars[uint8(data[i] >> 4)];
            out[3 + i * 2] = hexChars[uint8(data[i] & 0x0f)];
        }
        return string(out);
    }

    function _uintStr(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    struct Addrs {
        address token;
        address collector;
        address hook;
    }

    struct PoolParams {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtPriceX96;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
    }

    function _deployAddrs(ChainCfg memory cfg, bytes32 tokenSalt, bytes32 collectorSalt, bytes32 hookSalt, address expectedHook)
        internal
        returns (Addrs memory a)
    {
        bytes memory tokenInit = abi.encodePacked(type(MuseLinuToken).creationCode, abi.encode(AGENT));
        a.token = _create2(ARACHNID, tokenSalt, tokenInit);
        require(a.token == 0x0000000fC9a3c921cA909D84aE404A9ccaeF4479, "token addr mismatch vs preview");

        bytes memory collectorInit =
            abi.encodePacked(type(MuseLinuFeeCollector).creationCode, abi.encode(AGENT));
        a.collector = _create2(ARACHNID, collectorSalt, collectorInit);
        require(a.collector == 0x0000000F64352EB1BAcEf4D9d5cae00F505A149E, "collector addr mismatch vs preview");

        bytes memory hookArgs = abi.encode(
            IPoolManager(cfg.poolManager), a.token, cfg.quote, a.collector, POOL_FEE, TICK_SPACING
        );
        bytes memory hookInit = abi.encodePacked(type(MuseLinuHook).creationCode, hookArgs);
        a.hook = _create2(ARACHNID, hookSalt, hookInit);
        require(a.hook == expectedHook, "hook addr mismatch vs preview");
        require(uint160(a.hook) & 0x3fff == 0xCC, "hook flags not 0xCC");
        return a;
    }

    function _poolParams(ChainCfg memory cfg, address token, address hook) internal pure returns (PoolParams memory p) {
        bool isNative = cfg.quote == address(0);
        (Currency c0, Currency c1) = token < cfg.quote
            ? (Currency.wrap(token), Currency.wrap(cfg.quote))
            : (Currency.wrap(cfg.quote), Currency.wrap(token));
        p.key = PoolKey({
            currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(hook)
        });
        (p.tickLower, p.tickUpper) = _tickRange(cfg, token, cfg.quote);
        p.sqrtPriceX96 = _seedSqrtPrice(token, cfg.quote, cfg.seedQuote);
        (p.amount0, p.amount1) = token < cfg.quote
            ? (MUSN_AMOUNT, cfg.seedQuote)
            : (cfg.seedQuote, MUSN_AMOUNT);
        p.liquidity = LiquidityAmounts.getLiquidityForAmounts(
            p.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(p.tickLower),
            TickMath.getSqrtPriceAtTick(p.tickUpper),
            p.amount0,
            p.amount1
        );
        require(p.liquidity > 0, "zero seed liquidity");
        isNative; // silence unused warning (native handled by caller)
    }

    function run() external {
        string memory chain = vm.envString("MUSN_CHAIN");
        ChainCfg memory cfg = _cfg(chain);
        bytes32 tokenSalt = vm.envBytes32("MUSN_TOKEN_SALT");
        bytes32 collectorSalt = vm.envBytes32("MUSN_COLLECTOR_SALT");
        bytes32 hookSalt = vm.envBytes32("MUSN_HOOK_SALT");
        address expectedHook = vm.envAddress("MUSN_HOOK_ADDR");
        uint256 deadline = vm.envUint("MUSN_DEADLINE");

        Addrs memory a = _deployAddrs(cfg, tokenSalt, collectorSalt, hookSalt, expectedHook);
        PoolParams memory p = _poolParams(cfg, a.token, a.hook);
        string memory json = _buildJson(chain, cfg, a, p, deadline);
        string memory outPath = string.concat("tools/deploy-", chain, ".json");
        vm.writeJson(json, outPath);
        console.log("wrote", outPath);
        console.log("token:", a.token);
        console.log("collector:", a.collector);
        console.log("hook:", a.hook);
        console.log("sqrtPriceX96:", p.sqrtPriceX96);
        console.log("liquidity:", p.liquidity);
    }

    function _buildJson(string memory chain, ChainCfg memory cfg, Addrs memory a, PoolParams memory p, uint256 deadline)
        internal
        returns (string memory)
    {
        bool isNative = cfg.quote == address(0);
        string memory txs = "[";
        txs = string.concat(
            txs, _txJson("deploy-token", ARACHNID, 0, abi.encodePacked(vm.envBytes32("MUSN_TOKEN_SALT"), _tokenInit()))
        );
        txs = string.concat(
            txs,
            ",",
            _txJson("deploy-collector", ARACHNID, 0, abi.encodePacked(vm.envBytes32("MUSN_COLLECTOR_SALT"), _collectorInit()))
        );
        txs = string.concat(
            txs,
            ",",
            _txJson("deploy-hook", ARACHNID, 0, abi.encodePacked(vm.envBytes32("MUSN_HOOK_SALT"), _hookInit(cfg, a)))
        );
        if (!isNative && cfg.quote != 0x3600000000000000000000000000000000000000) {
            txs = string.concat(
                txs,
                ",",
                _txJson("wrap-weth", cfg.quote, cfg.seedQuote, abi.encodeWithSignature("deposit()"))
            );
        }
        txs = string.concat(
            txs,
            ",",
            _txJson(
                "approve-musn-permit2",
                a.token,
                0,
                abi.encodeWithSelector(IERC20.approve.selector, PERMIT2, MUSN_AMOUNT)
            )
        );
        if (!isNative) {
            txs = string.concat(
                txs,
                ",",
                _txJson(
                    "approve-quote-permit2",
                    cfg.quote,
                    0,
                    abi.encodeWithSelector(IERC20.approve.selector, PERMIT2, cfg.seedQuote)
                )
            );
        }
        txs = string.concat(
            txs,
            ",",
            _txJson(
                "permit2-approve-musn",
                PERMIT2,
                0,
                abi.encodeWithSelector(
                    IAllowanceTransfer.approve.selector, a.token, cfg.positionManager, uint160(MUSN_AMOUNT), type(uint48).max
                )
            )
        );
        if (!isNative) {
            txs = string.concat(
                txs,
                ",",
                _txJson(
                    "permit2-approve-quote",
                    PERMIT2,
                    0,
                    abi.encodeWithSelector(
                        IAllowanceTransfer.approve.selector,
                        cfg.quote,
                        cfg.positionManager,
                        uint160(cfg.seedQuote),
                        type(uint48).max
                    )
                )
            );
        }
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(IPoolInitializer_v4.initializePool.selector, p.key, p.sqrtPriceX96);
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] = abi.encode(
            p.key, p.tickLower, p.tickUpper, p.liquidity, uint128(p.amount0), uint128(p.amount1), AGENT, bytes("")
        );
        mintParams[1] = abi.encode(p.key.currency0, p.key.currency1);
        calls[1] = abi.encodeWithSelector(
            IPositionManager.modifyLiquidities.selector, abi.encode(actions, mintParams), deadline
        );
        bytes memory multicallData = abi.encodeWithSignature("multicall(bytes[])", calls);
        txs = string.concat(
            txs,
            ",",
            _txJson("seed-multicall", cfg.positionManager, isNative ? cfg.seedQuote : 0, multicallData)
        );
        txs = string.concat(txs, "]");

        string memory json = "{";
        json = string.concat(json, '"chain":"', chain, '",');
        json = string.concat(json, '"token":"', _hexAddr(a.token), '",');
        json = string.concat(json, '"collector":"', _hexAddr(a.collector), '",');
        json = string.concat(json, '"hook":"', _hexAddr(a.hook), '",');
        json = string.concat(json, '"poolManager":"', _hexAddr(cfg.poolManager), '",');
        json = string.concat(json, '"positionManager":"', _hexAddr(cfg.positionManager), '",');
        json = string.concat(json, '"quote":"', _hexAddr(cfg.quote), '",');
        json = string.concat(json, '"isNative":', isNative ? "true" : "false", ",");
        json = string.concat(json, '"seedQuote":"', _uintStr(cfg.seedQuote), '",');
        json = string.concat(json, '"sqrtPriceX96":"', _uintStr(p.sqrtPriceX96), '",');
        json = string.concat(json, '"tickLower":', vm.toString(int256(p.tickLower)), ",");
        json = string.concat(json, '"tickUpper":', vm.toString(int256(p.tickUpper)), ",");
        json = string.concat(json, '"liquidity":"', _uintStr(p.liquidity), '",');
        json = string.concat(json, '"deadline":"', _uintStr(deadline), '",');
        json = string.concat(json, '"txs":', txs, "}");
        return json;
    }

    function _tokenInit() internal returns (bytes memory) {
        return abi.encodePacked(type(MuseLinuToken).creationCode, abi.encode(AGENT));
    }

    function _collectorInit() internal returns (bytes memory) {
        return abi.encodePacked(type(MuseLinuFeeCollector).creationCode, abi.encode(AGENT));
    }

    function _hookInit(ChainCfg memory cfg, Addrs memory a) internal returns (bytes memory) {
        bytes memory hookArgs = abi.encode(
            IPoolManager(cfg.poolManager), a.token, cfg.quote, a.collector, POOL_FEE, TICK_SPACING
        );
        return abi.encodePacked(type(MuseLinuHook).creationCode, hookArgs);
    }

    function _txJson(string memory step, address to, uint256 value, bytes memory data)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '{"step":"',
            step,
            '","to":"',
            _hexAddr(to),
            '","value":"',
            _uintStr(value),
            '","data":"',
            _hexBytes(data),
            '"}'
        );
    }
}
