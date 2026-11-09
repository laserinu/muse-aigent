// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only mock USDC (6 decimals) for the anvil fork test.
/// Arc's real USDC (0x3600...) moves balances through system precompiles
/// (0x1800...0000/0001) that anvil cannot emulate, so its transferFrom
/// reverts on the fork. This mock is a plain ERC-20 with the same 6-decimal
/// interface, used ONLY on the fork. Mainnet uses the real USDC.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (mock)", "USDC") {
        _mint(msg.sender, 1_000_000 * 10 ** 6); // 1M mock USDC to deployer
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
