// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OnchainSettlement} from "../OnchainSettlement.sol";

/// @dev Test-only token that attempts to re-enter `fill` from inside `transferFrom`.
/// Used to prove that `ReentrancyGuard` on the settlement contract holds.
///
/// NOT FOR PRODUCTION USE.
contract ReentrantERC20 is ERC20 {
    OnchainSettlement public settlement;
    uint256 public targetOrderId;
    uint256 public attackAmount;
    bool private _attacking;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the next `transferFrom` to re-enter `settlement.fill`.
    function arm(address settlement_, uint256 orderId, uint256 amount) external {
        settlement = OnchainSettlement(settlement_);
        targetOrderId = orderId;
        attackAmount = amount;
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        returns (bool)
    {
        bool ok = super.transferFrom(from, to, value);

        if (!_attacking && address(settlement) != address(0)) {
            _attacking = true;
            settlement.fill(targetOrderId, attackAmount);
            _attacking = false;
        }

        return ok;
    }
}
