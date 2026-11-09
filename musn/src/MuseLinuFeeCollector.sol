// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MuseLinu FeeCollector
/// @notice Holds the 2% swap fee (quote currency: USDC / native / WETH) that
/// the MuseLinu hook takes on every swap through a MUSN pool. Only the owner
/// (the Privy agent wallet) can withdraw, and withdrawals always go to the
/// owner — no arbitrary recipient.
/// @dev The approved 50/25/25 split of the collected fee (50% collectable /
/// 25% auto buyback-and-burn / 25% auto add-liquidity) is policy enforced by
/// the agent-run automation job, NOT by this contract: the owner is the only
/// actor either way, so onchain split enforcement would protect against
/// nothing. The automation job withdraws only the automation share (50%) and
/// leaves the collectable share in place for the owner to withdraw.
/// Accepts native currency via receive() (Polygon POL / native ETH fees) and
/// ERC-20s (USDC / WETH fees). Same init code on all four chains, so the
/// collector address is identical everywhere via CREATE2.
contract MuseLinuFeeCollector {
    using SafeERC20 for IERC20;

    /// @notice The only wallet that can withdraw: the Privy agent wallet.
    address public immutable owner;

    /// @notice Sentinel for native currency (address(0)) in withdraw().
    address public constant NATIVE = address(0);

    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Received(address indexed token, address indexed from, uint256 amount);

    error OnlyOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _owner) {
        owner = _owner;
    }

    receive() external payable {
        emit Received(NATIVE, msg.sender, msg.value);
    }

    /// @notice Withdraw `amount` of `token` (address(0) = native) to the
    /// owner. Only the owner can call.
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (token == NATIVE) {
            (bool ok, ) = owner.call{value: amount}("");
            require(ok, "native send failed");
        } else {
            IERC20(token).safeTransfer(owner, amount);
        }
        emit Withdrawn(token, owner, amount);
    }
}
