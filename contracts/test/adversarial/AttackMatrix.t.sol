// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "../utils/EscrowBase.t.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Adversarial suite (master §44.2): every row of the required attack list, written against the deployed
///         contract's external surface as an attacker would use it. Each test name carries its matrix id (A01…).
///         Findings are written up in FINDINGS.md (master §44.3). Never delete a test here (master §0.11).
contract AttackMatrixTest is EscrowBase {
    bytes32 internal constant RSALT = bytes32("rsalt");
    bytes32 internal constant LSALT = bytes32("lsalt");
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes4 internal constant AUSD_INVALID_SIGNATURE = bytes4(keccak256("InvalidSignature()"));

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _u(uint256 amount) internal returns (bytes32) {
        return _create(_usernameIntent(amount));
    }

    function _l(uint256 amount) internal returns (bytes32) {
        return _create(_linkIntent(amount));
    }

    function _claimUsernameExpect(bytes32 id, address rcpt, bytes32 rsalt, uint256 pk, bytes32 nonce, bytes4 err) internal {
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory s = _sig(pk, escrow.hashClaimIntent(id, rcpt, nonce, dl));
        vm.expectRevert(err);
        vm.prank(relayer);
        escrow.claimUsernamePayment(id, rcpt, rsalt, nonce, dl, s);
    }

    function _claimLinkExpect(bytes32 id, LinkArgs memory a, bytes4 err) internal {
        vm.expectRevert(err);
        _claimLink(id, a);
    }

    function _cancelExpect(bytes32 id, uint256 pk, bytes32 nonce, bytes4 err) internal {
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory s = _cancelSig(id, pk, nonce, dl);
        vm.expectRevert(err);
        vm.prank(relayer);
        escrow.cancel(id, nonce, dl, s);
    }

    /// The other half of the secp256k1 signature pair: same signer, s → n − s, v flipped.
    function _highS(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    /// Solidity memory structs assign by reference: tamper with a real copy, never the original.
    function _copy(IEverpieceEscrow.PaymentIntent memory i) internal pure returns (IEverpieceEscrow.PaymentIntent memory) {
        return abi.decode(abi.encode(i), (IEverpieceEscrow.PaymentIntent));
    }

    function _assertSolvent() internal view {
        assertGe(ausd.balanceOf(address(escrow)), escrow.totalActiveLiability(), "escrow holds less than it owes");
    }

    // ============================================================================ A01–A06 terminal states
    function test_A01_doubleClaim_username_and_link() public {
        bytes32 u = _u(10 * DOLLAR);
        _claimUsername(u, recipient, RSALT, RECIPIENT_PK);
        _claimUsernameExpect(u, recipient, RSALT, RECIPIENT_PK, bytes32("second"), IEverpieceEscrow.PaymentNotActive.selector);

        bytes32 l = _l(10 * DOLLAR);
        _claimLink(l, _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK));
        LinkArgs memory again = _linkArgs(l, stranger, CLAIMKEY_PK, APPROVER_PK); // fresh nonces, different wallet
        _claimLinkExpect(l, again, IEverpieceEscrow.PaymentNotActive.selector);
        assertEq(ausd.balanceOf(recipient), 20 * DOLLAR);
        assertEq(ausd.balanceOf(stranger), 0);
    }

    function test_A02_doubleCancel() public {
        bytes32 id = _u(10 * DOLLAR);
        _cancel(id);
        _cancelExpect(id, SENDER_PK, bytes32("again"), IEverpieceEscrow.PaymentNotActive.selector);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_A03_doubleRefund() public {
        bytes32 id = _u(10 * DOLLAR);
        vm.warp(escrow.getPayment(id).expiresAt);
        escrow.refundExpired(id);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(id);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_A04_claimAfterCancel_bothModes() public {
        bytes32 u = _u(10 * DOLLAR);
        _cancel(u);
        _claimUsernameExpect(u, recipient, RSALT, RECIPIENT_PK, bytes32("n"), IEverpieceEscrow.PaymentNotActive.selector);
        bytes32 l = _l(10 * DOLLAR);
        _cancel(l);
        _claimLinkExpect(l, _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK), IEverpieceEscrow.PaymentNotActive.selector);
    }

    function test_A05_cancelAfterClaim() public {
        bytes32 id = _u(10 * DOLLAR);
        _claimUsername(id, recipient, RSALT, RECIPIENT_PK);
        _cancelExpect(id, SENDER_PK, bytes32("late"), IEverpieceEscrow.PaymentNotActive.selector);
    }

    function test_A06_refundAfterClaim_and_afterCancel() public {
        bytes32 a = _u(10 * DOLLAR);
        bytes32 b = _u(10 * DOLLAR);
        _claimUsername(a, recipient, RSALT, RECIPIENT_PK);
        _cancel(b);
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(a);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(b);
    }

    // ============================================================================ A07–A10 expiry and races
    function test_A07_claimAtExpiry_fails_oneSecondBefore_works() public {
        bytes32 a = _u(10 * DOLLAR);
        bytes32 b = _u(10 * DOLLAR);
        uint64 e = escrow.getPayment(a).expiresAt;
        vm.warp(e - 1);
        _claimUsername(a, recipient, RSALT, RECIPIENT_PK);
        vm.warp(e);
        _claimUsernameExpect(b, recipient, RSALT, RECIPIENT_PK, bytes32("b"), IEverpieceEscrow.PaymentExpired.selector);
        bytes32 l = _l(10 * DOLLAR);
        vm.warp(escrow.getPayment(l).expiresAt);
        _claimLinkExpect(l, _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK), IEverpieceEscrow.PaymentExpired.selector);
    }

    function test_A08_cancelAtExpiry_fails_refundOnlyFromExpiry() public {
        bytes32 id = _u(10 * DOLLAR);
        uint64 e = escrow.getPayment(id).expiresAt;
        vm.warp(e - 1);
        vm.expectRevert(IEverpieceEscrow.PaymentNotExpired.selector);
        escrow.refundExpired(id);
        vm.warp(e);
        _cancelExpect(id, SENDER_PK, bytes32("c"), IEverpieceEscrow.PaymentExpired.selector);
        escrow.refundExpired(id);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.REFUNDED));
    }

    /// No second where both a claim and a refund are possible, and none where neither is.
    function testFuzz_A09_exactBoundary_noGapNoOverlap(uint32 offset) public {
        bytes32 id = _u(10 * DOLLAR);
        uint64 e = escrow.getPayment(id).expiresAt;
        uint256 t = bound(uint256(offset), block.timestamp, uint256(e) + 2 days);
        vm.warp(t);
        bool claimable = !escrow.isExpired(id);
        uint256 snap = vm.snapshotState();
        if (claimable) {
            _claimUsername(id, recipient, RSALT, RECIPIENT_PK);
            vm.revertToState(snap);
            vm.expectRevert(IEverpieceEscrow.PaymentNotExpired.selector);
            escrow.refundExpired(id);
        } else {
            escrow.refundExpired(id);
            vm.revertToState(snap);
            _claimUsernameExpect(id, recipient, RSALT, RECIPIENT_PK, bytes32("x"), IEverpieceEscrow.PaymentExpired.selector);
        }
        assertEq(claimable, t < e);
    }

    function test_A10_claimCancelRace_firstWins_eitherOrder() public {
        for (uint256 order = 0; order < 2; order++) {
            uint256 snap = vm.snapshotState();
            bytes32 id = _u(10 * DOLLAR);
            // both signed off-chain before either lands
            bytes32 cn = bytes32("cancelN");
            uint256 dl = block.timestamp + 10 minutes;
            bytes memory cs = _cancelSig(id, SENDER_PK, cn, dl);
            bytes32 rn = bytes32("claimN");
            bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, rn, dl));
            if (order == 0) {
                escrow.claimUsernamePayment(id, recipient, RSALT, rn, dl, rs);
                vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
                escrow.cancel(id, cn, dl, cs);
                assertEq(ausd.balanceOf(recipient), 10 * DOLLAR);
            } else {
                escrow.cancel(id, cn, dl, cs);
                vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
                escrow.claimUsernamePayment(id, recipient, RSALT, rn, dl, rs);
                assertEq(ausd.balanceOf(recipient), 0);
            }
            assertEq(escrow.totalActiveLiability(), 0);
            _assertSolvent();
            vm.revertToState(snap);
        }
    }

    function test_A10b_claimRefundRace_atBoundary() public {
        bytes32 id = _u(10 * DOLLAR);
        uint64 e = escrow.getPayment(id).expiresAt;
        uint256 dl = uint256(e) + 1 hours;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.warp(e); // the claim was signed in time but lands at expiry: refund wins
        escrow.refundExpired(id);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("n"), dl, rs);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    // ============================================================================ A11–A17 signatures
    function test_A11_forgedSender_cannotCancel() public {
        bytes32 id = _u(10 * DOLLAR);
        _cancelExpect(id, STRANGER_PK, bytes32("f"), IEverpieceEscrow.InvalidSenderSignature.selector);
        _cancelExpect(id, RECIPIENT_PK, bytes32("f"), IEverpieceEscrow.InvalidSenderSignature.selector);
        _cancelExpect(id, APPROVER_PK, bytes32("f"), IEverpieceEscrow.InvalidSenderSignature.selector);
    }

    function test_A12_forgedRecipient_username() public {
        bytes32 id = _u(10 * DOLLAR);
        // the salt is not a secret (the directory holds it): knowing it must not be enough
        _claimUsernameExpect(id, stranger, RSALT, STRANGER_PK, bytes32("s"), IEverpieceEscrow.RecipientMismatch.selector);
        _claimUsernameExpect(id, recipient, RSALT, STRANGER_PK, bytes32("s"), IEverpieceEscrow.InvalidRecipientSignature.selector);
        // the sender, who knows everything about the payment, can't claim it either
        _claimUsernameExpect(id, recipient, RSALT, SENDER_PK, bytes32("s"), IEverpieceEscrow.InvalidRecipientSignature.selector);
        _claimUsernameExpect(id, recipient, bytes32("wrong"), RECIPIENT_PK, bytes32("s"), IEverpieceEscrow.RecipientMismatch.selector);
    }

    function test_A13_malformedSignatures_rejected() public {
        bytes32 id = _u(10 * DOLLAR);
        bytes32 n = bytes32("m");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory good = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, n, dl));
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(good, 32))
            s := mload(add(good, 64))
        }
        bytes[] memory bad = new bytes[](7);
        bad[0] = "";
        bad[1] = abi.encodePacked(r, s); // 64-byte EIP-2098 compact form is not accepted
        bad[2] = abi.encodePacked(good, uint8(0)); // 66 bytes
        bad[3] = abi.encodePacked(r, s, uint8(0));
        bad[4] = abi.encodePacked(r, s, uint8(29));
        bad[5] = abi.encodePacked(bytes32(0), s, uint8(27));
        bad[6] = abi.encodePacked(r, bytes32(0), uint8(27));
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
            escrow.claimUsernamePayment(id, recipient, RSALT, n, dl, bad[i]);
        }
        escrow.claimUsernamePayment(id, recipient, RSALT, n, dl, good);
    }

    function test_A14_signatureMalleability_highS_rejected() public {
        bytes32 id = _u(10 * DOLLAR);
        bytes32 n = bytes32("hs");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory good = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, n, dl));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, RSALT, n, dl, _highS(good));

        bytes32 c = _u(10 * DOLLAR);
        bytes memory cs = _cancelSig(c, SENDER_PK, n, dl);
        vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
        escrow.cancel(c, n, dl, _highS(cs));
        escrow.claimUsernamePayment(id, recipient, RSALT, n, dl, good);
    }

    function test_A15_staleDeadline_everyPath() public {
        bytes32 u = _u(10 * DOLLAR);
        uint256 past = block.timestamp - 1;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(u, recipient, bytes32("d"), past));
        vm.expectRevert(IEverpieceEscrow.SignatureExpired.selector);
        escrow.claimUsernamePayment(u, recipient, RSALT, bytes32("d"), past, rs);
        bytes memory cs = _cancelSig(u, SENDER_PK, bytes32("d"), past);
        vm.expectRevert(IEverpieceEscrow.SignatureExpired.selector);
        escrow.cancel(u, bytes32("d"), past, cs);

        bytes32 l = _l(10 * DOLLAR);
        LinkArgs memory a = _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.approvalDeadline = past;
        a.approverSig = _sig(APPROVER_PK, escrow.hashClaimApproval(l, recipient, a.approvalNonce, past));
        _claimLinkExpect(l, a, IEverpieceEscrow.SignatureExpired.selector);
        a = _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.deadline = past;
        a.claimKeySig = _sig(CLAIMKEY_PK, escrow.hashLinkClaimIntent(l, recipient, a.actionNonce, past));
        _claimLinkExpect(l, a, IEverpieceEscrow.SignatureExpired.selector);

        // a deadline of exactly now is still valid
        bytes memory now_ = _sig(RECIPIENT_PK, escrow.hashClaimIntent(u, recipient, bytes32("now"), block.timestamp));
        escrow.claimUsernamePayment(u, recipient, RSALT, bytes32("now"), block.timestamp, now_);
    }

    function test_A16_usedNonce_acrossPayments() public {
        bytes32 a = _u(10 * DOLLAR);
        bytes32 b = _u(10 * DOLLAR);
        bytes32 n = bytes32("same");
        uint256 dl = block.timestamp + 10 minutes;
        escrow.cancel(a, n, dl, _cancelSig(a, SENDER_PK, n, dl));
        bytes memory sb = _cancelSig(b, SENDER_PK, n, dl);
        vm.expectRevert(IEverpieceEscrow.NonceAlreadyUsed.selector);
        escrow.cancel(b, n, dl, sb);

        // the approver's nonce is single-use too, across payments
        bytes32 l1 = _l(10 * DOLLAR);
        bytes32 l2 = _l(10 * DOLLAR);
        LinkArgs memory x = _linkArgs(l1, recipient, CLAIMKEY_PK, APPROVER_PK);
        _claimLink(l1, x);
        LinkArgs memory y = _linkArgs(l2, recipient, CLAIMKEY_PK, APPROVER_PK);
        y.approvalNonce = x.approvalNonce;
        y.approverSig = _sig(APPROVER_PK, escrow.hashClaimApproval(l2, recipient, y.approvalNonce, y.approvalDeadline));
        _claimLinkExpect(l2, y, IEverpieceEscrow.NonceAlreadyUsed.selector);
    }

    function test_A17_replayAcrossPaymentIds() public {
        bytes32 a = _u(10 * DOLLAR);
        bytes32 b = _u(10 * DOLLAR);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory forA = _sig(RECIPIENT_PK, escrow.hashClaimIntent(a, recipient, bytes32("r"), dl));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(b, recipient, RSALT, bytes32("r"), dl, forA);
        bytes memory cancelA = _cancelSig(a, SENDER_PK, bytes32("c"), dl);
        vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
        escrow.cancel(b, bytes32("c"), dl, cancelA);

        bytes32 l1 = _l(10 * DOLLAR);
        bytes32 l2 = _l(10 * DOLLAR);
        LinkArgs memory x = _linkArgs(l1, recipient, CLAIMKEY_PK, APPROVER_PK);
        _claimLinkExpect(l2, x, IEverpieceEscrow.InvalidClaimKeySignature.selector);
    }

    // ============================================================================ A18–A19 domain replay
    function test_A18_crossChainReplay() public {
        bytes32 id = _u(10 * DOLLAR);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory onMainnet = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("x"), dl));
        bytes memory cancelMainnet = _cancelSig(id, SENDER_PK, bytes32("x"), dl);
        vm.chainId(10143);
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("x"), dl, onMainnet);
        vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
        escrow.cancel(id, bytes32("x"), dl, cancelMainnet);
        // and a funding signature from chain 143 can't create the same intent on 10143
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        vm.chainId(143);
        bytes memory f = _fundingSig(SENDER_PK, i);
        vm.chainId(10143);
        vm.expectRevert(AUSD_INVALID_SIGNATURE);
        escrow.createPayment(i, f);
    }

    function test_A19_crossContractReplay() public {
        address second = 0x2222222222222222222222222222222222222222;
        deployCodeTo("EverpieceEscrow.sol:EverpieceEscrow", abi.encode(AUSD_ADDR, owner, approver), second);
        EverpieceEscrow other = EverpieceEscrow(second);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory f = _fundingSig(SENDER_PK, i); // signed for `escrow`
        vm.expectRevert(AUSD_INVALID_SIGNATURE);
        other.createPayment(i, f);

        bytes32 id = escrow.createPayment(i, f);
        bytes32 idOther = other.paymentIdOf(i);
        assertTrue(id != idOther, "same intent must have a different id per contract");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory c = _cancelSig(id, SENDER_PK, bytes32("y"), dl);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        other.cancel(id, bytes32("y"), dl, c);
    }

    // ============================================================================ A20–A23 funding authorization
    function test_A20_erc3009AuthorizationReuse() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory f = _fundingSig(SENDER_PK, i);
        escrow.createPayment(i, f);
        vm.expectRevert(IEverpieceEscrow.PaymentExists.selector);
        escrow.createPayment(i, f);
        // the same signature for a fresh intent (new salt) is a different nonce/digest → AUSD refuses it
        IEverpieceEscrow.PaymentIntent memory j = _copy(i);
        j.salt = bytes32("another");
        vm.expectRevert(AUSD_INVALID_SIGNATURE);
        escrow.createPayment(j, f);
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
    }

    function test_A21_tokenAuthorizationSubstitution() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 pid = escrow.paymentIdOf(i);
        // a TransferWithAuthorization (anyone-can-submit) signature is not a ReceiveWithAuthorization
        bytes memory twa = _sig(SENDER_PK, _ausdDigest(TWA_TYPEHASH, sender, address(escrow), i.amount, i.validAfter, i.validBefore, pid));
        vm.expectRevert(AUSD_INVALID_SIGNATURE);
        escrow.createPayment(i, twa);
        // a receive authorization made out to someone else
        bytes memory toStranger = _sig(SENDER_PK, _ausdDigest(RWA_TYPEHASH, sender, stranger, i.amount, i.validAfter, i.validBefore, pid));
        vm.expectRevert(AUSD_INVALID_SIGNATURE);
        escrow.createPayment(i, toStranger);
        // signed by someone other than the intent's sender
        bytes memory byStranger = _fundingSig(STRANGER_PK, i);
        vm.expectRevert(AUSD_INVALID_SIGNATURE);
        escrow.createPayment(i, byStranger);
        // the sender's ERC-3009 nonce can't be front-run straight into the token: only the escrow may receive
        bytes memory real = _fundingSig(SENDER_PK, i);
        vm.expectRevert(abi.encodeWithSelector(IAUSD.InvalidPayee.selector, stranger, address(escrow)));
        vm.prank(stranger);
        ausd.receiveWithAuthorization(sender, address(escrow), i.amount, i.validAfter, i.validBefore, pid, real);
    }

    /// The relayer (or anyone holding the signed intent) changes one term: AUSD rejects the funding signature.
    function test_A22_changedTerms_eachRejected() public {
        IEverpieceEscrow.PaymentIntent memory i = _linkIntent(10 * DOLLAR);
        bytes memory f = _fundingSig(SENDER_PK, i);
        for (uint256 k = 0; k < 8; k++) {
            IEverpieceEscrow.PaymentIntent memory m = _copy(i);
            if (k == 0) m.amount = 11 * DOLLAR;
            if (k == 1) m.recipientCommitment = _linkRc(stranger, LSALT);
            if (k == 2) m.expiresAt = i.expiresAt - 1 days;
            if (k == 3) m.metadataCommitment = keccak256("other");
            if (k == 4) m.salt = bytes32("s2");
            if (k == 5) m.validBefore = i.validBefore - 1;
            if (k == 6) m.validAfter = 1;
            if (k == 7) {
                m.mode = USERNAME;
                m.approver = address(0);
            }
            vm.expectRevert(AUSD_INVALID_SIGNATURE);
            escrow.createPayment(m, f);
        }
        escrow.createPayment(i, f);
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
    }

    function test_A23_approverMustMatchMode() public {
        IEverpieceEscrow.PaymentIntent memory l = _linkIntent(10 * DOLLAR);
        l.approver = stranger; // an approver of the attacker's choosing
        bytes memory f = _fundingSig(SENDER_PK, l);
        vm.expectRevert(IEverpieceEscrow.ApproverMismatch.selector);
        escrow.createPayment(l, f);
        IEverpieceEscrow.PaymentIntent memory u = _usernameIntent(10 * DOLLAR);
        u.approver = approver;
        f = _fundingSig(SENDER_PK, u);
        vm.expectRevert(IEverpieceEscrow.ApproverMismatch.selector);
        escrow.createPayment(u, f);
        IEverpieceEscrow.PaymentIntent memory bad = _usernameIntent(10 * DOLLAR);
        bad.mode = 3;
        f = _fundingSig(SENDER_PK, bad);
        vm.expectRevert(IEverpieceEscrow.InvalidMode.selector);
        escrow.createPayment(bad, f);
    }

    // ============================================================================ A24–A29 who may claim
    function test_A24_senderCannotClaimOwnUsernamePayment() public {
        bytes32 id = _u(10 * DOLLAR);
        _claimUsernameExpect(id, sender, RSALT, SENDER_PK, bytes32("own"), IEverpieceEscrow.RecipientMismatch.selector);
        _claimLinkExpect(id, _linkArgs(id, sender, CLAIMKEY_PK, APPROVER_PK), IEverpieceEscrow.WrongMode.selector);
    }

    function test_A25_linkKeyWithoutApproval() public {
        bytes32 id = _l(10 * DOLLAR);
        LinkArgs memory a = _linkArgs(id, stranger, CLAIMKEY_PK, STRANGER_PK); // approval forged by the link holder
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidApproverSignature.selector);
        a.approverSig = "";
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidApproverSignature.selector);
        // approval signed by the sender (who knows the claim key too) is not the approver's
        a = _linkArgs(id, stranger, CLAIMKEY_PK, SENDER_PK);
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidApproverSignature.selector);
    }

    function test_A26_approvalWithoutLinkKey_approverAloneCannotClaim() public {
        bytes32 id = _l(10 * DOLLAR);
        LinkArgs memory a = _linkArgs(id, stranger, STRANGER_PK, APPROVER_PK); // wrong claim key
        _claimLinkExpect(id, a, IEverpieceEscrow.LinkRevealMismatch.selector);
        a = _linkArgs(id, stranger, CLAIMKEY_PK, APPROVER_PK);
        a.claimKeySig = _sig(STRANGER_PK, escrow.hashLinkClaimIntent(id, stranger, a.actionNonce, a.deadline));
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidClaimKeySignature.selector);
        // the approver presenting itself as the claim key
        a = _linkArgs(id, stranger, APPROVER_PK, APPROVER_PK);
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidClaimKey.selector);
    }

    function test_A27_approvalBoundToADifferentWallet() public {
        bytes32 id = _l(10 * DOLLAR);
        LinkArgs memory a = _linkArgs(id, stranger, CLAIMKEY_PK, APPROVER_PK);
        // the approver approved `recipient` (who passed the code), the link holder claims to `stranger`
        a.approverSig = _sig(APPROVER_PK, escrow.hashClaimApproval(id, recipient, a.approvalNonce, a.approvalDeadline));
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidApproverSignature.selector);
    }

    function test_A28_redirectApprovedClaim() public {
        bytes32 id = _l(10 * DOLLAR);
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK); // everything signed for `recipient`
        a.recipient = stranger; // the relayer swaps the payee
        _claimLinkExpect(id, a, IEverpieceEscrow.InvalidClaimKeySignature.selector);
        a.recipient = recipient;
        _claimLink(id, a);
        assertEq(ausd.balanceOf(recipient), 10 * DOLLAR);
    }

    function test_A29_approverRotation_existingPaymentsKeepTheirSnapshot() public {
        bytes32 id = _l(10 * DOLLAR);
        vm.prank(owner);
        escrow.setClaimApprover(approver2);
        _claimLinkExpect(id, _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER2_PK), IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK));
        // new link payments need the new approver; the old one is refused for them
        bytes32 n2 = _l(10 * DOLLAR);
        assertEq(escrow.getPayment(n2).approver, approver2);
        _claimLinkExpect(n2, _linkArgs(n2, recipient, CLAIMKEY_PK, APPROVER_PK), IEverpieceEscrow.InvalidApproverSignature.selector);
    }

    // ============================================================================ A31–A35 caps, pause, admin, accounting
    function test_A31_paymentCapBypass() public {
        uint256 maxPay = escrow.MAX_PAYMENT_CEILING();
        uint256 maxLiab = escrow.MAX_LIABILITY_CEILING();
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(maxPay + 1);
        bytes memory f = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.AmountAboveCap.selector);
        escrow.createPayment(i, f);
        vm.startPrank(owner);
        vm.expectRevert(IEverpieceEscrow.CapAboveCeiling.selector);
        escrow.setCaps(maxPay + 1, maxLiab);
        vm.expectRevert(IEverpieceEscrow.CapAboveCeiling.selector);
        escrow.setCaps(maxPay, maxLiab + 1);
        escrow.setCaps(100 * DOLLAR, 150 * DOLLAR);
        vm.stopPrank();
        _u(100 * DOLLAR);
        i = _usernameIntent(100 * DOLLAR); // 200 > 150: split payments don't get around the aggregate cap
        f = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.LiabilityCapExceeded.selector);
        escrow.createPayment(i, f);
        _u(50 * DOLLAR); // exactly at the cap is fine
        assertEq(escrow.totalActiveLiability(), 150 * DOLLAR);
    }

    /// FINDING A32 (MEDIUM, FINDINGS.md): the aggregate liability cap is global, so one funded account can fill it
    /// with its own payments and block everyone else's sends, then cancel to get every cent back. This test
    /// reproduces it and pins the current behavior; it changes only if the contract changes (owner decision).
    function test_A32_FINDING_globalLiabilityCap_griefing() public {
        uint256 attackerPk = 0xA77AC;
        address attacker = vm.addr(attackerPk);
        ausd.mint(attacker, 5_000 * DOLLAR);
        bytes32[] memory ids = new bytes32[](10);
        for (uint256 k = 0; k < 10; k++) {
            IEverpieceEscrow.PaymentIntent memory g = _usernameIntent(500 * DOLLAR);
            g.sender = attacker;
            g.recipientCommitment = _usernameRc(attacker, bytes32(k));
            ids[k] = escrow.createPayment(g, _fundingSig(attackerPk, g));
        }
        assertEq(escrow.totalActiveLiability(), escrow.maxActiveLiability());
        // an honest $1 payment is now refused for everyone
        IEverpieceEscrow.PaymentIntent memory honest = _usernameIntent(1 * DOLLAR);
        bytes memory f = _fundingSig(SENDER_PK, honest);
        vm.expectRevert(IEverpieceEscrow.LiabilityCapExceeded.selector);
        escrow.createPayment(honest, f);
        // ...and the attacker loses nothing: cancel returns every cent
        uint256 dl = block.timestamp + 10 minutes;
        for (uint256 k = 0; k < 10; k++) {
            escrow.cancel(ids[k], bytes32(k), dl, _sig(attackerPk, escrow.hashCancelIntent(ids[k], attacker, bytes32(k), dl)));
        }
        assertEq(ausd.balanceOf(attacker), 5_000 * DOLLAR);
        escrow.createPayment(honest, f); // capacity is back once the attacker lets go
    }

    function test_A33_pauseNeverTrapsFunds() public {
        bytes32 a = _u(10 * DOLLAR);
        bytes32 b = _u(10 * DOLLAR);
        bytes32 l = _l(10 * DOLLAR);
        vm.prank(owner);
        escrow.pause();
        _claimUsernameExpect(a, recipient, RSALT, RECIPIENT_PK, bytes32("p"), Pausable.EnforcedPause.selector);
        _claimLinkExpect(l, _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK), Pausable.EnforcedPause.selector);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(1 * DOLLAR);
        bytes memory f = _fundingSig(SENDER_PK, i);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createPayment(i, f);
        _cancel(a); // cancel works while paused
        vm.warp(escrow.getPayment(b).expiresAt);
        escrow.refundExpired(b); // and so does refund
        escrow.refundExpired(l);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_A34_adminCannotSeizeOrMoveFunds() public {
        bytes32 u = _u(100 * DOLLAR);
        bytes32 l = _l(100 * DOLLAR);
        uint256 held = ausd.balanceOf(address(escrow));
        // every owner power, used together
        vm.startPrank(owner);
        escrow.pause();
        escrow.setCaps(0, 0);
        escrow.setClaimApprover(owner);
        escrow.unpause();
        vm.expectRevert(IEverpieceEscrow.RenounceDisabled.selector);
        escrow.renounceOwnership();
        vm.stopPrank();
        assertEq(ausd.balanceOf(address(escrow)), held);
        // the owner as "approver" still can't take a link payment created before the change: it has no claim key
        uint256 ownerPk = 0x0B5;
        vm.prank(owner);
        escrow.setClaimApprover(vm.addr(ownerPk));
        _claimLinkExpect(l, _linkArgs(l, owner, CLAIMKEY_PK, ownerPk), IEverpieceEscrow.InvalidApproverSignature.selector);
        // and can't cancel someone else's payment to itself
        _cancelExpect(u, ownerPk, bytes32("o"), IEverpieceEscrow.InvalidSenderSignature.selector);
        // non-owners have no powers at all
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setCaps(1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setClaimApprover(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.transferOwnership(stranger);
        vm.stopPrank();
        // the rightful parties are unaffected
        _claimUsername(u, recipient, RSALT, RECIPIENT_PK);
        _claimLink(l, _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK));
        assertEq(ausd.balanceOf(recipient), 200 * DOLLAR);
    }

    function test_A35_liabilityMismatch_fundingAndPayoutShortfalls() public {
        ausd.setFundingShortfall(1);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory f = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.FundingMismatch.selector);
        escrow.createPayment(i, f);
        ausd.setFundingShortfall(0);
        bytes32 id = escrow.createPayment(i, f);
        ausd.setPayoutShortfall(1);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("ps"), dl));
        vm.expectRevert(IEverpieceEscrow.PayoutMismatch.selector);
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("ps"), dl, rs);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE)); // all-or-nothing
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
        ausd.setPayoutShortfall(0);
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("ps"), dl, rs);
        _assertSolvent();
    }

    // ============================================================================ A36–A40 edges
    function test_A36_unsolicitedAusd_neitherBreaksAccountingNorCanBeTaken() public {
        bytes32 id = _u(10 * DOLLAR);
        ausd.mint(stranger, 77 * DOLLAR);
        vm.prank(stranger);
        ausd.transfer(address(escrow), 77 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
        _claimUsername(id, recipient, RSALT, RECIPIENT_PK);
        assertEq(ausd.balanceOf(recipient), 10 * DOLLAR); // exactly the payment, not a cent of the extra
        assertEq(ausd.balanceOf(address(escrow)), 77 * DOLLAR); // stranded by design: there is no sweep (INFO)
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_A37_zeroAndBoundaryValues() public {
        IEverpieceEscrow.PaymentIntent memory z = _usernameIntent(0);
        bytes memory f = _fundingSig(SENDER_PK, z);
        vm.expectRevert(IEverpieceEscrow.ZeroAmount.selector);
        escrow.createPayment(z, f);
        _u(1); // one unit (a millionth of a dollar)
        _u(escrow.MAX_PAYMENT_CEILING());

        IEverpieceEscrow.PaymentIntent memory e = _usernameIntent(DOLLAR);
        e.expiresAt = block.timestamp + 1 days - 1;
        f = _fundingSig(SENDER_PK, e);
        vm.expectRevert(IEverpieceEscrow.ExpiryOutOfRange.selector);
        escrow.createPayment(e, f);
        e.expiresAt = block.timestamp + 30 days + 1;
        f = _fundingSig(SENDER_PK, e);
        vm.expectRevert(IEverpieceEscrow.ExpiryOutOfRange.selector);
        escrow.createPayment(e, f);
        e.expiresAt = block.timestamp + 1 days;
        escrow.createPayment(e, _fundingSig(SENDER_PK, e));

        IEverpieceEscrow.PaymentIntent memory r = _usernameIntent(DOLLAR);
        r.recipientCommitment = bytes32(0);
        f = _fundingSig(SENDER_PK, r);
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientCommitment.selector);
        escrow.createPayment(r, f);
        IEverpieceEscrow.PaymentIntent memory s = _usernameIntent(DOLLAR);
        s.sender = address(escrow);
        vm.expectRevert(IEverpieceEscrow.InvalidSender.selector);
        escrow.createPayment(s, "");

        bytes32 id = _u(DOLLAR);
        _claimUsernameExpect(id, address(0), RSALT, RECIPIENT_PK, bytes32("z"), IEverpieceEscrow.InvalidRecipient.selector);
        _claimUsernameExpect(id, address(escrow), RSALT, RECIPIENT_PK, bytes32("z"), IEverpieceEscrow.InvalidRecipient.selector);
    }

    function test_A38_tokenTransferRevert_isAllOrNothing() public {
        bytes32 id = _u(10 * DOLLAR);
        ausd.setTransferReverts(true);
        _claimUsernameExpect(id, recipient, RSALT, RECIPIENT_PK, bytes32("t"), bytes4(keccak256("ForcedRevert()")));
        ausd.setTransferReverts(false);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("t"), dl));
        ausd.setTransferReturnsFalse(true);
        vm.expectRevert(abi.encodeWithSignature("SafeERC20FailedOperation(address)", AUSD_ADDR));
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("t"), dl, rs);
        ausd.setTransferReturnsFalse(false);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
        // a frozen recipient can't receive, but the sender can still take the money back
        ausd.setFrozen(recipient, true);
        vm.expectRevert(abi.encodeWithSelector(IAUSD.AccountIsFrozen.selector, recipient));
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("t"), dl, rs);
        _cancel(id);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    /// The relayer submits signed actions; any change to what was signed fails.
    function test_A39_relayerManipulationOfSignedTerms() public {
        bytes32 id = _u(10 * DOLLAR);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.startPrank(relayer);
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("n"), dl + 1, rs); // extended deadline
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, RSALT, bytes32("m"), dl, rs); // different nonce
        vm.stopPrank();

        bytes32 l = _l(10 * DOLLAR);
        LinkArgs memory a = _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK);
        LinkArgs memory m = _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK);
        m.approvalDeadline = a.approvalDeadline + 1 hours; // stretch the short-lived approval
        _claimLinkExpect(l, m, IEverpieceEscrow.InvalidApproverSignature.selector);
        m = _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK);
        m.approvalNonce = bytes32("other");
        _claimLinkExpect(l, m, IEverpieceEscrow.InvalidApproverSignature.selector);
        m = _linkArgs(l, recipient, CLAIMKEY_PK, APPROVER_PK);
        m.recipientSalt = bytes32("x");
        _claimLinkExpect(l, m, IEverpieceEscrow.LinkRevealMismatch.selector);
        _claimLink(l, a); // the untouched submission still works
    }

    function test_A40_modeConfusion() public {
        bytes32 u = _u(10 * DOLLAR);
        bytes32 l = _l(10 * DOLLAR);
        _claimLinkExpect(u, _linkArgs(u, recipient, CLAIMKEY_PK, APPROVER_PK), IEverpieceEscrow.WrongMode.selector);
        _claimUsernameExpect(l, recipient, LSALT, RECIPIENT_PK, bytes32("w"), IEverpieceEscrow.WrongMode.selector);
        // commitments are domain-separated by mode: a username commitment never opens as a link one
        assertTrue(_usernameRc(claimKey, LSALT) != _linkRc(claimKey, LSALT));
    }

    // ============================================================================ fuzz: nobody else can take it
    function testFuzz_strangerCanNeverClaimOrCancel(uint256 pk, bytes32 nonce) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        vm.assume(pk != SENDER_PK && pk != RECIPIENT_PK && pk != CLAIMKEY_PK && pk != APPROVER_PK);
        address who = vm.addr(pk);
        bytes32 u = _u(10 * DOLLAR);
        bytes32 l = _l(10 * DOLLAR);
        _claimUsernameExpect(u, who, RSALT, pk, nonce, IEverpieceEscrow.RecipientMismatch.selector);
        _cancelExpect(u, pk, nonce, IEverpieceEscrow.InvalidSenderSignature.selector);
        _claimLinkExpect(l, _linkArgs(l, who, pk, pk), IEverpieceEscrow.LinkRevealMismatch.selector);
        assertEq(escrow.totalActiveLiability(), 20 * DOLLAR);
        _assertSolvent();
    }
}
