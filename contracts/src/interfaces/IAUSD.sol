// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IAUSD
/// @notice The subset of the deployed Monad AUSD (Agora Dollar) surface that EverpieceEscrow relies on.
/// @dev Every signature here was checked against the Sourcify-verified deployed source and live reads
///      (docs/VERIFIED.md §2.3, §2.5, §2.10). Proxy 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a on chain 143.
interface IAUSD is IERC20 {
    /// @notice ERC-3009 receive: reverts `InvalidPayee` unless `to == msg.sender`; valid iff validAfter < now < validBefore.
    /// @dev Selector 0x88b7ab63 (bytes-signature overload, packed r‖s‖v). Implemented inline in the AUSD proxy.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    /// @notice True when Agora has re-routed `receiveWithAuthorization` away from the verified inline proxy code.
    /// @dev Reads bit (255 - 86) of the ERC-1967 implementation slot (VERIFIED.md §2.3, §2.10).
    function isReceiveWithAuthorizationUpgraded() external view returns (bool);
}
