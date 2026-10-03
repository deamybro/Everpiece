// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of Agora's AgoraStableSwapPair that Everpiece uses, exactly as documented at
///         https://docs.agora.finance/instant-settlement/smart-contracts/pair-contract (checked 2026-10-03,
///         docs/INTEGRATION_VERIFICATION.md). Swaps require the caller to hold the APPROVED_SWAPPER role.
interface IAgoraStableSwapPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getAmountsIn(uint256 _amountOut, address[] memory _path) external view returns (uint256[] memory _amounts);
    function hasRole(string memory _role, address _address) external view returns (bool);
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Agora's testnet-only self-service whitelister ("Executing a Swap → Self-whitelisting").
interface IAgoraTestnetWhitelister {
    function setApprovedSwapper(address swapper) external;
}
