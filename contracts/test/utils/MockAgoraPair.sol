// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev ConstantToken stand-in: an OpenZeppelin ERC-2612 token with 18 decimals, like CTK on Monad testnet
///      (docs/INTEGRATION_VERIFICATION.md: "ConstantToken" v1 EIP-712 domain, `nonces`, simulated permit accepted).
contract MockPermitToken is ERC20Permit {
    constructor() ERC20("ConstantToken", "CTK") ERC20Permit("ConstantToken") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

/// @dev Agora AgoraStableSwapPair semantics as documented (pair-contract + swapping-fixed-output pages):
///      APPROVED_SWAPPER gate; getAmountsIn → [amountIn, amountOut] at a fixed price plus a purchase fee;
///      swapTokensForExactTokens pulls the input from msg.sender, sends exactly amountOut to `to`,
///      reverts ExcessiveInputAmount / Expired. token0 = source (18 dp), token1 = AUSD (6 dp).
contract MockAgoraPair {
    address public immutable token0;
    address public immutable token1;
    mapping(address => bool) public approvedSwapper;
    /// AUSD units per 1e18 source units, before fee. 1e6 = 1:1 like the testnet CTK/AUSD pair.
    uint256 public price = 1e6;
    uint256 public feeBps; // purchase fee on the input, in basis points
    bool public shortDeliver; // fault: send 1 unit less than amountOut

    error ExcessiveInputAmount();
    error Expired();
    error NotApprovedSwapper();
    error InvalidPath();

    constructor(address source, address ausd) {
        token0 = source;
        token1 = ausd;
    }

    function setApprovedSwapper(address s, bool ok) external {
        approvedSwapper[s] = ok;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function setFeeBps(uint256 f) external {
        feeBps = f;
    }

    function setShortDeliver(bool v) external {
        shortDeliver = v;
    }

    function hasRole(string memory role, address a) external view returns (bool) {
        return keccak256(bytes(role)) == keccak256("APPROVED_SWAPPER") && approvedSwapper[a];
    }

    function _in(uint256 amountOut) internal view returns (uint256) {
        uint256 base = (amountOut * 1e18 + price - 1) / price; // round up, like an exact-output quote must
        return base + (base * feeBps + 9_999) / 10_000;
    }

    function getAmountsIn(uint256 amountOut, address[] memory path) external view returns (uint256[] memory a) {
        if (path.length != 2 || path[0] != token0 || path[1] != token1) revert InvalidPath();
        a = new uint256[](2);
        a[0] = _in(amountOut);
        a[1] = amountOut;
    }

    function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory a)
    {
        if (!approvedSwapper[msg.sender]) revert NotApprovedSwapper();
        if (block.timestamp > deadline) revert Expired();
        if (path.length != 2 || path[0] != token0 || path[1] != token1) revert InvalidPath();
        uint256 amountIn = _in(amountOut);
        if (amountIn > amountInMax) revert ExcessiveInputAmount();
        IERC20(token0).transferFrom(msg.sender, address(this), amountIn);
        IERC20(token1).transfer(to, shortDeliver ? amountOut - 1 : amountOut);
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = amountOut;
    }
}
