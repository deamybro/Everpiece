// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAUSD} from "./interfaces/IAUSD.sol";
import {IAgoraStableSwapPair} from "./interfaces/IAgoraStableSwapPair.sol";

/// @title EverpiecePay
/// @notice Instant payments that settle in AUSD: the recipient receives EXACTLY the requested AUSD, final at once
///         (no escrow, no undo). The payer pays either in AUSD, or in a token that has an Agora Instant Settlement
///         pair with AUSD: the fixed-output swap (`swapTokensForExactTokens`) delivers the exact AUSD straight to the
///         recipient and any unused input goes back to the payer.
/// @dev Gasless: a relayer submits, the payer only signs. No owner, no admin, no upgrade path, nothing that can move
///      user funds except a payment the payer signed. Pairs are fixed at deployment. Agora pairs are permissioned:
///      this contract must hold APPROVED_SWAPPER on each pair (testnet: the public Whitelister; mainnet: Agora KYC).
///      Every payment has one id = EIP-712 digest of its terms, and settles at most once.
contract EverpiecePay is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What the payer agrees to. `sourceToken` = AUSD for a direct payment.
    /// @dev `ref` is the payment request it settles (or a fresh random id for a direct send); it is not required to be
    ///      unique on its own: the id covers every field.
    struct Payment {
        bytes32 ref;
        address sender;
        address recipient;
        uint256 amount; // AUSD the recipient receives (6 decimals)
        address sourceToken;
        uint256 maxSourceAmount; // the most of sourceToken the payer allows (from the quote)
        uint256 deadline;
    }

    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 ref,address sender,address recipient,uint256 amount,address sourceToken,uint256 maxSourceAmount,uint256 deadline)"
    );

    IAUSD public immutable AUSD;
    /// @notice Source token → its Agora AUSD pair. Set once in the constructor.
    mapping(address token => address pair) public pairFor;
    /// @notice Payment id → settled. A signed payment can be executed once.
    mapping(bytes32 paymentId => bool) public settled;

    event PairEnabled(address indexed sourceToken, address indexed pair);
    event Paid(
        bytes32 indexed paymentId,
        bytes32 indexed ref,
        address indexed sender,
        address recipient,
        uint256 amount,
        address sourceToken,
        uint256 sourceAmount,
        address pair
    );

    error ZeroAddress();
    error InvalidPair();
    error DuplicatePair();
    error InvalidRecipient();
    error ZeroAmount();
    error Expired();
    error AlreadySettled();
    error UnsupportedToken();
    error WrongSourceToken();
    error InvalidPayerSignature();
    error FundingMismatch();
    error SettlementMismatch();
    error AusdSemanticsChanged();

    constructor(IAUSD ausd, address[] memory pairs) EIP712("Everpiece Pay", "1") {
        if (address(ausd) == address(0)) revert ZeroAddress();
        AUSD = ausd;
        for (uint256 i = 0; i < pairs.length; i++) {
            IAgoraStableSwapPair pair = IAgoraStableSwapPair(pairs[i]);
            address t0 = pair.token0();
            address t1 = pair.token1();
            address source;
            if (t1 == address(ausd) && t0 != address(ausd)) source = t0;
            else if (t0 == address(ausd) && t1 != address(ausd)) source = t1;
            else revert InvalidPair();
            if (source == address(0)) revert InvalidPair();
            if (pairFor[source] != address(0)) revert DuplicatePair();
            pairFor[source] = pairs[i];
            emit PairEnabled(source, pairs[i]);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Pay in AUSD
    // ---------------------------------------------------------------------------------------------

    /// @notice One AUSD ERC-3009 ReceiveWithAuthorization signature whose nonce is the payment id, so it is bound to
    ///         every term (recipient, amount, deadline): a relayer can't change anything.
    function payWithAusd(Payment calldata p, bytes calldata ausdSignature) external nonReentrant returns (bytes32 paymentId) {
        if (p.sourceToken != address(AUSD)) revert WrongSourceToken();
        paymentId = _open(p);
        _requireVerifiedAusdReceiveSemantics();

        uint256 before = AUSD.balanceOf(address(this));
        AUSD.receiveWithAuthorization(p.sender, address(this), p.amount, 0, p.deadline, paymentId, ausdSignature);
        if (AUSD.balanceOf(address(this)) != before + p.amount) revert FundingMismatch();

        uint256 recipientBefore = AUSD.balanceOf(p.recipient);
        IERC20(address(AUSD)).safeTransfer(p.recipient, p.amount);
        if (AUSD.balanceOf(p.recipient) != recipientBefore + p.amount) revert SettlementMismatch();
        emit Paid(paymentId, p.ref, p.sender, p.recipient, p.amount, address(AUSD), p.amount, address(0));
    }

    // ---------------------------------------------------------------------------------------------
    // Pay in another token through Agora Instant Settlement
    // ---------------------------------------------------------------------------------------------

    /// @notice The payer signs the payment (EIP-712) and an ERC-2612 permit for `maxSourceAmount`. The contract pulls
    ///         that much, swaps for EXACTLY `amount` AUSD delivered to the recipient, and returns what wasn't used.
    /// @param payerSignature EIP-712 signature by `p.sender` over the Payment (the permit alone doesn't bind the recipient).
    /// @param permitDeadline,v,r,s the source token's permit. If someone already submitted it (front-running), the
    ///        existing allowance is used.
    function payWithToken(
        Payment calldata p,
        bytes calldata payerSignature,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32 paymentId) {
        address pair = pairFor[p.sourceToken];
        if (pair == address(0)) revert UnsupportedToken();
        paymentId = _open(p);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(paymentId, payerSignature);
        if (err != ECDSA.RecoverError.NoError || signer != p.sender) revert InvalidPayerSignature();

        IERC20 source = IERC20(p.sourceToken);
        try IERC20Permit(p.sourceToken).permit(p.sender, address(this), p.maxSourceAmount, permitDeadline, v, r, s) {} catch {}
        uint256 heldBefore = source.balanceOf(address(this));
        source.safeTransferFrom(p.sender, address(this), p.maxSourceAmount);
        if (source.balanceOf(address(this)) != heldBefore + p.maxSourceAmount) revert FundingMismatch();

        address[] memory path = new address[](2);
        path[0] = p.sourceToken;
        path[1] = address(AUSD);
        uint256 recipientBefore = AUSD.balanceOf(p.recipient);
        source.forceApprove(pair, p.maxSourceAmount);
        uint256[] memory amounts =
            IAgoraStableSwapPair(pair).swapTokensForExactTokens(p.amount, p.maxSourceAmount, path, p.recipient, p.deadline);
        source.forceApprove(pair, 0);
        if (AUSD.balanceOf(p.recipient) != recipientBefore + p.amount) revert SettlementMismatch();

        // Return what the swap didn't use; this contract keeps nothing.
        uint256 left = source.balanceOf(address(this)) - heldBefore;
        uint256 spent = p.maxSourceAmount - left;
        if (amounts[0] != spent) revert SettlementMismatch();
        if (left > 0) source.safeTransfer(p.sender, left);
        emit Paid(paymentId, p.ref, p.sender, p.recipient, p.amount, p.sourceToken, spent, pair);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function paymentIdOf(Payment calldata p) external view returns (bytes32) {
        return _id(p);
    }

    /// @notice How much `sourceToken` the pair needs right now to deliver exactly `amount` AUSD (fees included).
    function quote(address sourceToken, uint256 amount) external view returns (uint256 sourceAmount) {
        address pair = pairFor[sourceToken];
        if (pair == address(0)) revert UnsupportedToken();
        address[] memory path = new address[](2);
        path[0] = sourceToken;
        path[1] = address(AUSD);
        return IAgoraStableSwapPair(pair).getAmountsIn(amount, path)[0];
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
                abi.encode(PAYMENT_TYPEHASH, p.ref, p.sender, p.recipient, p.amount, p.sourceToken, p.maxSourceAmount, p.deadline)
            )
        );
    }

    /// @dev Shared checks, then mark the payment settled (effects before interactions).
    function _open(Payment calldata p) private returns (bytes32 paymentId) {
        if (p.sender == address(0)) revert ZeroAddress();
        if (p.recipient == address(0) || p.recipient == address(this)) revert InvalidRecipient();
        if (p.amount == 0 || p.maxSourceAmount == 0) revert ZeroAmount();
        if (block.timestamp >= p.deadline) revert Expired();
        paymentId = _id(p);
        if (settled[paymentId]) revert AlreadySettled();
        settled[paymentId] = true;
    }

    /// @dev Same fail-closed check as EverpieceEscrow: AUSD's payee-checked receive must not have been re-routed.
    function _requireVerifiedAusdReceiveSemantics() private view {
        try AUSD.isReceiveWithAuthorizationUpgraded() returns (bool upgraded) {
            if (upgraded) revert AusdSemanticsChanged();
        } catch {
            revert AusdSemanticsChanged();
        }
    }
}
