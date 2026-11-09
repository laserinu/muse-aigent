// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MuseAiAgent} from "../src/MuseAiAgent.sol";
import {MerkleDistributor} from "../src/MerkleDistributor.sol";

contract MerkleGasTest is Test {
    function testGasDeployMerkle() public {
        uint256 before = gasleft();
        new MerkleDistributor(address(0x1234), bytes32(uint256(0xabcd)));
        emit log_named_uint("gas_deploy_merkle", before - gasleft());
    }

    function testGasFundTransfer() public {
        MuseAiAgent token = new MuseAiAgent();
        address d = address(new MerkleDistributor(address(token), bytes32(uint256(0xabcd))));
        uint256 before = gasleft();
        token.transfer(d, 4_838_000_000_000);
        emit log_named_uint("gas_fund_transfer", before - gasleft());
    }
}
