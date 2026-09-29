// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IEverpieceEscrow
/// @notice Types, events, errors and external surface of EverpieceEscrow (docs/ESCROW_SPEC.md v0.2).
interface IEverpieceEscrow {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum PaymentMode {
        NONE,
        USERNAME,
        LINK
    }

    /// @dev EXPIRED is derived: ACTIVE && block.timestamp >= expiresAt.
    enum Status {
        NONE,
        ACTIVE,
        CLAIMED,
        CANCELLED,
        REFUNDED
    }

    struct Payment {
        address sender;
        uint64 expiresAt;
        PaymentMode mode;
        Status status;
        uint128 amount;
        uint64 createdAt;
        address approver;
        bytes32 recipientCommitment;
        bytes32 metadataCommitment;
    }

    /// @dev EIP-712 `PaymentIntent`. Its digest is the paymentId and the ERC-3009 nonce (ESCROW_SPEC §6.3, §7).
    struct PaymentIntent {
        address sender;
        uint8 mode;
        bytes32 recipientCommitment;
        bytes32 metadataCommitment;
        address approver;
        uint256 amount;
        uint256 expiresAt;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
    }

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event PaymentCreated(
        bytes32 indexed paymentId,
        address indexed sender,
        bytes32 indexed recipientCommitment,
        uint8 mode,
        bytes32 metadataCommitment,
        address approver,
        uint256 amount,
        uint64 expiresAt
    );
    event PaymentClaimed(bytes32 indexed paymentId, address indexed recipient, uint256 amount);
    event PaymentCancelled(bytes32 indexed paymentId, address indexed sender, uint256 amount);
    event PaymentRefunded(bytes32 indexed paymentId, address indexed sender, uint256 amount, address caller);
    event NonceUsed(address indexed signer, bytes32 indexed nonce);
    event CapsUpdated(uint256 maxPaymentAmount, uint256 maxActiveLiability);
    event ClaimApproverUpdated(address indexed previousApprover, address indexed newApprover);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error InvalidMode();
    error InvalidSender();
    error ZeroAmount();
    error AmountAboveCap();
    error LiabilityCapExceeded();
    error ExpiryOutOfRange();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidRecipientCommitment();
    error ApproverMismatch();
    error AusdSemanticsChanged();
    error PaymentExists();
    error PaymentNotActive();
    error WrongMode();
    error PaymentExpired();
    error PaymentNotExpired();
    error SignatureExpired();
    error NonceAlreadyUsed();
    error InvalidRecipient();
    error InvalidClaimKey();
    error RecipientMismatch();
    error LinkRevealMismatch();
    error InvalidRecipientSignature();
    error InvalidClaimKeySignature();
    error InvalidApproverSignature();
    error InvalidSenderSignature();
    error FundingMismatch();
    error PayoutMismatch();
    error CapAboveCeiling();
    error ZeroAddress();
    error RenounceDisabled();

    // ---------------------------------------------------------------------------------------------
    // Money functions
    // ---------------------------------------------------------------------------------------------

    function createPayment(PaymentIntent calldata intent, bytes calldata ausdSignature)
        external
        returns (bytes32 paymentId);

    function claimUsernamePayment(
        bytes32 paymentId,
        address recipient,
        bytes32 recipientSalt,
        bytes32 actionNonce,
        uint256 deadline,
        bytes calldata recipientSig
    ) external;

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
    ) external;

    function cancel(bytes32 paymentId, bytes32 actionNonce, uint256 deadline, bytes calldata senderSig) external;

    function refundExpired(bytes32 paymentId) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function paymentIdOf(PaymentIntent calldata intent) external view returns (bytes32);
    function recipientCommitmentOf(uint8 mode, address account, bytes32 recipientSalt) external pure returns (bytes32);
    function hashClaimIntent(bytes32 paymentId, address recipient, bytes32 actionNonce, uint256 deadline)
        external
        view
        returns (bytes32);
    function hashLinkClaimIntent(bytes32 paymentId, address recipient, bytes32 actionNonce, uint256 deadline)
        external
        view
        returns (bytes32);
    function hashClaimApproval(bytes32 paymentId, address recipient, bytes32 approvalNonce, uint256 deadline)
        external
        view
        returns (bytes32);
    function hashCancelIntent(bytes32 paymentId, address sender, bytes32 actionNonce, uint256 deadline)
        external
        view
        returns (bytes32);
    function getPayment(bytes32 paymentId) external view returns (Payment memory);
    function isExpired(bytes32 paymentId) external view returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function pause() external;
    function unpause() external;
    function setCaps(uint256 newMaxPaymentAmount, uint256 newMaxActiveLiability) external;
    function setClaimApprover(address newApprover) external;
}
