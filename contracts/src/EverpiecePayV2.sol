// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAUSD} from "./interfaces/IAUSD.sol";
import {IAgoraStableSwapPair} from "./interfaces/IAgoraStableSwapPair.sol";

/// @notice The ERC-3009 receive both Monad AUSD and Monad USDC implement (packed r‖s‖v overload, payee-checked:
///         reverts unless `to == msg.sender`). USDC: contracts/test/fork/UsdcProbe.t.sol; AUSD: AusdProbe.t.sol.
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @title EverpiecePayV2
/// @notice Instant multi-asset payments (mainnet mandate: USDC and AUSD are both first-class). The recipient receives
///         EXACTLY `amount` of the `asset` the payment names, final at once. The payer funds it either
///         - DIRECT: in the same asset (USDC → USDC, AUSD → AUSD), no conversion, no pair, no third party; or
///         - CONVERTED: in the other asset through a fixed Agora Instant Settlement pair (exact-output swap straight to
///           the recipient, unused input back to the payer). If the pair can't deliver, the whole payment reverts:
///           funds are never stranded half-way.
/// @dev Gasless: a relayer submits, the payer signs ONE ERC-3009 ReceiveWithAuthorization in the source token's own
///      domain whose nonce is the payment id (EIP-712 digest of every term), so nothing can be changed or replayed.
///      No owner, no admin, no upgrade path, no arbitrary calls. Assets and pairs are fixed at deployment. Agora pairs
///      are permissioned: conversions need this contract to hold APPROVED_SWAPPER; `quote` reports when it doesn't.
contract EverpiecePayV2 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A settlement asset and whether it carries AUSD's upgrade flag (checked fail-closed before each pull).
    struct Asset {
        address token;
        bool ausdSemantics;
    }

    /// @notice What the payer agrees to.
    /// @dev DIRECT when sourceToken == asset (then maxSourceAmount must equal amount).
    struct Payment {
        bytes32 ref;
        address sender;
        address recipient;
        address asset; // what the recipient receives
        uint256 amount; // exact, in `asset` base units
        address sourceToken; // what the payer spends
        uint256 maxSourceAmount; // the most of sourceToken the payer allows (from the quote)
        uint256 deadline;
    }

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 ref,address sender,address recipient,address asset,uint256 amount,address sourceToken,uint256 maxSourceAmount,uint256 deadline)"
    );

    /// @notice 0 = not an asset, 1 = asset, 2 = asset with AUSD semantics.
    mapping(address token => uint8) public assetKind;
    /// @notice sourceToken → asset → the Agora pair that converts between them (both directions registered).
    mapping(address source => mapping(address asset => address pair)) public pairFor;
    /// @notice Payment id → settled. A signed payment executes once.
    mapping(bytes32 paymentId => bool) public settled;

    event AssetEnabled(address indexed token, bool ausdSemantics);
    event PairEnabled(address indexed tokenA, address indexed tokenB, address indexed pair);
    event Paid(
        bytes32 indexed paymentId,
        bytes32 indexed ref,
        address indexed sender,
        address recipient,
        address asset,
        uint256 amount,
        address sourceToken,
        uint256 sourceAmount,
        address pair
    );

    error ZeroAddress();
    error DuplicateAsset();
    error InvalidPair();
    error DuplicatePair();
    error InvalidRecipient();
    error ZeroAmount();
    error Expired();
    error AlreadySettled();
    error UnsupportedAsset();
    error UnsupportedRoute();
    error DirectAmountMismatch();
    error FundingMismatch();
    error SettlementMismatch();
    error AusdSemanticsChanged();

    constructor(Asset[] memory assets, address[] memory pairs) EIP712("Everpiece Pay", "2") {
        for (uint256 i = 0; i < assets.length; i++) {
            address t = assets[i].token;
            if (t == address(0)) revert ZeroAddress();
            if (assetKind[t] != 0) revert DuplicateAsset();
            assetKind[t] = assets[i].ausdSemantics ? 2 : 1;
            emit AssetEnabled(t, assets[i].ausdSemantics);
        }
        for (uint256 i = 0; i < pairs.length; i++) {
            IAgoraStableSwapPair pair = IAgoraStableSwapPair(pairs[i]);
            address t0 = pair.token0();
            address t1 = pair.token1();
            if (t0 == t1 || assetKind[t0] == 0 || assetKind[t1] == 0) revert InvalidPair();
            if (pairFor[t0][t1] != address(0)) revert DuplicatePair();
            pairFor[t0][t1] = pairs[i];
            pairFor[t1][t0] = pairs[i];
            emit PairEnabled(t0, t1, pairs[i]);
        }
    }

    /// @notice Settle a signed payment. `signature` is the sender's ERC-3009 ReceiveWithAuthorization in the
    ///         `sourceToken` domain: from = sender, to = this, value = maxSourceAmount, validAfter = 0,
    ///         validBefore = deadline, nonce = paymentIdOf(p).
    function pay(Payment calldata p, bytes calldata signature) external nonReentrant returns (bytes32 paymentId) {
        if (assetKind[p.asset] == 0) revert UnsupportedAsset();
        address pair;
        if (p.sourceToken == p.asset) {
            if (p.maxSourceAmount != p.amount) revert DirectAmountMismatch();
        } else {
            pair = pairFor[p.sourceToken][p.asset];
            if (pair == address(0)) revert UnsupportedRoute();
        }
        paymentId = _open(p);

        IERC20 source = IERC20(p.sourceToken);
        IERC20 asset = IERC20(p.asset);
        _requireVerifiedReceive(p.sourceToken);
        uint256 heldBefore = source.balanceOf(address(this));
        IERC3009Receive(p.sourceToken).receiveWithAuthorization(
            p.sender, address(this), p.maxSourceAmount, 0, p.deadline, paymentId, signature
        );
        if (source.balanceOf(address(this)) != heldBefore + p.maxSourceAmount) revert FundingMismatch();

        uint256 recipientBefore = asset.balanceOf(p.recipient);
        uint256 spent;
        if (pair == address(0)) {
            asset.safeTransfer(p.recipient, p.amount);
            spent = p.amount;
        } else {
            address[] memory path = new address[](2);
            path[0] = p.sourceToken;
            path[1] = p.asset;
            source.forceApprove(pair, p.maxSourceAmount);
            uint256[] memory amounts =
                IAgoraStableSwapPair(pair).swapTokensForExactTokens(p.amount, p.maxSourceAmount, path, p.recipient, p.deadline);
            source.forceApprove(pair, 0);
            // Return what the swap didn't use; this contract keeps nothing.
            uint256 left = source.balanceOf(address(this)) - heldBefore;
            spent = p.maxSourceAmount - left;
            if (amounts[0] != spent) revert SettlementMismatch();
            if (left > 0) source.safeTransfer(p.sender, left);
        }
        if (asset.balanceOf(p.recipient) != recipientBefore + p.amount) revert SettlementMismatch();
        emit Paid(paymentId, p.ref, p.sender, p.recipient, p.asset, p.amount, p.sourceToken, spent, pair);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function paymentIdOf(Payment calldata p) external view returns (bytes32) {
        return _id(p);
    }

    /// @notice Can `sourceToken` pay exactly `amount` of `asset` right now, and for how much (fees included)?
    ///         Never reverts: an unknown route, a pair that hasn't approved this contract, or a pair that can't
    ///         quote all return available = false (the mandate's "unavailable" state).
    function quote(address sourceToken, address asset, uint256 amount)
        external
        view
        returns (bool available, uint256 sourceAmount, address pair)
    {
        if (assetKind[asset] == 0 || assetKind[sourceToken] == 0 || amount == 0) return (false, 0, address(0));
        if (sourceToken == asset) return (true, amount, address(0));
        pair = pairFor[sourceToken][asset];
        if (pair == address(0)) return (false, 0, address(0));
        try IAgoraStableSwapPair(pair).hasRole("APPROVED_SWAPPER", address(this)) returns (bool ok) {
            if (!ok) return (false, 0, pair);
        } catch {
            return (false, 0, pair);
        }
        address[] memory path = new address[](2);
        path[0] = sourceToken;
        path[1] = asset;
        try IAgoraStableSwapPair(pair).getAmountsIn(amount, path) returns (uint256[] memory a) {
            if (a.length != 2 || a[0] == 0) return (false, 0, pair);
            return (true, a[0], pair);
        } catch {
            return (false, 0, pair);
        }
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _id(Payment calldata p) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_TYPEHASH,
                    p.ref,
                    p.sender,
                    p.recipient,
                    p.asset,
                    p.amount,
                    p.sourceToken,
                    p.maxSourceAmount,
                    p.deadline
                )
            )
        );
    }

    /// @dev Shared checks, then mark the payment settled (effects before interactions).
    function _open(Payment calldata p) private returns (bytes32 paymentId) {
        if (p.sender == address(0)) revert ZeroAddress();
        if (p.recipient == address(0) || p.recipient == address(this)) revert InvalidRecipient();
        if (p.amount == 0) revert ZeroAmount();
        if (block.timestamp >= p.deadline) revert Expired();
        paymentId = _id(p);
        if (settled[paymentId]) revert AlreadySettled();
        settled[paymentId] = true;
    }

    /// @dev AUSD: fail closed if Agora re-routed its payee-checked receive (same check as EverpieceEscrow). Assets
    ///      without that flag (USDC) rely on the balance checks around every pull and transfer.
    function _requireVerifiedReceive(address token) private view {
        if (assetKind[token] != 2) return;
        try IAUSD(token).isReceiveWithAuthorizationUpgraded() returns (bool upgraded) {
            if (upgraded) revert AusdSemanticsChanged();
        } catch {
            revert AusdSemanticsChanged();
        }
    }
}
