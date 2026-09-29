// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../src/interfaces/IEverpieceEscrow.sol";
import {EverpieceEscrow} from "../src/EverpieceEscrow.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";
import {MockAUSD} from "./utils/MockAUSD.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Claim/cancel/refund races (T57, master §9), liability & solvency (T20–T25), issuer controls (T80–T83),
///         reentrancy.
contract RaceAndAccountingTest is EscrowBase {
    // =================================================================== T57 races

    function test_T57_claimThenCancel() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(id, SENDER_PK, bytes32("c"), dl); // both signed "at the same time"
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.cancel(id, bytes32("c"), dl, cs);
        assertEq(ausd.balanceOf(recipient), 10 * DOLLAR);
    }

    function test_T57_cancelThenClaim() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(id, SENDER_PK, bytes32("c"), dl);
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        escrow.cancel(id, bytes32("c"), dl, cs);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        assertEq(ausd.balanceOf(recipient), 0);
    }

    function test_T57_linkClaimThenCancel_andReverse() public {
        bytes32 id1 = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a1 = _linkArgs(id1, recipient, CLAIMKEY_PK, APPROVER_PK);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs1 = _cancelSig(id1, SENDER_PK, bytes32("c1"), dl);
        _claimLink(id1, a1);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.cancel(id1, bytes32("c1"), dl, cs1);

        bytes32 id2 = _create(_linkIntent(10 * DOLLAR));
        LinkArgs memory a2 = _linkArgs(id2, recipient, CLAIMKEY_PK, APPROVER_PK);
        escrow.cancel(id2, bytes32("c2"), dl, _cancelSig(id2, SENDER_PK, bytes32("c2"), dl));
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        _claimLink(id2, a2);
    }

    function test_claimVsRefund_atBoundary() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 id = _create(i);
        uint256 dl = i.expiresAt + 1 hours;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        vm.warp(i.expiresAt);
        vm.expectRevert(IEverpieceEscrow.PaymentExpired.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        escrow.refundExpired(id);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_claimThenRefund_refundFails() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 id = _create(i);
        vm.warp(i.expiresAt - 1);
        _claimUsername(id, recipient, bytes32("rsalt"), RECIPIENT_PK);
        vm.warp(i.expiresAt);
        vm.expectRevert(IEverpieceEscrow.PaymentNotActive.selector);
        escrow.refundExpired(id);
    }

    // =================================================================== T20 liability tracking

    function test_T20_liabilityOverMixedSequence() public {
        ausd.mint(sender, 10_000 * DOLLAR);
        bytes32[6] memory ids;
        uint256[6] memory amts = [uint256(1), 7 * DOLLAR, 100 * DOLLAR, 250 * DOLLAR, 499 * DOLLAR, 500 * DOLLAR];
        uint256 sum;
        for (uint256 k; k < 6; ++k) {
            ids[k] = _create(k % 2 == 0 ? _usernameIntent(amts[k]) : _linkIntent(amts[k]));
            sum += amts[k];
            assertEq(escrow.totalActiveLiability(), sum);
        }
        _claimUsername(ids[0], recipient, bytes32("rsalt"), RECIPIENT_PK);
        sum -= amts[0];
        assertEq(escrow.totalActiveLiability(), sum);
        _claimLink(ids[1], _linkArgs(ids[1], recipient, CLAIMKEY_PK, APPROVER_PK));
        sum -= amts[1];
        assertEq(escrow.totalActiveLiability(), sum);
        _cancel(ids[2]);
        sum -= amts[2];
        assertEq(escrow.totalActiveLiability(), sum);
        _cancel(ids[3]);
        sum -= amts[3];
        vm.warp(block.timestamp + 30 days);
        escrow.refundExpired(ids[4]);
        sum -= amts[4];
        escrow.refundExpired(ids[5]);
        sum -= amts[5];
        assertEq(sum, 0);
        assertEq(escrow.totalActiveLiability(), 0);
        assertEq(ausd.balanceOf(address(escrow)), 0);
        assertEq(ausd.balanceOf(sender) + ausd.balanceOf(recipient), 20_000 * DOLLAR); // conservation
    }

    // =================================================================== T23 unsolicited AUSD

    function test_T23_unsolicitedAusd_doesNotBreakAccounting_andIsStranded() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.mint(address(escrow), 3 * DOLLAR); // donation / mistaken transfer
        assertGt(ausd.balanceOf(address(escrow)), escrow.totalActiveLiability());
        _claimUsername(id, recipient, bytes32("rsalt"), RECIPIENT_PK);
        bytes32 id2 = _create(_usernameIntent(5 * DOLLAR));
        _cancel(id2);
        assertEq(escrow.totalActiveLiability(), 0);
        assertEq(ausd.balanceOf(address(escrow)), 3 * DOLLAR); // stranded by design (master §7.3)
    }

    // =================================================================== T24 token failure -> whole action reverts

    function test_T24_payoutRevert_claimStateUnchanged() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.setTransferReverts(true);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        vm.expectRevert(MockAUSD.ForcedRevert.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
        assertFalse(escrow.usedNonces(recipient, bytes32("r")));
        ausd.setTransferReverts(false);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs); // retry works
    }

    function test_T24_payoutReturnsFalse_reverts() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.setTransferReturnsFalse(true);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(id, SENDER_PK, bytes32("c"), dl);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, AUSD_ADDR));
        escrow.cancel(id, bytes32("c"), dl, cs);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
    }

    function test_T24_refundTransferFails_stateUnchanged() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 id = _create(i);
        vm.warp(i.expiresAt);
        ausd.setTransferPaused(true);
        vm.expectRevert(MockAUSD.TransferPaused.selector);
        escrow.refundExpired(id);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE)); // never "REFUNDED" without funds moving
        ausd.setTransferPaused(false);
        escrow.refundExpired(id);
    }

    // =================================================================== T25 short delivery

    function test_T25_fundingShortfall_reverts() public {
        ausd.setFundingShortfall(1);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(IEverpieceEscrow.FundingMismatch.selector);
        escrow.createPayment(i, s);
        assertEq(escrow.totalActiveLiability(), 0);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_T25_payoutShortfall_reverts() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.setPayoutShortfall(1);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        vm.expectRevert(IEverpieceEscrow.PayoutMismatch.selector);
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
    }

    // =================================================================== T80–T83 issuer controls (mocked)

    function test_T80_escrowFrozen_allOutflowsRevert_thenRecover() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        bytes32 id = _create(i);
        ausd.setFrozen(address(escrow), true);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        bytes memory cs = _cancelSig(id, SENDER_PK, bytes32("c"), dl);
        vm.expectRevert(abi.encodeWithSelector(MockAUSD.AccountIsFrozen.selector, address(escrow)));
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        vm.expectRevert(abi.encodeWithSelector(MockAUSD.AccountIsFrozen.selector, address(escrow)));
        escrow.cancel(id, bytes32("c"), dl, cs);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
        ausd.setFrozen(address(escrow), false);
        escrow.cancel(id, bytes32("c"), dl, cs);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_T81_recipientFrozen_claimReverts_senderCanCancel() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.setFrozen(recipient, true);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory rs = _sig(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, bytes32("r"), dl));
        vm.expectRevert(abi.encodeWithSelector(MockAUSD.AccountIsFrozen.selector, recipient));
        escrow.claimUsernamePayment(id, recipient, bytes32("rsalt"), bytes32("r"), dl, rs);
        _cancel(id);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_T82_issuerBurnFromEscrow_breaksSolvency_payoutsRevertNotPartial() public {
        bytes32 idA = _create(_usernameIntent(10 * DOLLAR));
        bytes32 idB = _create(_usernameIntent(10 * DOLLAR));
        ausd.burn(address(escrow), 5 * DOLLAR); // BURNER_ROLE power (VERIFIED §2.11): 15 left for 20 owed
        assertLt(ausd.balanceOf(address(escrow)), escrow.totalActiveLiability()); // documented: I21 broken by issuer
        _cancel(idA); // first 10 still covered
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(idB, SENDER_PK, bytes32("cB"), dl);
        vm.expectRevert(); // insufficient balance: no partial payout, no false CANCELLED
        escrow.cancel(idB, bytes32("cB"), dl, cs);
        assertEq(uint8(_status(idB)), uint8(IEverpieceEscrow.Status.ACTIVE));
        assertEq(escrow.totalActiveLiability(), 10 * DOLLAR);
    }

    function test_T83_signaturePause_blocksCreate_payoutsContinue() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.setSignatureVerificationPaused(true);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(MockAUSD.SignatureVerificationPaused.selector);
        escrow.createPayment(i, s);
        _claimUsername(id, recipient, bytes32("rsalt"), RECIPIENT_PK);
    }

    function test_T83_transferPause_blocksEverything() public {
        bytes32 id = _create(_usernameIntent(10 * DOLLAR));
        ausd.setTransferPaused(true);
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(DOLLAR);
        bytes memory s = _fundingSig(SENDER_PK, i);
        vm.expectRevert(MockAUSD.TransferPaused.selector);
        escrow.createPayment(i, s);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory cs = _cancelSig(id, SENDER_PK, bytes32("c"), dl);
        vm.expectRevert(MockAUSD.TransferPaused.selector);
        escrow.cancel(id, bytes32("c"), dl, cs);
    }

    // =================================================================== reentrancy

    function test_reentrancy_tokenCallbackCannotReenter() public {
        ReentrantToken bad = new ReentrantToken();
        EverpieceEscrow e = new EverpieceEscrow(IAUSD(address(bad)), owner, approver);
        bad.setTarget(e);
        // Create through the reentrant token: its receive hook tries to re-enter refundExpired
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(10 * DOLLAR);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        e.createPayment(i, "");
    }
}

/// @dev Token whose receiveWithAuthorization re-enters the escrow.
contract ReentrantToken {
    EverpieceEscrow internal target;
    mapping(address => uint256) public balanceOf;

    function setTarget(EverpieceEscrow t) external {
        target = t;
    }

    function isReceiveWithAuthorizationUpgraded() external pure returns (bool) {
        return false;
    }

    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32 nonce, bytes memory) external {
        target.refundExpired(nonce);
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}
