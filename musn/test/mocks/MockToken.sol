// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only MUSN-shaped token with a configurable mint, for the
/// burn-floor tests. The real MuseLinuToken always mints 25T, which can
/// never reach the 12.5T floor in a test, so the floor branches are proven
/// against this mock (same 9 decimals, same interface).
contract MockToken is ERC20 {
    constructor(address to, uint256 amount) ERC20("Mock MUSN", "MUSN") {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 9;
    }
}
