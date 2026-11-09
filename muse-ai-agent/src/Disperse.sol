// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal batch distributor: pushes ERC-20 to many recipients in one call.
/// @dev No claim step. Caller must have funded this contract with the token first.
contract Disperse {
    function disperse(address token, address[] calldata recipients, uint256[] calldata amounts) external {
        require(recipients.length == amounts.length, "len");
        for (uint256 i; i < recipients.length; ++i) {
            IERC20(token).transfer(recipients[i], amounts[i]);
        }
    }
}
