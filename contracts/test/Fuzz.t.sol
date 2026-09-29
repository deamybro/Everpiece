// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../src/interfaces/IEverpieceEscrow.sol";

/// @notice Property fuzzing of bounds, time boundaries, signer identity and term binding.
contract FuzzTest is EscrowBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function testFuzz_create_amountBounds(uint256 amount) public {
        amount = bound(amount, 0, 1_000 * DOLLAR);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(amount);
        bytes memory s = _fundingSig(SENDER_PK, i);
        if (amount == 0) vm.expectRevert(IEverpieceEscrow.ZeroAmount.selector);
        else if (amount > 500 * DOLLAR) vm.expectRevert(IEverpieceEscrow.AmountAboveCap.selector);
        escrow.createPayment(i, s);
        if (amount != 0 && amount <= 500 * DOLLAR) {
            assertEq(escrow.totalActiveLiability(), amount);
            assertEq(ausd.balanceOf(address(escrow)), amount);
        }
    }

    function testFuzz_create_expiryWindow(uint256 offset) public {
        offset = bound(offset, 0, 60 days);
        uint256 e = block.timestamp + offset;
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(recipient, bytes32("rsalt")), address(0), DOLLAR, e);
        if (i.validBefore > e) i.validBefore = e; // keep the authorization window inside expiry
        bytes memory s = _fundingSig(SENDER_PK, i);
        bool ok = offset >= 1 days && offset <= 30 days;
        if (!ok) vm.expectRevert(IEverpieceEscrow.ExpiryOutOfRange.selector);
        escrow.createPayment(i, s);
    }

    /// For any time t: claim and cancel succeed iff t < expiresAt; refund succeeds iff t >= expiresAt.
    function testFuzz_timeBoundaries(uint256 t, uint8 action) public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 id = _create(i);
        t = bound(t, block.timestamp, i.expiresAt + 60 days);
        uint256 dl = type(uint256).max;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        bytes memory cs = _cancelSig(id, SENDER_PK, bytes32("c"), dl);
        vm.warp(t);
        bool beforeExpiry = t < i.expiresAt;
        action = action % 3;
        if (action == 0) {
            if (!beforeExpiry) vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
            escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        } else if (action == 1) {
            if (!beforeExpiry) vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
            escrow.cancel(id, bytes32("c"), dl, cs);
        } else {
            if (beforeExpiry) vm.expectRevert(IEverpieceEscrow.PaymentNotExpired.selector);
            escrow.refundExpired(id);
        }
    }

    /// Only the committed recipient's key can claim a username payment.
    function testFuzz_onlyRecipientCanClaim(uint256 pk) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        address signer = vm.addr(pk);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(pk, escrow.hashClaimIntent(id, signer, bytes32("n"), dl));
        if (signer != recipient) vm.expectRevert(IEverpieceEscrow.RecipientMismatch.selector);
        escrow.claimUsernamePayment(id, signer, bytes32("rsalt"), bytes32("n"), dl, s);
    }

    /// Only the sender's key can cancel, and funds always return to the sender.
    function testFuzz_onlySenderCanCancel(uint256 pk, address caller) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _cancelSig(id, pk, bytes32("n"), dl);
        if (vm.addr(pk) != sender) vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
        vm.prank(caller);
        escrow.cancel(id, bytes32("n"), dl, s);
        if (vm.addr(pk) == sender) assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    /// Link claims need BOTH the committed claim key and the snapshotted approver.
    function testFuzz_linkNeedsBothFactors(uint256 ckPk, uint256 apPk) public {
        ckPk = bound(ckPk, 1, SECP256K1_N - 1);
        apPk = bound(apPk, 1, SECP256K1_N - 1);
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, ckPk, apPk);
        a.claimKey = claimKey; // reveal the committed key; signatures come from the fuzzed keys
        bool okA = vm.addr(ckPk) == claimKey;
        bool okB = vm.addr(apPk) == approver;
        if (!okA) vm.expectRevert(IEverpieceEscrow.InvalidClaimKeySignature.selector);
        else if (!okB) vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, a);
    }

    /// Any change to any intent word invalidates the sender's funding authorization.
    function testFuzz_anyIntentChangeInvalidatesAuthorization(uint256 field, uint256 delta) public {
        delta = bound(delta, 1, 1 hours);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        field = field % 6;
        if (field == 0) i.amount = i.amount - bound(delta, 1, i.amount - 1);
        else if (field == 1) i.expiresAt -= delta;
        else if (field == 2) i.recipientCommitment = bytes32(uint256(i.recipientCommitment) ^ delta);
        else if (field == 3) i.metadataCommitment = bytes32(uint256(i.metadataCommitment) ^ delta);
        else if (field == 4) i.salt = bytes32(uint256(i.salt) ^ delta);
        else i.validBefore -= bound(delta, 1, 59 minutes);
        vm.expectRevert();
        escrow.createPayment(i, s);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function testFuzz_setCaps(uint256 a, uint256 b) public {
        vm.prank(owner);
        if (a > 500 * DOLLAR || b > 5_000 * DOLLAR) vm.expectRevert(IEverpieceEscrow.CapAboveCeiling.selector);
        escrow.setCaps(a, b);
        assertLe(escrow.maxPaymentAmount(), 500 * DOLLAR);
        assertLe(escrow.maxActiveLiability(), 5_000 * DOLLAR);
    }

    function testFuzz_recipientCommitmentBinding(address a, bytes32 sa, address b, bytes32 sb) public view {
        vm.assume(a != b || sa != sb);
        assertTrue(escrow.recipientCommitmentOf(USERNAME, a, sa) != escrow.recipientCommitmentOf(USERNAME, b, sb));
        assertTrue(escrow.recipientCommitmentOf(USERNAME, a, sa) != escrow.recipientCommitmentOf(LINK, a, sa));
    }
}
