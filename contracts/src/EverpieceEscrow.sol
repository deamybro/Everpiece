// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAUSD} from "./interfaces/IAUSD.sol";
import {IEverpieceEscrow} from "./interfaces/IEverpieceEscrow.sol";

/// @title EverpieceEscrow
/// @notice Protected person-to-person AUSD payments on Monad: funds stay escrowed until the intended recipient
///         claims, the sender cancels before expiry, or anyone returns them to the sender after expiry.
/// @dev Specification: docs/ESCROW_SPEC.md v0.2. Non-upgradeable. Single asset (AUSD). No admin path moves funds.
///      Funding uses one AUSD ERC-3009 `ReceiveWithAuthorization` signature whose nonce is the paymentId, i.e. the
///      EIP-712 digest of the full PaymentIntent, so the authorization is bound to every payment term.
contract EverpieceEscrow is IEverpieceEscrow, EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    /// @notice Absolute V1 per-payment ceiling: $500 (AUSD has 6 decimals).
    uint256 public constant MAX_PAYMENT_CEILING = 500_000_000;
    /// @notice Absolute V1 aggregate active-liability ceiling: $5,000.
    uint256 public constant MAX_LIABILITY_CEILING = 5_000_000_000;
    uint256 public constant MIN_EXPIRY = 1 days;
    uint256 public constant MAX_EXPIRY = 30 days;

    bytes32 public constant TAG_RECIPIENT_V1 = keccak256("everpiece.recipient.v1");

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(address sender,uint8 mode,bytes32 recipientCommitment,bytes32 metadataCommitment,address approver,uint256 amount,uint256 expiresAt,uint256 validAfter,uint256 validBefore,bytes32 salt)"
    );
    bytes32 public constant CLAIM_INTENT_TYPEHASH =
        keccak256("ClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)");
    bytes32 public constant LINK_CLAIM_INTENT_TYPEHASH =
        keccak256("LinkClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)");
    bytes32 public constant CLAIM_APPROVAL_TYPEHASH =
        keccak256("ClaimApproval(bytes32 paymentId,address recipient,bytes32 approvalNonce,uint256 deadline)");
    bytes32 public constant CANCEL_INTENT_TYPEHASH =
        keccak256("CancelIntent(bytes32 paymentId,address sender,bytes32 actionNonce,uint256 deadline)");

    // ---------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------

    /// @notice The only escrow asset. Mainnet value must equal docs/VERIFIED.md §2.1.
    IAUSD public immutable AUSD;

    mapping(bytes32 paymentId => Payment) private _payments;
    mapping(address signer => mapping(bytes32 nonce => bool)) public usedNonces;

    /// @notice Sum of `amount` over every ACTIVE payment.
    uint256 public totalActiveLiability;
    uint256 public maxPaymentAmount;
    uint256 public maxActiveLiability;
    /// @notice Approver snapshotted into NEW link payments. Existing payments keep their own snapshot.
    address public claimApprover;

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    constructor(IAUSD ausd, address initialOwner, address initialClaimApprover)
        EIP712("Everpiece Escrow", "1")
        Ownable(initialOwner)
    {
        if (address(ausd) == address(0) || initialClaimApprover == address(0)) revert ZeroAddress();
        AUSD = ausd;
        maxPaymentAmount = MAX_PAYMENT_CEILING;
        maxActiveLiability = MAX_LIABILITY_CEILING;
        claimApprover = initialClaimApprover;
        emit CapsUpdated(MAX_PAYMENT_CEILING, MAX_LIABILITY_CEILING);
        emit ClaimApproverUpdated(address(0), initialClaimApprover);
    }

    // ---------------------------------------------------------------------------------------------
    // Create
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IEverpieceEscrow
    function createPayment(PaymentIntent calldata intent, bytes calldata ausdSignature)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 paymentId)
    {
        PaymentMode mode = _toMode(intent.mode);
        address sender = intent.sender;
        if (sender == address(0) || sender == address(this)) revert InvalidSender();

        uint256 amount = intent.amount;
        if (amount == 0) revert ZeroAmount();
        if (amount > maxPaymentAmount) revert AmountAboveCap();
        uint256 newLiability = totalActiveLiability + amount;
        if (newLiability > maxActiveLiability) revert LiabilityCapExceeded();

        uint256 expiresAt = intent.expiresAt;
        if (
            expiresAt < block.timestamp + MIN_EXPIRY || expiresAt > block.timestamp + MAX_EXPIRY
                || intent.validBefore > expiresAt
        ) revert ExpiryOutOfRange();
        if (block.timestamp <= intent.validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= intent.validBefore) revert AuthorizationExpired();

        if (intent.recipientCommitment == bytes32(0)) revert InvalidRecipientCommitment();
        address approver = intent.approver;
        if (mode == PaymentMode.USERNAME ? approver != address(0) : approver != claimApprover) {
            revert ApproverMismatch();
        }
        _requireVerifiedAusdReceiveSemantics();

        paymentId = _hashTypedDataV4(_hashPaymentIntent(intent));
        Payment storage p = _payments[paymentId];
        if (p.status != Status.NONE) revert PaymentExists();

        // Effects
        p.sender = sender;
        p.expiresAt = uint64(expiresAt); // <= now + 30 days
        p.mode = mode;
        p.status = Status.ACTIVE;
        p.amount = uint128(amount); // <= MAX_PAYMENT_CEILING
        p.createdAt = uint64(block.timestamp);
        p.approver = approver;
        p.recipientCommitment = intent.recipientCommitment;
        p.metadataCommitment = intent.metadataCommitment;
        totalActiveLiability = newLiability;

        emit PaymentCreated(
            paymentId,
            sender,
            intent.recipientCommitment,
            intent.mode,
            intent.metadataCommitment,
            approver,
            amount,
            uint64(expiresAt)
        );

        // Interaction: every ERC-3009 argument is derived from the intent (ESCROW_SPEC §7.2). AUSD enforces
        // to == msg.sender, the strict validity window, nonce single-use and the sender's signature.
        uint256 balanceBefore = AUSD.balanceOf(address(this));
        AUSD.receiveWithAuthorization(
            sender, address(this), amount, intent.validAfter, intent.validBefore, paymentId, ausdSignature
        );
        if (AUSD.balanceOf(address(this)) != balanceBefore + amount) revert FundingMismatch();
    }

    // ---------------------------------------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IEverpieceEscrow
    function claimUsernamePayment(
        bytes32 paymentId,
        address recipient,
        bytes32 recipientSalt,
        bytes32 actionNonce,
        uint256 deadline,
        bytes calldata recipientSig
    ) external nonReentrant whenNotPaused {
        Payment storage p = _activeUnexpired(paymentId);
        if (p.mode != PaymentMode.USERNAME) revert WrongMode();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (_recipientCommitment(uint8(PaymentMode.USERNAME), recipient, recipientSalt) != p.recipientCommitment) {
            revert RecipientMismatch();
        }
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_INTENT_TYPEHASH, paymentId, recipient, actionNonce, deadline)));
        if (!_isSignedBy(digest, recipientSig, recipient)) revert InvalidRecipientSignature();

        _useNonce(recipient, actionNonce);
        uint256 amount = _close(p, Status.CLAIMED);
        emit PaymentClaimed(paymentId, recipient, amount);
        _payout(recipient, amount);
    }

    /// @inheritdoc IEverpieceEscrow
    function claimLinkPayment(
        bytes32 paymentId,
        address recipient,
        address claimKey,
        bytes32 recipientSalt,
        bytes32 actionNonce,
        uint256 deadline,
        bytes calldata claimKeySig,
        bytes32 approvalNonce,
        uint256 approvalDeadline,
        bytes calldata approverSig
    ) external nonReentrant whenNotPaused {
        Payment storage p = _activeUnexpired(paymentId);
        if (p.mode != PaymentMode.LINK) revert WrongMode();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        address approver = p.approver; // snapshot taken at create (D4)
        if (claimKey == address(0) || claimKey == approver) revert InvalidClaimKey();
        if (_recipientCommitment(uint8(PaymentMode.LINK), claimKey, recipientSalt) != p.recipientCommitment) {
            revert LinkRevealMismatch();
        }

        // Factor A: possession of the link claim key.
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 claimDigest = _hashTypedDataV4(
            keccak256(abi.encode(LINK_CLAIM_INTENT_TYPEHASH, paymentId, recipient, actionNonce, deadline))
        );
        if (!_isSignedBy(claimDigest, claimKeySig, claimKey)) revert InvalidClaimKeySignature();

        // Factor B: short-lived approval from the payment's snapshotted approver, bound to the same recipient.
        if (block.timestamp > approvalDeadline) revert SignatureExpired();
        bytes32 approvalDigest = _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_APPROVAL_TYPEHASH, paymentId, recipient, approvalNonce, approvalDeadline))
        );
        if (!_isSignedBy(approvalDigest, approverSig, approver)) revert InvalidApproverSignature();

        _useNonce(claimKey, actionNonce);
        _useNonce(approver, approvalNonce);
        uint256 amount = _close(p, Status.CLAIMED);
        emit PaymentClaimed(paymentId, recipient, amount);
        _payout(recipient, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Cancel / refund — never pausable
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IEverpieceEscrow
    function cancel(bytes32 paymentId, bytes32 actionNonce, uint256 deadline, bytes calldata senderSig)
        external
        nonReentrant
    {
        Payment storage p = _activeUnexpired(paymentId);
        if (block.timestamp > deadline) revert SignatureExpired();
        address sender = p.sender;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(CANCEL_INTENT_TYPEHASH, paymentId, sender, actionNonce, deadline)));
        if (!_isSignedBy(digest, senderSig, sender)) revert InvalidSenderSignature();

        _useNonce(sender, actionNonce);
        uint256 amount = _close(p, Status.CANCELLED);
        emit PaymentCancelled(paymentId, sender, amount);
        _payout(sender, amount);
    }

    /// @inheritdoc IEverpieceEscrow
    function refundExpired(bytes32 paymentId) external nonReentrant {
        Payment storage p = _payments[paymentId];
        if (p.status != Status.ACTIVE) revert PaymentNotActive();
        if (block.timestamp < p.expiresAt) revert PaymentNotExpired();
        address sender = p.sender;
        uint256 amount = _close(p, Status.REFUNDED);
        emit PaymentRefunded(paymentId, sender, amount, msg.sender);
        _payout(sender, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner (minimal powers — ESCROW_SPEC §13)
    // ---------------------------------------------------------------------------------------------

    /// @notice Blocks createPayment and both claims. Never blocks cancel or refundExpired.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Set caps anywhere up to the immutable V1 ceilings. Only affects future createPayment calls.
    function setCaps(uint256 newMaxPaymentAmount, uint256 newMaxActiveLiability) external onlyOwner {
        if (newMaxPaymentAmount > MAX_PAYMENT_CEILING || newMaxActiveLiability > MAX_LIABILITY_CEILING) {
            revert CapAboveCeiling();
        }
        maxPaymentAmount = newMaxPaymentAmount;
        maxActiveLiability = newMaxActiveLiability;
        emit CapsUpdated(newMaxPaymentAmount, newMaxActiveLiability);
    }

    /// @notice Approver for link payments created from now on. Existing payments keep their snapshot.
    function setClaimApprover(address newApprover) external onlyOwner {
        if (newApprover == address(0)) revert ZeroAddress();
        emit ClaimApproverUpdated(claimApprover, newApprover);
        claimApprover = newApprover;
    }

    /// @notice Disabled: an ownerless escrow could never be unpaused.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function paymentIdOf(PaymentIntent calldata intent) external view returns (bytes32) {
        return _hashTypedDataV4(_hashPaymentIntent(intent));
    }

    function recipientCommitmentOf(uint8 mode, address account, bytes32 recipientSalt)
        external
        pure
        returns (bytes32)
    {
        return _recipientCommitment(mode, account, recipientSalt);
    }

    function hashClaimIntent(bytes32 paymentId, address recipient, bytes32 actionNonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_INTENT_TYPEHASH, paymentId, recipient, actionNonce, deadline)));
    }

    function hashLinkClaimIntent(bytes32 paymentId, address recipient, bytes32 actionNonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(LINK_CLAIM_INTENT_TYPEHASH, paymentId, recipient, actionNonce, deadline))
        );
    }

    function hashClaimApproval(bytes32 paymentId, address recipient, bytes32 approvalNonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_APPROVAL_TYPEHASH, paymentId, recipient, approvalNonce, deadline))
        );
    }

    function hashCancelIntent(bytes32 paymentId, address sender, bytes32 actionNonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_INTENT_TYPEHASH, paymentId, sender, actionNonce, deadline)));
    }

    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return _payments[paymentId];
    }

    function isExpired(bytes32 paymentId) external view returns (bool) {
        Payment storage p = _payments[paymentId];
        return p.status == Status.ACTIVE && block.timestamp >= p.expiresAt;
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _toMode(uint8 mode) private pure returns (PaymentMode) {
        if (mode == uint8(PaymentMode.USERNAME)) return PaymentMode.USERNAME;
        if (mode == uint8(PaymentMode.LINK)) return PaymentMode.LINK;
        revert InvalidMode();
    }

    function _hashPaymentIntent(PaymentIntent calldata i) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PAYMENT_INTENT_TYPEHASH,
                i.sender,
                i.mode,
                i.recipientCommitment,
                i.metadataCommitment,
                i.approver,
                i.amount,
                i.expiresAt,
                i.validAfter,
                i.validBefore,
                i.salt
            )
        );
    }

    function _recipientCommitment(uint8 mode, address account, bytes32 recipientSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(TAG_RECIPIENT_V1, mode, account, recipientSalt));
    }

    /// @dev Fail closed if AUSD's inline receiveWithAuthorization (payee-checked, fork-verified) has been re-routed.
    function _requireVerifiedAusdReceiveSemantics() private view {
        try AUSD.isReceiveWithAuthorizationUpgraded() returns (bool upgraded) {
            if (upgraded) revert AusdSemanticsChanged();
        } catch {
            revert AusdSemanticsChanged();
        }
    }

    function _activeUnexpired(bytes32 paymentId) private view returns (Payment storage p) {
        p = _payments[paymentId];
        if (p.status != Status.ACTIVE) revert PaymentNotActive();
        if (block.timestamp >= p.expiresAt) revert PaymentExpired();
    }

    /// @dev EOA-only, 65-byte, low-s ECDSA (OpenZeppelin). A malformed signature simply fails verification.
    function _isSignedBy(bytes32 digest, bytes calldata signature, address expected) private pure returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered == expected;
    }

    function _useNonce(address signer, bytes32 nonce) private {
        if (usedNonces[signer][nonce]) revert NonceAlreadyUsed();
        usedNonces[signer][nonce] = true;
        emit NonceUsed(signer, nonce);
    }

    /// @dev Terminal transition: the only place liability decreases.
    function _close(Payment storage p, Status terminal) private returns (uint256 amount) {
        p.status = terminal;
        amount = p.amount;
        totalActiveLiability -= amount;
    }

    /// @dev Reverts the whole action unless exactly `amount` left the escrow (AUSD is issuer-upgradeable).
    function _payout(address to, uint256 amount) private {
        uint256 balanceBefore = AUSD.balanceOf(address(this));
        IERC20(address(AUSD)).safeTransfer(to, amount);
        if (AUSD.balanceOf(address(this)) + amount != balanceBefore) revert PayoutMismatch();
    }
}
