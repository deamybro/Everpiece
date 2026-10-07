// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @title TestYieldVault
/// @notice TESTNET-ONLY, SIMULATED yield: an ERC-4626 vault over testnet AUSD with no strategy. Its "yield" is test AUSD
///         sent straight to the vault (by the test stack's operator), which raises the share price exactly as interest
///         would. It exists because Aave V3 has no Monad testnet deployment (docs/EARN.md); it has the same surface as
///         the mainnet vault (ERC-4626 + ERC-2612 permit on shares) so EverpieceEarn runs unchanged.
/// @dev No owner, nothing can move a depositor's assets except their own withdraw/redeem. `_decimalsOffset` = 6 makes
///      first-depositor share inflation uneconomic. Never deploy to mainnet.
contract TestYieldVault is ERC4626, ERC20Permit {
    constructor(IERC20 ausd)
        ERC20("Test Yield Vault (SIMULATED)", "tYV-SIM")
        ERC20Permit("Test Yield Vault (SIMULATED)")
        ERC4626(ausd)
    {}

    function decimals() public view override(ERC20, ERC4626) returns (uint8) {
        return super.decimals();
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
