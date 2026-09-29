// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";
import {MockAUSD} from "./MockAUSD.sol";

/// @dev Shared fixture. MockAUSD sits at the real AUSD address and the escrow at the vector address
///      (0x1111…) on chain 143, so docs/ESCROW_SPEC.md §18 vectors replay against the real contract.
abstract contract EscrowBase is Test {
    address internal constant AUSD_ADDR = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant ESCROW_ADDR = 0x1111111111111111111111111111111111111111;
    uint256 internal constant T0 = 1790700000; // inside every vector's validity window

    // Vector keys (trivial scalars; never fund on a real chain)
    uint256 internal constant SENDER_PK = 1;
    uint256 internal constant RECIPIENT_PK = 2;
    uint256 internal constant APPROVER_PK = 3;
    uint256 internal constant CLAIMKEY_PK = 4;
    uint256 internal constant APPROVER2_PK = 5;
    uint256 internal constant STRANGER_PK = 0xBAD;

    uint8 internal constant USERNAME = 1;
    uint8 internal constant LINK = 2;
    uint256 internal constant DOLLAR = 1e6;

    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant TWA_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    MockAUSD internal ausd;
    EverpieceEscrow internal escrow;

    address internal sender;
    address internal recipient;
    address internal approver;
    address internal claimKey;
    address internal approver2;
    address internal stranger;
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");

    uint256 private _saltCounter;

    function setUp() public virtual {
        vm.chainId(143);
        vm.warp(T0);
        sender = vm.addr(SENDER_PK);
        recipient = vm.addr(RECIPIENT_PK);
        approver = vm.addr(APPROVER_PK);
        claimKey = vm.addr(CLAIMKEY_PK);
        approver2 = vm.addr(APPROVER2_PK);
        stranger = vm.addr(STRANGER_PK);

        deployCodeTo("MockAUSD.sol:MockAUSD", AUSD_ADDR);
        ausd = MockAUSD(AUSD_ADDR);
        deployCodeTo("EverpieceEscrow.sol:EverpieceEscrow", abi.encode(AUSD_ADDR, owner, approver), ESCROW_ADDR);
        escrow = EverpieceEscrow(ESCROW_ADDR);

        ausd.mint(sender, 10_000 * DOLLAR);
    }

    // ---------------------------------------------------------------------------------------------
    // Builders
    // ---------------------------------------------------------------------------------------------

    function _nextSalt() internal returns (bytes32) {
        return keccak256(abi.encode("salt", ++_saltCounter));
    }

    function _usernameRc(address account, bytes32 rsalt) internal view returns (bytes32) {
        return escrow.recipientCommitmentOf(USERNAME, account, rsalt);
    }

    function _linkRc(address key, bytes32 rsalt) internal view returns (bytes32) {
        return escrow.recipientCommitmentOf(LINK, key, rsalt);
    }

    function _intent(uint8 mode, bytes32 rc, address appr, uint256 amount, uint256 expiresAt)
        internal
        returns (IEverpieceEscrow.PaymentIntent memory i)
    {
        i = IEverpieceEscrow.PaymentIntent({
            sender: sender,
            mode: mode,
            recipientCommitment: rc,
            metadataCommitment: keccak256("meta"),
            approver: appr,
            amount: amount,
            expiresAt: expiresAt,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            salt: _nextSalt()
        });
    }

    function _usernameIntent(uint256 amount) internal returns (IEverpieceEscrow.PaymentIntent memory) {
        return _intent(USERNAME, _usernameRc(recipient, bytes32("rsalt")), address(0), amount, block.timestamp + 30 days);
    }

    function _linkIntent(uint256 amount) internal returns (IEverpieceEscrow.PaymentIntent memory) {
        return _intent(LINK, _linkRc(claimKey, bytes32("lsalt")), escrow.claimApprover(), amount, block.timestamp + 30 days);
    }

    // ---------------------------------------------------------------------------------------------
    // Signing
    // ---------------------------------------------------------------------------------------------

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _ausdDigest(bytes32 typehash, address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", ausd.DOMAIN_SEPARATOR(), keccak256(abi.encode(typehash, from, to, value, va, vb, nonce))
            )
        );
    }

    /// @dev What the sender's client signs: AUSD ReceiveWithAuthorization with nonce = paymentId.
    function _fundingSig(uint256 pk, IEverpieceEscrow.PaymentIntent memory i) internal view returns (bytes memory) {
        bytes32 pid = escrow.paymentIdOf(i);
        return _sig(pk, _ausdDigest(RWA_TYPEHASH, i.sender, address(escrow), i.amount, i.validAfter, i.validBefore, pid));
    }

    function _create(IEverpieceEscrow.PaymentIntent memory i) internal returns (bytes32 id) {
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.prank(relayer);
        id = escrow.createPayment(i, s);
    }

    function _claimUsername(bytes32 id, address rcpt, bytes32 rsalt, uint256 pk) internal {
        bytes32 n = keccak256(abi.encode("claim", id, pk));
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory s = _sig(pk, escrow.hashClaimIntent(id, rcpt, n, dl));
        vm.prank(relayer);
        escrow.claimUsernamePayment(id, rcpt, rsalt, n, dl, s);
    }

    struct LinkArgs {
        address recipient;
        address claimKey;
        bytes32 recipientSalt;
        bytes32 actionNonce;
        uint256 deadline;
        bytes claimKeySig;
        bytes32 approvalNonce;
        uint256 approvalDeadline;
        bytes approverSig;
    }

    function _linkArgs(bytes32 id, address rcpt, uint256 ckPk, uint256 apprPk) internal view returns (LinkArgs memory a) {
        a.recipient = rcpt;
        a.claimKey = vm.addr(ckPk);
        a.recipientSalt = bytes32("lsalt");
        a.actionNonce = keccak256(abi.encode("lc", id, rcpt));
        a.deadline = block.timestamp + 10 minutes;
        a.claimKeySig = _sig(ckPk, escrow.hashLinkClaimIntent(id, rcpt, a.actionNonce, a.deadline));
        a.approvalNonce = keccak256(abi.encode("ap", id, rcpt));
        a.approvalDeadline = block.timestamp + 5 minutes;
        a.approverSig = _sig(apprPk, escrow.hashClaimApproval(id, rcpt, a.approvalNonce, a.approvalDeadline));
    }

    function _claimLink(bytes32 id, LinkArgs memory a) internal {
        vm.prank(relayer);
        escrow.claimLinkPayment(
            id,
            a.recipient,
            a.claimKey,
            a.recipientSalt,
            a.actionNonce,
            a.deadline,
            a.claimKeySig,
            a.approvalNonce,
            a.approvalDeadline,
            a.approverSig
        );
    }

    function _cancelSig(bytes32 id, uint256 pk, bytes32 n, uint256 dl) internal view returns (bytes memory) {
        return _sig(pk, escrow.hashCancelIntent(id, sender, n, dl));
    }

    function _cancel(bytes32 id) internal {
        bytes32 n = keccak256(abi.encode("cancel", id));
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory s = _cancelSig(id, SENDER_PK, n, dl);
        vm.prank(relayer);
        escrow.cancel(id, n, dl, s);
    }

    function _status(bytes32 id) internal view returns (IEverpieceEscrow.Status) {
        return escrow.getPayment(id).status;
    }
}
