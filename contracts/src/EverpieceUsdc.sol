// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAUSD} from "./interfaces/IAUSD.sol";
import {EverpieceEscrow} from "./EverpieceEscrow.sol";
import {EverpieceEarn} from "./EverpieceEarn.sol";

/// @title EverpieceEscrowUsdc
/// @notice EverpieceEscrow over Monad USDC (Circle FiatToken v2.2), so protected payments can settle in USDC.
/// @dev The ONLY difference: USDC has no `isReceiveWithAuthorizationUpgraded()` (the call reverts), so that AUSD-only
///      read is skipped. USDC's receiveWithAuthorization is payee-checked like AUSD's (fork-verified:
///      test/fork/UsdcProbe.t.sol), and the escrow's exact balance checks around every pull and payout stay.
///      The inherited `AUSD()` getter returns the USDC address on this deployment (name kept for ABI compatibility).
contract EverpieceEscrowUsdc is EverpieceEscrow {
    constructor(address usdc, address initialOwner, address initialClaimApprover)
        EverpieceEscrow(IAUSD(usdc), initialOwner, initialClaimApprover)
    {}

    function _requireVerifiedAusdReceiveSemantics() internal pure override {}
}

/// @title EverpieceEarnUsdc
/// @notice EverpieceEarn over Monad USDC: gasless deposits to verified USDC ERC-4626 vaults (e.g. Aave V3's static
///         aToken wrapper for USDC; every vault's asset() must be USDC, checked at deployment).
/// @dev Same single difference and the same reasoning as EverpieceEscrowUsdc.
contract EverpieceEarnUsdc is EverpieceEarn {
    constructor(address usdc, address[] memory vaults) EverpieceEarn(IAUSD(usdc), vaults) {}

    function _requireVerifiedAusdReceiveSemantics() internal pure override {}
}
