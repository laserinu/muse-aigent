// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MuseLinu (MUSN)
/// @notice Fixed-supply ERC-20 for Muse, the personal AI agent of 0xlinu.
/// @dev 25 trillion tokens per chain, 9 decimals. The entire per-chain supply
/// is minted once to the initial holder (the Privy agent wallet) at
/// construction. No mint, no burn, no owner controls, no transfer tax — a
/// plain ERC-20, so ordinary transfers are untaxed and scanners / sniper
/// gates see no tax-token flags. The same init code (same holder) is deployed
/// via CREATE2 (Arachnid proxy) on Base, Polygon, Arc and Robinhood Chain,
/// so the token address is identical on all four chains.
contract MuseLinuToken is ERC20 {
    uint8 private constant _DECIMALS = 9;

    /// @notice Maximum (and total) supply per chain, in base units:
    /// 25T tokens * 10^9. The 100T total is the sum across the four chains.
    uint256 public constant MAX_SUPPLY = 25_000_000_000_000 * 10 ** _DECIMALS;

    constructor(address initialHolder) ERC20("MuseLinu", "MUSN") {
        _mint(initialHolder, MAX_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }
}
