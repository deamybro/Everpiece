// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/console.sol";
import {EscrowBase} from "../utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

/// @notice Stateful invariants — master §20 / ESCROW_SPEC §16.
contract EscrowInvariantTest is EscrowBase {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, ausd, owner);
        targetContract(address(handler));
    }

    /// I22: totalActiveLiability == Σ amount(ACTIVE)
    function invariant_liabilityEqualsSumOfActive() public view {
        uint256 sum;
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            IEverpieceEscrow.Payment memory p = escrow.getPayment(handler.ids(k));
            if (p.status == IEverpieceEscrow.Status.ACTIVE) sum += p.amount;
        }
        assertEq(escrow.totalActiveLiability(), sum);
    }

    /// I21: balance >= liability (no issuer burn in this model) and exact accounting of the surplus.
    function invariant_solvency() public view {
        assertGe(ausd.balanceOf(address(escrow)), escrow.totalActiveLiability());
        assertEq(ausd.balanceOf(address(escrow)), escrow.totalActiveLiability() + handler.ghostDonated());
    }

    /// Conservation: funded = active + claimed + returned; nothing is created or lost.
    function invariant_conservation() public view {
        assertEq(handler.ghostFunded(), escrow.totalActiveLiability() + handler.ghostClaimed() + handler.ghostReturned());
        uint256 recipients;
        for (uint256 k; k < 3; ++k) {
            recipients += ausd.balanceOf(vm.addr(handler.recipientPks(k)));
        }
        assertEq(recipients, handler.ghostClaimed()); // recipients receive ONLY via claims
        uint256 senders;
        for (uint256 k; k < 3; ++k) {
            senders += ausd.balanceOf(vm.addr(handler.senderPks(k)));
        }
        assertEq(senders, 300_000e6 - handler.ghostFunded() + handler.ghostReturned());
    }

    /// I1–I7: terminal states are final and match what the handler observed.
    function invariant_terminalStatesAreFinal() public view {
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            bytes32 id = handler.ids(k);
            IEverpieceEscrow.Status g = handler.ghostTerminal(id);
            IEverpieceEscrow.Status s = escrow.getPayment(id).status;
            if (g == IEverpieceEscrow.Status.NONE) assertEq(uint8(s), uint8(IEverpieceEscrow.Status.ACTIVE));
            else assertEq(uint8(s), uint8(g));
        }
    }

    /// I32: approver snapshot and all stored terms never change after create.
    function invariant_storedTermsImmutable() public view {
        uint256 n = handler.idsLength();
        for (uint256 k; k < n; ++k) {
            bytes32 id = handler.ids(k);
            IEverpieceEscrow.Payment memory p = escrow.getPayment(id);
            assertEq(p.approver, handler.ghostApprover(id));
            assertEq(p.sender, handler.ghostSender(id));
            assertEq(p.amount, handler.ghostAmount(id));
            assertEq(uint8(p.mode), handler.ghostMode(id));
        }
    }

    /// I33: caps never exceed V1 ceilings.
    function invariant_capsWithinCeilings() public view {
        assertLe(escrow.maxPaymentAmount(), 500e6);
        assertLe(escrow.maxActiveLiability(), 5_000e6);
        assertLe(escrow.totalActiveLiability(), 5_000e6);
    }

    /// I8, I9, I13, I29, I30: an attacker without the right keys never claims.
    function invariant_attackerNeverClaims() public view {
        assertEq(handler.attackerSuccesses(), 0);
        assertEq(ausd.balanceOf(vm.addr(0xA77AC)), 0);
    }

    /// I24: pause (or anything else in this model) never blocks cancel or refund.
    function invariant_cancelAndRefundNeverBlocked() public view {
        assertEq(handler.cancelBlocked(), 0);
        assertEq(handler.refundBlocked(), 0);
    }

    /// Coverage evidence (run with -vv): which handler paths actually executed.
    function afterInvariant() external view {
        console.log("create", handler.calls("create"), "claimUsername", handler.calls("claimUsername"));
        console.log("claimLink", handler.calls("claimLink"), "cancel", handler.calls("cancel"));
        console.log("refund", handler.calls("refund"), "attack", handler.calls("attack"));
        console.log("payments", handler.idsLength(), "claimed", handler.ghostClaimed());
    }
}
