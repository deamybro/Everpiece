// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../src/interfaces/IEverpieceEscrow.sol";
import {EverpieceEscrow} from "../src/EverpieceEscrow.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";
import {MockAUSD} from "./utils/MockAUSD.sol";

/// @notice Replay, term binding, authorization substitution and claim-authorization attacks (T30–T58).
contract AuthorizationTest is EscrowBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function _expectFundingRevert(IEverpieceEscrow.PaymentIntent memory i, bytes memory s, bytes4 err) internal {
        uint256 liab = escrow.totalActiveLiability();
        vm.expectRevert(err);
        escrow.createPayment(i, s);
        assertEq(escrow.totalActiveLiability(), liab);
        assertEq(uint8(_status(escrow.paymentIdOf(i))), 0);
    }

    // =================================================================== T30 replay of create

    function test_T30_duplicateCreate_reverts() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        escrow.createPayment(i, s);
        vm.expectRevert(IEverpieceEscrow.PaymentExists.selector);
        escrow.createPayment(i, s);
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
    }

    function test_T30_recreateAfterTerminal_reverts() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        bytes32 id = escrow.createPayment(i, s);
        _cancel(id);
        vm.expectRevert(IEverpieceEscrow.PaymentExists.selector);
        escrow.createPayment(i, s);
    }

    // =================================================================== T31 / T32 cross-chain, cross-contract

    function test_T31_crossChain_fundingSigRejected() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        vm.chainId(10143);
        bytes memory s = _fundingSig(SENDER_PK, i); // paymentId and AUSD domain computed on chain 10143
        vm.chainId(143);
        _expectFundingRevert(i, s, MockAUSD.InvalidSignature.selector);
    }

    function test_T31_crossChain_claimSigRejected() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        vm.chainId(10143);
        bytes memory s = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.chainId(143);
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, s);
    }

    function test_T32_crossContract_fundingAndClaimRejected() public {
        EverpieceEscrow other = new EverpieceEscrow(IAUSD(AUSD_ADDR), owner, approver);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 otherId = other.paymentIdOf(i);
        assertTrue(otherId != escrow.paymentIdOf(i));
        bytes memory sOther = _sig(
            SENDER_PK, _ausdDigest(RWA_TYPEHASH, sender, address(other), i.amount, i.validAfter, i.validBefore, otherId)
        );
        _expectFundingRevert(i, sOther, MockAUSD.InvalidSignature.selector);

        // a claim signed for the other escrow's domain is useless here
        bytes32 id = _create(i);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _sig(RECIPIENT_PK, other.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, cs);
    }

    // =================================================================== T33–T39 every intent field is bound

    function _tamperAndExpectInvalid(uint256 field) internal {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i); // signed over the original terms
        if (field == 0) i.amount += 1;
        else if (field == 1) i.expiresAt -= 1;
        else if (field == 2) i.recipientCommitment = _usernameRc(stranger, bytes32("rsalt"));
        else if (field == 3) i.metadataCommitment = keccak256("other message");
        else if (field == 4) i.salt = bytes32(uint256(i.salt) + 1);
        else if (field == 5) i.validBefore -= 1;
        else if (field == 6) i.validAfter = 1;
        else if (field == 7) {
            i.mode = LINK;
            i.approver = approver;
        }
        _expectFundingRevert(i, s, MockAUSD.InvalidSignature.selector);
    }

    function test_T33_changedAmount() public { _tamperAndExpectInvalid(0); }
    function test_T34_changedExpiry() public { _tamperAndExpectInvalid(1); }
    function test_T35_changedRecipient() public { _tamperAndExpectInvalid(2); }
    function test_T36_changedMetadata() public { _tamperAndExpectInvalid(3); }
    function test_T37_changedSalt() public { _tamperAndExpectInvalid(4); }
    function test_T38_changedValidBefore() public { _tamperAndExpectInvalid(5); }
    function test_T38_changedValidAfter() public { _tamperAndExpectInvalid(6); }
    function test_T39_changedMode() public { _tamperAndExpectInvalid(7); }

    function test_T39_changedApprover() public {
        IEverpieceEscrow.PaymentIntent memory i = _linkIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.prank(owner);
        escrow.setClaimApprover(approver2);
        i.approver = approver2; // passes the "current approver" check, but not the sender's signature
        _expectFundingRevert(i, s, MockAUSD.InvalidSignature.selector);
    }

    function test_T39_changedSender() public {
        ausd.mint(stranger, 1_000 * DOLLAR);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        i.sender = stranger; // try to charge someone else with the sender's signature
        _expectFundingRevert(i, s, MockAUSD.InvalidSignature.selector);
        assertEq(ausd.balanceOf(stranger), 1_000 * DOLLAR);
    }

    // =================================================================== T40–T42 authorization substitution

    function test_T40_authorizationForPaymentA_usedForPaymentB() public {
        IEverpieceEscrow.PaymentIntent memory a = _usernameIntent(10 * DOLLAR);
        IEverpieceEscrow.PaymentIntent memory b = _usernameIntent(10 * DOLLAR);
        bytes memory sA = _fundingSig(SENDER_PK, a);
        _expectFundingRevert(b, sA, MockAUSD.InvalidSignature.selector);
        escrow.createPayment(a, sA); // A itself still works
    }

    function test_T41_authorizationCancelledOnAusd() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        bytes32 pid = escrow.paymentIdOf(i);
        bytes32 cancelDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ausd.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(ausd.CANCEL_AUTHORIZATION_TYPEHASH(), sender, pid))
            )
        );
        ausd.cancelAuthorization(sender, pid, _sig(SENDER_PK, cancelDigest));
        _expectFundingRevert(i, s, MockAUSD.UsedOrCanceledAuthorization.selector);
    }

    function test_T42_transferWithAuthorizationSig_rejected() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 pid = escrow.paymentIdOf(i);
        bytes memory s =
            _sig(SENDER_PK, _ausdDigest(TWA_TYPEHASH, sender, address(escrow), i.amount, i.validAfter, i.validBefore, pid));
        _expectFundingRevert(i, s, MockAUSD.InvalidSignature.selector);
    }

    function test_T42_directAusdConsumptionByThirdParty_blockedByPayeeCheck() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        bytes32 pid = escrow.paymentIdOf(i);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MockAUSD.InvalidPayee.selector, stranger, address(escrow)));
        ausd.receiveWithAuthorization(sender, address(escrow), i.amount, i.validAfter, i.validBefore, pid, s);
        escrow.createPayment(i, s); // the legitimate path is unaffected
    }

    // =================================================================== T43 terminal replays

    function test_T43_claimSigReplayAfterClaim() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, s);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, s);
    }

    function test_T43_doubleClaimLink_doubleCancel_doubleRefund() public {
        bytes32 idL = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(idL, recipient, CLAIMKEY_PK, APPROVER_PK);
        _claimLink(idL, a);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        _claimLink(idL, a);

        bytes32 idC = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(idC, SENDER_PK, bytes32("c"), dl);
        escrow.cancel(idC, bytes32("c"), dl, cs);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.cancel(idC, bytes32("c"), dl, cs);

        IEverpieceEscrow.PaymentIntent memory iR = _usernameIntent(10 * DOLLAR);
        bytes32 idR = _create(iR);
        vm.warp(iR.expiresAt);
        escrow.refundExpired(idR);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(idR);
    }

    function test_T43_crossTerminalTransitions() public {
        // claim then cancel / refund
        bytes32 id1 = _create(_usernameIntent(10 * DOLLAR));
        _claimUsername(id1, recipient, bytes32("rsalt"), RECIPIENT_PK);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(id1, SENDER_PK, bytes32("c1"), dl);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.cancel(id1, bytes32("c1"), dl, cs);
        // cancel then claim
        bytes32 id2 = _create(_usernameIntent(10 * DOLLAR));
        _cancel(id2);
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id2, recipient, bytes32("r"), dl));
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.claimUsernamePayment(id2, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        // refunds on terminal payments
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(id1);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(id2);
    }

    function test_unknownPayment_allPathsRevert() public {
        bytes32 id = bytes32("unknown");
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32(0), bytes32(0), block.timestamp, "");
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.claimLinkPayment(id, recipient, claimKey, bytes32(0), bytes32(0), block.timestamp, "", bytes32(0), block.timestamp, "");
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.cancel(id, bytes32(0), block.timestamp, "");
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(id);
    }

    // =================================================================== T44 nonce reuse across payments

    function test_T44_recipientNonceReuseAcrossPayments() public {
        bytes32 id1 = _create(_usernameIntent(10 * DOLLAR));
        bytes32 id2 = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes32 n = bytes32("same");
        escrow.claimUsernamePayment(id1, recipient, bytes32("rsalt"), n, dl, _sig(RECIPIENT_PK, escrow.hashClaimIntent(id1, recipient, n, dl)));
        bytes memory s2 = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id2, recipient, n, dl));
        vm.expectRevert(IEverpieceEscrow.NonceAlreadyUsed.selector);
        escrow.claimUsernamePayment(id2, recipient, bytes32("rsalt"), n, dl, s2);
    }

    function test_T44_senderCancelNonceReuse() public {
        bytes32 id1 = _create(_usernameIntent(10 * DOLLAR));
        bytes32 id2 = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        escrow.cancel(id1, bytes32("n"), dl, _cancelSig(id1, SENDER_PK, bytes32("n"), dl));
        bytes memory s2 = _cancelSig(id2, SENDER_PK, bytes32("n"), dl);
        vm.expectRevert(IEverpieceEscrow.NonceAlreadyUsed.selector);
        escrow.cancel(id2, bytes32("n"), dl, s2);
    }

    function test_T44_approvalNonceReuseAcrossPayments() public {
        bytes32 id1 = _create(_linkIntent(10 * DOLLAR));
        bytes32 id2 = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a1 = _linkArgs(id1, recipient, CLAIMKEY_PK, APPROVER_PK);
        _claimLink(id1, a1);
        LinkArgs memory a2 = _linkArgs(id2, recipient, CLAIMKEY_PK, APPROVER_PK);
        a2.approvalNonce = a1.approvalNonce; // approver's nonce reused
        a2.approverSig = _sig(APPROVER_PK, escrow.hashClaimApproval(id2, recipient, a2.approvalNonce, a2.approvalDeadline));
        vm.expectRevert(IEverpieceEscrow.NonceAlreadyUsed.selector);
        _claimLink(id2, a2);
    }

    // =================================================================== T45 malformed / malleable signatures

    function test_T45_highS_rejected() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        bytes memory malleated = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, malleated);
    }

    function test_T45_malformedSignatures_rejected() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        bytes[5] memory bad = [
            bytes(""),
            abi.encodePacked(r, vs), // 64-byte EIP-2098 compact: not accepted by escrow (EOA 65-byte only)
            abi.encodePacked(r, s, v, uint8(0)), // 66 bytes
            abi.encodePacked(r, s, uint8(29)), // bad v
            abi.encodePacked(bytes32(0), bytes32(0), uint8(27)) // zero sig
        ];
        for (uint256 k; k < bad.length; ++k) {
            vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
            escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, bad[k]);
        }
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
    }

    // =================================================================== T46 role / type confusion

    function test_T46_claimKeySignsWrongType_rejected() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.claimKeySig = _sig(CLAIMKEY_PK, escrow.hashClaimIntent(id, recipient, a.actionNonce, a.deadline)); // ClaimIntent, not LinkClaimIntent
        vm.expectRevert(IEverpieceEscrow.InvalidClaimKeySignature.selector);
        _claimLink(id, a);
    }

    function test_T46_approverSignsWrongType_rejected() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.approverSig = _sig(APPROVER_PK, escrow.hashLinkClaimIntent(id, recipient, a.approvalNonce, a.approvalDeadline));
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, a);
    }

    function test_T46_cancelSigCannotClaim_claimSigCannotCancel() public {
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(USERNAME, _usernameRc(sender, bytes32("rsalt")), address(0), 10 * DOLLAR, block.timestamp + 2 days);
        bytes32 id = _create(i); // sender is also the committed recipient
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cancelSig = _cancelSig(id, SENDER_PK, bytes32("n"), dl);
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, sender, bytes32("rsalt"), bytes32("n"), dl, cancelSig);
        bytes memory claimSig = _sig(SENDER_PK, escrow.hashClaimIntent(id, sender, bytes32("n"), dl));
        vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
        escrow.cancel(id, bytes32("n"), dl, claimSig);
    }

    // =================================================================== T50 unauthorized username sender claim

    function test_T50_senderCannotClaimUsernamePayment_asSelf() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(SENDER_PK, escrow.hashClaimIntent(id, sender, bytes32("n"), dl));
        vm.expectRevert(IEverpieceEscrow.RecipientMismatch.selector);
        escrow.claimUsernamePayment(id, sender, bytes32("rsalt"), bytes32("n"), dl, s);
    }

    function test_T50_senderCannotClaimForRecipient_withOwnSignature() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(SENDER_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipientSignature.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("n"), dl, s);
    }

    function test_T50_wrongRecipientSalt_rejected() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.expectRevert(IEverpieceEscrow.RecipientMismatch.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("wrong"), bytes32("n"), dl, s);
    }

    function test_invalidRecipient_zeroOrEscrow() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipient.selector);
        escrow.claimUsernamePayment(id, address(0), bytes32("rsalt"), bytes32("n"), block.timestamp, "");
        vm.expectRevert(IEverpieceEscrow.InvalidRecipient.selector);
        escrow.claimUsernamePayment(id, address(escrow), bytes32("rsalt"), bytes32("n"), block.timestamp, "");
        bytes32 idL = _create(_linkIntent(10 * DOLLAR));
        vm.expectRevert(IEverpieceEscrow.InvalidRecipient.selector);
        escrow.claimLinkPayment(idL, address(0), claimKey, bytes32("lsalt"), bytes32(0), block.timestamp, "", bytes32(0), block.timestamp, "");
        vm.expectRevert(IEverpieceEscrow.InvalidRecipient.selector);
        escrow.claimLinkPayment(idL, address(escrow), claimKey, bytes32("lsalt"), bytes32(0), block.timestamp, "", bytes32(0), block.timestamp, "");
    }

    // =================================================================== T51 relayer substitutes recipient

    function test_T51_relayerRedirectsUsernameClaim() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("n"), dl));
        vm.prank(relayer);
        vm.expectRevert(IEverpieceEscrow.RecipientMismatch.selector);
        escrow.claimUsernamePayment(id, relayer, bytes32("rsalt"), bytes32("n"), dl, s);
    }

    function test_T51_relayerRedirectsLinkClaim() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.recipient = relayer; // both signatures were for `recipient`
        vm.expectRevert(IEverpieceEscrow.InvalidClaimKeySignature.selector);
        _claimLink(id, a);
    }

    // =================================================================== T52 / T53 single factor

    function test_T52_linkKeyOnly_noValidApproval() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, STRANGER_PK); // approval forged by stranger
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, a);
        a.approverSig = "";
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, a);
    }

    function test_T52_linkKeyOnly_claimKeySignsItsOwnApproval() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, CLAIMKEY_PK);
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, a);
    }

    function test_T53_approvalOnly_forgedClaimKeySig() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, STRANGER_PK, APPROVER_PK);
        a.claimKey = claimKey; // correct reveal, signature by someone without the link key
        vm.expectRevert(IEverpieceEscrow.InvalidClaimKeySignature.selector);
        _claimLink(id, a);
    }

    function test_T53_approvalOnly_attackerRevealsOwnKey() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, STRANGER_PK, APPROVER_PK); // claimKey = stranger
        vm.expectRevert(IEverpieceEscrow.LinkRevealMismatch.selector);
        _claimLink(id, a);
    }

    function test_T53_approverCannotActAsClaimKey() public {
        // even if a sender committed to the approver's own address as the "claim key"
        IEverpieceEscrow.PaymentIntent memory i =
            _intent(LINK, _linkRc(approver, bytes32("lsalt")), approver, 10 * DOLLAR, block.timestamp + 2 days);
        bytes32 id = _create(i);
        LinkArgs memory a = _linkArgs(id, recipient, APPROVER_PK, APPROVER_PK);
        vm.expectRevert(IEverpieceEscrow.InvalidClaimKey.selector);
        _claimLink(id, a);
    }

    // =================================================================== T54 approval redirect Mama -> Stella

    function test_T54_approvalForMama_redirectedToStella() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        address stella = address(0x57e);
        LinkArgs memory mama = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        LinkArgs memory a = _linkArgs(id, stella, CLAIMKEY_PK, APPROVER_PK);
        a.approvalNonce = mama.approvalNonce;
        a.approvalDeadline = mama.approvalDeadline;
        a.approverSig = mama.approverSig; // approval bound to Mama
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        _claimLink(id, a);
        _claimLink(id, mama); // Mama's own claim still works
        assertEq(ausd.balanceOf(recipient), 10 * DOLLAR);
        assertEq(ausd.balanceOf(stella), 0);
    }

    // =================================================================== T55 link reveal

    function test_T55_wrongLinkSalt() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.recipientSalt = bytes32("wrong");
        vm.expectRevert(IEverpieceEscrow.LinkRevealMismatch.selector);
        _claimLink(id, a);
    }

    function test_T55_zeroClaimKey() public {
        bytes32 id = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK);
        a.claimKey = address(0);
        vm.expectRevert(IEverpieceEscrow.InvalidClaimKey.selector);
        _claimLink(id, a);
    }

    // =================================================================== T56 cancel only by sender

    function test_T56_cancelByNonSender_rejected() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        uint256[3] memory pks = [RECIPIENT_PK, APPROVER_PK, STRANGER_PK];
        for (uint256 k; k < pks.length; ++k) {
            bytes memory s = _cancelSig(id, pks[k], bytes32("n"), dl);
            vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
            escrow.cancel(id, bytes32("n"), dl, s);
        }
        vm.prank(sender); // even the sender's own msg.sender without a signature is not enough
        vm.expectRevert(IEverpieceEscrow.InvalidSenderSignature.selector);
        escrow.cancel(id, bytes32("n"), dl, "");
    }

    function test_T56_cancelRefundGoesToSender_notCaller() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _cancelSig(id, SENDER_PK, bytes32("n"), dl);
        vm.prank(stranger);
        escrow.cancel(id, bytes32("n"), dl, s);
        assertEq(ausd.balanceOf(stranger), 0);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    // =================================================================== T58 wrong mode

    function test_T58_wrongModeClaims() public {
        bytes32 idU = _create(_usernameIntent(10 * DOLLAR));
        bytes32 idL = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a = _linkArgs(idU, recipient, CLAIMKEY_PK, APPROVER_PK);
        vm.expectRevert(IEverpieceEscrow.WrongMode.selector);
        _claimLink(idU, a);
        vm.expectRevert(IEverpieceEscrow.WrongMode.selector);
        escrow.claimUsernamePayment(idL, recipient, bytes32("lsalt"), bytes32("n"), block.timestamp, "");
    }
}
