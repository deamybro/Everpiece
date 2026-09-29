// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../src/interfaces/IEverpieceEscrow.sol";

/// @notice Exact boundaries (master §8, ESCROW_SPEC §8.1): T10–T16.
contract ExpiryTest is EscrowBase {
    uint256 internal exp;
    bytes32 internal idU;
    bytes32 internal idL;

    function setUp() public override {
        super.setUp();
        IEverpieceEscrow.PaymentIntent memory iU = _usernameIntent(10 * DOLLAR);
        exp = iU.expiresAt;
        idU = _create(iU);
        IEverpieceEscrow.PaymentIntent memory iL = _linkIntent(10 * DOLLAR);
        idL = _create(iL);
    }

    function _usernameClaimArgs(uint256 dl) internal view returns (bytes32 n, bytes memory s) {
        n = keccak256(abi.encode("c", dl));
        s = _sig(RECIPIENT_PK, escrow.hashClaimIntent(idU, recipient, n, dl));
    }

    // ------------------------------------------------------------------ T10 claim

    function test_T10_usernameClaim_atExpiryMinus1_succeeds() public {
        vm.warp(exp - 1);
        (bytes32 n, bytes memory s) = _usernameClaimArgs(exp);
        escrow.claimUsernamePayment(idU, recipient, bytes32("rsalt"), n, exp, s);
        assertEq(uint8(_status(idU)), uint8(IEverpieceEscrow.Status.CLAIMED));
    }

    function test_T10_usernameClaim_atExpiry_fails() public {
        vm.warp(exp);
        (bytes32 n, bytes memory s) = _usernameClaimArgs(exp + 1 hours);
        vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
        escrow.claimUsernamePayment(idU, recipient, bytes32("rsalt"), n, exp + 1 hours, s);
    }

    function test_T10_linkClaim_atExpiryMinus1_succeeds() public {
        vm.warp(exp - 1);
        _claimLink(idL, _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK));
        assertEq(uint8(_status(idL)), uint8(IEverpieceEscrow.Status.CLAIMED));
    }

    function test_T10_linkClaim_atExpiry_fails() public {
        vm.warp(exp);
        LinkArgs memory a = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
        _claimLink(idL, a);
    }

    // ------------------------------------------------------------------ T11 cancel

    function test_T11_cancel_atExpiryMinus1_succeeds() public {
        vm.warp(exp - 1);
        _cancel(idU);
        assertEq(uint8(_status(idU)), uint8(IEverpieceEscrow.Status.CANCELLED));
    }

    function test_T11_cancel_atExpiry_fails() public {
        vm.warp(exp);
        bytes32 n = bytes32("x");
        uint256 dl = exp + 1 hours;
        bytes memory s = _cancelSig(idU, SENDER_PK, n, dl);
        vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
        escrow.cancel(idU, n, dl, s);
    }

    // ------------------------------------------------------------------ T12 refund

    function test_T12_refund_atExpiryMinus1_fails() public {
        vm.warp(exp - 1);
        vm.expectRevert(IEverpieceEscrow.PaymentNotExpired.selector);
        escrow.refundExpired(idU);
    }

    function test_T12_refund_atExpiry_succeeds() public {
        vm.warp(exp);
        escrow.refundExpired(idU);
        assertEq(uint8(_status(idU)), uint8(IEverpieceEscrow.Status.REFUNDED));
    }

    function test_T12_refund_atExpiryPlus1_succeeds() public {
        vm.warp(exp + 1);
        escrow.refundExpired(idU);
        assertEq(uint8(_status(idU)), uint8(IEverpieceEscrow.Status.REFUNDED));
    }

    function test_T12_refund_longAfterExpiry_succeeds() public {
        vm.warp(exp + 3650 days);
        escrow.refundExpired(idL);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR - 10 * DOLLAR);
    }

    // ------------------------------------------------------------------ T13 create expiry window

    function _createWithExpiry(uint256 expiresAt) internal returns (bytes32) {
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(recipient, bytes32("rsalt")), address(0), DOLLAR, expiresAt);
        return _create(i);
    }

    function _expectCreateRevert(uint256 expiresAt, uint256 validBefore, bytes4 err) internal {
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(recipient, bytes32("rsalt")), address(0), DOLLAR, expiresAt);
        i.validBefore = validBefore;
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(err);
        escrow.createPayment(i, s);
    }

    function test_T13_minExpiry_exact_ok() public {
        _createWithExpiry(block.timestamp + 1 days);
    }

    function test_T13_minExpiry_minus1_fails() public {
        _expectCreateRevert(block.timestamp + 1 days - 1, block.timestamp + 1 hours, IEverpieceEscrow.ExpiryOutOfRange.selector);
    }

    function test_T13_maxExpiry_exact_ok() public {
        _createWithExpiry(block.timestamp + 30 days);
    }

    function test_T13_maxExpiry_plus1_fails() public {
        _expectCreateRevert(block.timestamp + 30 days + 1, block.timestamp + 1 hours, IEverpieceEscrow.ExpiryOutOfRange.selector);
    }

    function test_T13_expiryInPast_fails() public {
        _expectCreateRevert(block.timestamp - 1, block.timestamp + 1 hours, IEverpieceEscrow.ExpiryOutOfRange.selector);
    }

    function test_T13_expiryCheckedAtExecutionTime() public {
        // Signed at T0 with exactly the 1-day minimum; bounds are checked against the execution timestamp.
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(recipient, bytes32("rsalt")), address(0), DOLLAR, block.timestamp + 1 days);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.warp(block.timestamp + 1); // relayed 1s late -> now + 1 day > expiresAt -> below minimum
        vm.expectRevert(IEverpieceEscrow.ExpiryOutOfRange.selector);
        escrow.createPayment(i, s);
    }

    // ------------------------------------------------------------------ T14 validBefore <= expiresAt

    function test_T14_validBeforeAfterExpiry_fails() public {
        uint256 e = block.timestamp + 1 days;
        _expectCreateRevert(e, e + 1, IEverpieceEscrow.ExpiryOutOfRange.selector);
    }

    function test_T14_validBeforeEqualsExpiry_ok() public {
        uint256 e = block.timestamp + 1 days;
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(recipient, bytes32("rsalt")), address(0), DOLLAR, e);
        i.validBefore = e;
        _create(i);
    }

    // ------------------------------------------------------------------ T15 signature deadlines

    function test_T15_claimDeadline_equalNow_ok() public {
        (bytes32 n, bytes memory s) = _usernameClaimArgs(block.timestamp);
        escrow.claimUsernamePayment(idU, recipient, bytes32("rsalt"), n, block.timestamp, s);
    }

    function test_T15_claimDeadline_past_fails() public {
        uint256 dl = block.timestamp - 1;
        (bytes32 n, bytes memory s) = _usernameClaimArgs(dl);
        vm.expectRevert(IEverpieceEscrow.SignatureExpired.selector);
        escrow.claimUsernamePayment(idU, recipient, bytes32("rsalt"), n, dl, s);
    }

    function test_T15_cancelDeadline_past_fails() public {
        uint256 dl = block.timestamp - 1;
        bytes memory s = _cancelSig(idU, SENDER_PK, bytes32("n"), dl);
        vm.expectRevert(IEverpieceEscrow.SignatureExpired.selector);
        escrow.cancel(idU, bytes32("n"), dl, s);
    }

    function test_T15_linkClaimKeyDeadline_past_fails() public {
        LinkArgs memory a = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.warp(a.deadline + 1);
        vm.expectRevert(IEverpieceEscrow.SignatureExpired.selector);
        _claimLink(idL, a);
    }

    function test_T15_approvalDeadline_past_fails() public {
        LinkArgs memory a = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.warp(a.approvalDeadline + 1); // approval (5 min) expired, claim-key sig (10 min) still live
        vm.expectRevert(IEverpieceEscrow.SignatureExpired.selector);
        _claimLink(idL, a);
    }

    function test_T15_approvalDeadline_equalNow_ok() public {
        LinkArgs memory a = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.warp(a.approvalDeadline);
        _claimLink(idL, a);
    }

    // ------------------------------------------------------------------ T16 ERC-3009 window (strict both ends)

    function test_T16_validAfterEqualsNow_fails() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.validAfter = block.timestamp;
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AuthorizationNotYetValid.selector);
        escrow.createPayment(i, s);
    }

    function test_T16_validAfterJustPast_ok() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.validAfter = block.timestamp - 1;
        _create(i);
    }

    function test_T16_validBeforeEqualsNow_fails() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.validBefore = block.timestamp;
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AuthorizationExpired.selector);
        escrow.createPayment(i, s);
    }

    function test_T16_validBeforeNowPlus1_ok() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        i.validBefore = block.timestamp + 1;
        _create(i);
    }
}
