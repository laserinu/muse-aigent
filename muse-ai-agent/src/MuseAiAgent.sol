// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Muse Ai Agent (MUSE)
/// @notice Fixed-supply ERC-20 for Muse, the personal AI agent of 0xlinu, on Arc.
/// @dev 100 trillion tokens, 9 decimals. The entire supply is minted to the
/// deployer at construction. No mint, no burn, no owner controls.
contract MuseAiAgent is ERC20 {
    uint8 private constant _DECIMALS = 9;

    /// @notice Maximum (and total) supply in base units: 100T tokens * 10^9.
    uint256 public constant MAX_SUPPLY = 100_000_000_000_000 * 10 ** _DECIMALS;

    constructor() ERC20("Muse Ai Agent", "MUSE") {
        _mint(msg.sender, MAX_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }
}
