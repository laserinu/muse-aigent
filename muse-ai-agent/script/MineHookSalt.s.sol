// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {MuseFeeHook} from "../src/MuseFeeHook.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

/// @notice Mines the MuseFeeHook CREATE2 salt for MAINNET (deployer = Arachnid
/// factory, flags 0x44). Pure local computation — no broadcast, no RPC.
/// Run: forge script script/MineHookSalt.s.sol
contract MineHookSalt is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ARACHNID = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant TOKEN = 0xd1242aEcA57Cb80f9067800F2f43D78cc3F8D198;
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        bytes memory creationCode = type(MuseFeeHook).creationCode;
        bytes memory constructorArgs = abi.encode(
            IPoolManager(POOL_MANAGER), TOKEN, USDC, uint24(3000), int24(60)
        );
        uint160 flags = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        (address hookAddr, bytes32 salt) = HookMiner.find(ARACHNID, flags, creationCode, constructorArgs);
        console.log("hook:", hookAddr);
        console.logBytes32(salt);
        require(uint160(hookAddr) & 0x3fff == 0x44, "hook flags not 0x44");
        bytes memory initCode = abi.encodePacked(creationCode, constructorArgs);
        bytes32 initHash = keccak256(initCode);
        address computed = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), ARACHNID, salt, initHash))))
        );
        console.log("computed:", computed);
        require(computed == hookAddr, "create2 mismatch");
    }
}
