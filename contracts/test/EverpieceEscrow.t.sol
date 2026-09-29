// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../src/interfaces/IEverpieceEscrow.sol";
import {EverpieceEscrow} from "../src/EverpieceEscrow.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Happy paths (T01–T05), pause (T70), caps (T22), approver rotation (T60–T63), AUSD guard (T47), admin (T71–T73).
contract EverpieceEscrowTest is EscrowBase {
    // ------------------------------------------------------------------ constructor

    function test_constructor_state() public view {
        assertEq(address(escrow.AUSD()), AUSD_ADDR);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.claimApprover(), approver);
        assertEq(escrow.maxPaymentAmount(), 500 * DOLLAR);
        assertEq(escrow.maxActiveLiability(), 5_000 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 0);
        assertFalse(escrow.paused());
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(IEverpieceEscrow.ZeroAddress.selector);
        new EverpieceEscrow(IAUSD(address(0)), owner, approver);
        vm.expectRevert(IEverpieceEscrow.ZeroAddress.selector);
        new EverpieceEscrow(IAUSD(AUSD_ADDR), owner, address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new EverpieceEscrow(IAUSD(AUSD_ADDR), address(0), approver);
    }

    // ------------------------------------------------------------------ T01 create username

    function test_T01_createUsername() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(200 * DOLLAR);
        bytes32 expectedId = escrow.paymentIdOf(i);
        bytes memory s = _fundingSig(SENDER_PK, i);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IEverpieceEscrow.PaymentCreated(
            expectedId, sender, i.recipientCommitment, USERNAME, i.metadataCommitment, address(0), 200 * DOLLAR, uint64(i.expiresAt)
        );
        vm.prank(relayer);
        bytes32 id = escrow.createPayment(i, s);

        assertEq(id, expectedId);
        IEverpieceEscrow.Payment memory p = escrow.getPayment(id);
        assertEq(p.sender, sender);
        assertEq(uint8(p.mode), USERNAME);
        assertEq(uint8(p.status), uint8(IEverpieceEscrow.Status.ACTIVE));
        assertEq(p.amount, 200 * DOLLAR);
        assertEq(p.createdAt, block.timestamp);
        assertEq(p.expiresAt, i.expiresAt);
        assertEq(p.approver, address(0));
        assertEq(p.recipientCommitment, i.recipientCommitment);
        assertEq(p.metadataCommitment, i.metadataCommitment);
        assertEq(escrow.totalActiveLiability(), 200 * DOLLAR);
        assertEq(ausd.balanceOf(address(escrow)), 200 * DOLLAR);
        assertEq(ausd.balanceOf(sender), 9_800 * DOLLAR);
        assertTrue(ausd.authorizationState(sender, id)); // ERC-3009 nonce consumed == paymentId
    }

    // ------------------------------------------------------------------ T02 username claim

    function test_T02_usernameClaim() public {
        bytes32 id = _create(_usernameIntent(200 * DOLLAR));
        bytes32 n = bytes32("n1");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory s = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, n, dl));

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEverpieceEscrow.PaymentClaimed(id, recipient, 200 * DOLLAR);
        vm.prank(relayer);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), n, dl, s);

        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CLAIMED));
        assertEq(ausd.balanceOf(recipient), 200 * DOLLAR);
        assertEq(ausd.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalActiveLiability(), 0);
        assertTrue(escrow.usedNonces(recipient, n));
    }

    function test_usernameClaim_senderIsCommittedRecipient_canClaim() public {
        // D1: sender has no special right, but CAN claim if they are the committed recipient.
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(sender, bytes32("rsalt")), address(0), 10 * DOLLAR, block.timestamp + 1 days);
        bytes32 id = _create(i);
        _claimUsername(id, sender, bytes32("rsalt"), SENDER_PK);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CLAIMED));
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    // ------------------------------------------------------------------ T03 link claim

    function test_T03_linkClaim() public {
        bytes32 id = _create(_linkIntent(200 * DOLLAR));
        assertEq(escrow.getPayment(id).approver, approver);
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEverpieceEscrow.PaymentClaimed(id, recipient, 200 * DOLLAR);
        _claimLink(id, a);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CLAIMED));
        assertEq(ausd.balanceOf(recipient), 200 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 0);
        assertTrue(escrow.usedNonces(claimKey, a.actionNonce));
        assertTrue(escrow.usedNonces(approver, a.approvalNonce));
    }

    function test_T59_linkClaim_senderSelfDesignated() public {
        // Sender designates themselves; passing BOTH factors is the normal path, not a bypass (master §11.5).
        bytes32 id = _create(_linkIntent(50 * DOLLAR));
        _claimLink(id, _linkArgs(id, sender, CLAIMKEY_PK, APPROVER_PK));
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    // ------------------------------------------------------------------ T04 cancel / T05 refund

    function test_T04_cancel() public {
        bytes32 id = _create(_usernameIntent(200 * DOLLAR));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEverpieceEscrow.PaymentCancelled(id, sender, 200 * DOLLAR);
        _cancel(id);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CANCELLED));
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_T05_refundExpired_byStranger() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(200 * DOLLAR);
        bytes32 id = _create(i);
        vm.warp(i.expiresAt);
        assertTrue(escrow.isExpired(id));
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IEverpieceEscrow.PaymentRefunded(id, sender, 200 * DOLLAR, stranger);
        vm.prank(stranger);
        escrow.refundExpired(id);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.REFUNDED));
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
        assertEq(ausd.balanceOf(stranger), 0);
        assertFalse(escrow.isExpired(id));
    }

    // ------------------------------------------------------------------ create validation

    function test_create_rejectsInvalidMode() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.mode = 0;
        vm.expectRevert(IEverpieceEscrow.InvalidMode.selector);
        escrow.createPayment(i, "");
        i.mode = 3;
        vm.expectRevert(IEverpieceEscrow.InvalidMode.selector);
        escrow.createPayment(i, "");
    }

    function test_create_rejectsBadSender() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.sender = address(0);
        vm.expectRevert(IEverpieceEscrow.InvalidSender.selector);
        escrow.createPayment(i, "");
        i.sender = address(escrow);
        vm.expectRevert(IEverpieceEscrow.InvalidSender.selector);
        escrow.createPayment(i, "");
    }

    function test_create_rejectsZeroAmount() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(0);
        vm.expectRevert(IEverpieceEscrow.ZeroAmount.selector);
        escrow.createPayment(i, "");
    }

    function test_create_rejectsZeroRecipientCommitment() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.recipientCommitment = bytes32(0);
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientCommitment.selector);
        escrow.createPayment(i, "");
    }

    function test_create_zeroMetadataAllowed() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.metadataCommitment = bytes32(0);
        bytes32 id = _create(i);
        assertEq(escrow.getPayment(id).metadataCommitment, bytes32(0));
    }

    function test_create_rejectsBadSignature() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        bytes memory s = _fundingSig(STRANGER_PK, i);
        vm.expectRevert(MockAUSDErrors.InvalidSignature.selector);
        escrow.createPayment(i, s);
        assertEq(escrow.totalActiveLiability(), 0);
        assertEq(uint8(_status(escrow.paymentIdOf(i))), 0);
    }

    function test_create_insufficientBalance_reverts() public {
        ausd.burn(sender, ausd.balanceOf(sender) - DOLLAR + 1); // leave 0.999999
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert();
        escrow.createPayment(i, s);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    // ------------------------------------------------------------------ T70 pause

    function test_T70_pause_blocksCreateAndClaims_allowsCancelAndRefund() public {
        bytes32 idU = _create(_usernameIntent(10 * DOLLAR));
        bytes32 idL = _create(_linkIntent(10 * DOLLAR));
        IEverpieceEscrow.PaymentIntent memory iR = _usernameIntent(10 * DOLLAR);
        bytes32 idR = _create(iR);
        IEverpieceEscrow.PaymentIntent memory iNew = _usernameIntent(10 * DOLLAR);
        bytes memory sNew = _fundingSig(SENDER_PK, iNew);

        vm.prank(owner);
        escrow.pause();
        assertTrue(escrow.paused());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createPayment(iNew, sNew);

        bytes32 n = bytes32("n");
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(idU, recipient, n, dl));
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.claimUsernamePayment(idU, recipient, bytes32("rsalt"), n, dl, cs);

        LinkArgs memory a = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _claimLink(idL, a);

        _cancel(idU); // allowed while paused
        assertEq(uint8(_status(idU)), uint8(IEverpieceEscrow.Status.CANCELLED));

        vm.warp(iR.expiresAt);
        escrow.refundExpired(idR); // allowed while paused
        assertEq(uint8(_status(idR)), uint8(IEverpieceEscrow.Status.REFUNDED));

        vm.prank(owner);
        escrow.unpause();
        // idL expired during the pause: it is refunded, not claimable (pause never extends expiry)
        LinkArgs memory late = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
        _claimLink(idL, late);
        escrow.refundExpired(idL);
        assertEq(escrow.totalActiveLiability(), 0);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_T71_onlyOwnerAdmin() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.unpause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setCaps(1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setClaimApprover(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.transferOwnership(stranger);
        vm.stopPrank();
        // approver and relayer have no admin power either
        vm.prank(approver);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, approver));
        escrow.pause();
    }

    function test_T73_ownable2Step_and_renounceDisabled() public {
        address next = makeAddr("next");
        vm.prank(owner);
        escrow.transferOwnership(next);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.pendingOwner(), next);
        vm.prank(next);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), next);
        vm.prank(next);
        vm.expectRevert(IEverpieceEscrow.RenounceDisabled.selector);
        escrow.renounceOwnership();
        assertEq(escrow.owner(), next);
    }

    // ------------------------------------------------------------------ T22 caps

    function test_T22_perPaymentCap() public {
        bytes32 id = _create(_usernameIntent(500 * DOLLAR)); // exactly the cap
        assertTrue(id != bytes32(0));
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(500 * DOLLAR + 1);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AmountAboveCap.selector);
        escrow.createPayment(i, s);
    }

    function test_T22_aggregateCap() public {
        ausd.mint(sender, 10_000 * DOLLAR);
        for (uint256 k; k < 10; ++k) {
            _create(_usernameIntent(500 * DOLLAR));
        }
        assertEq(escrow.totalActiveLiability(), 5_000 * DOLLAR);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(1);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.LiabilityCapExceeded.selector);
        escrow.createPayment(i, s);
    }

    function test_T22_setCaps_boundedByCeilings() public {
        vm.startPrank(owner);
        vm.expectRevert(IEverpieceEscrow.CapAboveCeiling.selector);
        escrow.setCaps(500 * DOLLAR + 1, 5_000 * DOLLAR);
        vm.expectRevert(IEverpieceEscrow.CapAboveCeiling.selector);
        escrow.setCaps(500 * DOLLAR, 5_000 * DOLLAR + 1);
        vm.expectEmit(address(escrow));
        emit IEverpieceEscrow.CapsUpdated(10 * DOLLAR, 100 * DOLLAR);
        escrow.setCaps(10 * DOLLAR, 100 * DOLLAR); // canary mode
        vm.stopPrank();
        assertEq(escrow.maxPaymentAmount(), 10 * DOLLAR);
        assertEq(escrow.maxActiveLiability(), 100 * DOLLAR);

        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR + 1);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AmountAboveCap.selector);
        escrow.createPayment(i, s);

        vm.prank(owner);
        escrow.setCaps(500 * DOLLAR, 5_000 * DOLLAR); // restore up to (not beyond) the ceiling
        assertEq(escrow.maxPaymentAmount(), 500 * DOLLAR);
    }

    function test_T22_loweringCapsDoesNotAffectExistingPayments() public {
        bytes32 idU = _create(_usernameIntent(400 * DOLLAR));
        bytes32 idC = _create(_usernameIntent(400 * DOLLAR));
        vm.prank(owner);
        escrow.setCaps(0, 0);
        _claimUsername(idU, recipient, bytes32("rsalt"), RECIPIENT_PK);
        _cancel(idC);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    // ------------------------------------------------------------------ T60–T63 approver rotation

    function test_T60_T61_approverRotation() public {
        bytes32 oldId = _create(_linkIntent(20 * DOLLAR));
        vm.expectEmit(true, true, false, false, address(escrow));
        emit IEverpieceEscrow.ClaimApproverUpdated(approver, approver2);
        vm.prank(owner);
        escrow.setClaimApprover(approver2);
        bytes32 newId = _create(_linkIntent(20 * DOLLAR));
        assertEq(escrow.getPayment(oldId).approver, approver);
        assertEq(escrow.getPayment(newId).approver, approver2);

        // old payment: new approver rejected, old approver accepted
        LinkArgs memory a = _linkArgs(oldId, recipient, CLAIMKEY_PK, APPROVER2_PK);
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(oldId, a);
        _claimLink(oldId, _linkArgs(oldId, recipient, CLAIMKEY_PK, APPROVER_PK));

        // new payment: old approver rejected, new approver accepted
        a = _linkArgs(newId, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(newId, a);
        _claimLink(newId, _linkArgs(newId, recipient, CLAIMKEY_PK, APPROVER2_PK));
    }

    function test_T62_linkIntentApproverMustMatchCurrent() public {
        IEverpieceEscrow.PaymentIntent memory i = _linkIntent(DOLLAR); // signed for `approver`
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.prank(owner);
        escrow.setClaimApprover(approver2); // rotation between signing and submission
        vm.expectRevert(IEverpieceEscrow.ApproverMismatch.selector);
        escrow.createPayment(i, s);
    }

    function test_T63_usernameIntentMustHaveZeroApprover() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.approver = approver;
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.ApproverMismatch.selector);
        escrow.createPayment(i, s);
    }

    function test_setClaimApprover_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(IEverpieceEscrow.ZeroAddress.selector);
        escrow.setClaimApprover(address(0));
    }

    // ------------------------------------------------------------------ T47 AUSD security-mode guard

    function test_T47_guard_safeMode_allowsCreate() public {
        assertFalse(IAUSD(AUSD_ADDR).isReceiveWithAuthorizationUpgraded());
        _create(_usernameIntent(DOLLAR));
    }

    function test_T47_guard_unsafeMode_blocksCreate_butNotExistingLiabilities() public {
        bytes32 idClaim = _create(_usernameIntent(10 * DOLLAR));
        bytes32 idCancel = _create(_usernameIntent(10 * DOLLAR));
        IEverpieceEscrow.PaymentIntent memory iRef = _usernameIntent(10 * DOLLAR);
        bytes32 idRefund = _create(iRef);

        ausd.setReceiveWithAuthorizationUpgraded(true);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AusdSemanticsChanged.selector);
        escrow.createPayment(i, s);

        _claimUsername(idClaim, recipient, bytes32("rsalt"), RECIPIENT_PK);
        _cancel(idCancel);
        vm.warp(iRef.expiresAt);
        escrow.refundExpired(idRefund);
        assertEq(escrow.totalActiveLiability(), 0);

        ausd.setReceiveWithAuthorizationUpgraded(false); // back to verified mode
        vm.warp(T0);
        _create(_usernameIntent(DOLLAR));
    }

    function test_T47_guard_unreadableFlag_failsClosed() public {
        ausd.setFlagReadReverts(true);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AusdSemanticsChanged.selector);
        escrow.createPayment(i, s);
    }

    // ------------------------------------------------------------------ views

    function test_views_domainAndTypehashes() public view {
        assertEq(escrow.PAYMENT_INTENT_TYPEHASH(), 0xfe47d1ba0797dff165ffeb9757cb00f65209173109c218ae84dad516ea052126);
        assertEq(escrow.CLAIM_INTENT_TYPEHASH(), 0x0a793245693c7d0b0e7cdef9d078cfa33a1db9e793f6f9e74ae60f8c30f90c56);
        assertEq(escrow.LINK_CLAIM_INTENT_TYPEHASH(), 0x260181d054f3216afe276036306927af04bd2f74dc0dc63a589539f06bc4a39e);
        assertEq(escrow.CLAIM_APPROVAL_TYPEHASH(), 0xd3e61339735cbf9f76131a9f5b4a49ea6c85e74741f2689fedb433f4f00a3a70);
        assertEq(escrow.CANCEL_INTENT_TYPEHASH(), 0x91d2228050f5adf675ffe5c70058bbe89db877688aa727562c63a00a36d4f557);
        assertEq(escrow.TAG_RECIPIENT_V1(), 0x5392229aa2860a528ed83e7c508b93742c57496d8e98cc54442e51343b7c388c);
        assertEq(escrow.DOMAIN_SEPARATOR(), 0xe608be5ba2e4bf6fd034b6ddc6b1fd4528e68bc8fb00dca5a2a5a71d41ab8ef1);
        (, string memory n, string memory v, uint256 c, address vc,,) = escrow.eip712Domain();
        assertEq(n, "Everpiece Escrow");
        assertEq(v, "1");
        assertEq(c, 143);
        assertEq(vc, ESCROW_ADDR);
    }

    function test_isExpired_unknownPaymentFalse() public view {
        assertFalse(escrow.isExpired(bytes32("nope")));
    }
}

/// @dev Error selectors of the mock (mirroring real AUSD) used in expectRevert.
interface MockAUSDErrors {
    error InvalidSignature();
}
