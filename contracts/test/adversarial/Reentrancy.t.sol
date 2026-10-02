// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev A hostile "AUSD": honest balances, but whenever it moves money it calls back into the escrow with whatever
///      the attacker loaded, and records how the escrow answered. Real AUSD has no hooks; this models an issuer
///      upgrade (or any token) that hands control to an attacker mid-payout (master §44.2 "reentrancy").
contract HostileAUSD is IAUSD {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public target;
    bytes public reentry;
    bool public reentered;
    bytes public reentryRevert;

    function arm(address escrow, bytes calldata data) external {
        target = escrow;
        reentry = data;
        reentered = false;
    }

    function _attack() internal {
        if (target == address(0) || reentered) return;
        reentered = true;
        (bool ok, bytes memory ret) = target.call(reentry);
        reentryRevert = ok ? bytes("") : ret; // swallow: the outer call goes on, so the test sees what reentry did
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        totalSupply += v;
    }

    function receiveWithAuthorization(address from, address to, uint256 value, uint256, uint256, bytes32, bytes memory) external {
        _attack();
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _attack();
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function isReceiveWithAuthorizationUpgraded() external pure returns (bool) {
        return false;
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function approve(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract ReentrancyTest is Test {
    HostileAUSD internal tok;
    EverpieceEscrow internal escrow;
    uint256 internal constant SENDER_PK = 1;
    uint256 internal constant RECIPIENT_PK = 2;
    address internal sender;
    address internal recipient;
    address internal approver = address(0xA99);

    function setUp() public {
        vm.chainId(143);
        vm.warp(1790700000);
        sender = vm.addr(SENDER_PK);
        recipient = vm.addr(RECIPIENT_PK);
        tok = new HostileAUSD();
        escrow = new EverpieceEscrow(IAUSD(address(tok)), address(this), approver);
        tok.mint(sender, 1_000e6);
    }

    function _intent(bytes32 salt, uint256 amount) internal view returns (IEverpieceEscrow.PaymentIntent memory) {
        return IEverpieceEscrow.PaymentIntent({
            sender: sender,
            mode: 1,
            recipientCommitment: escrow.recipientCommitmentOf(1, recipient, bytes32("r")),
            metadataCommitment: bytes32(0),
            approver: address(0),
            amount: amount,
            expiresAt: block.timestamp + 30 days,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            salt: salt
        });
    }

    function _create(bytes32 salt, uint256 amount) internal returns (bytes32) {
        return escrow.createPayment(_intent(salt, amount), ""); // the hostile token doesn't check the signature
    }

    function _claimArgs(bytes32 id, bytes32 nonce) internal view returns (bytes memory) {
        uint256 dl = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, nonce, dl));
        return abi.encodeCall(escrow.claimUsernamePayment, (id, recipient, bytes32("r"), nonce, dl, abi.encodePacked(r, s, v)));
    }

    function _cancelArgs(bytes32 id, bytes32 nonce) internal view returns (bytes memory) {
        uint256 dl = block.timestamp + 10 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SENDER_PK, escrow.hashCancelIntent(id, sender, nonce, dl));
        return abi.encodeCall(escrow.cancel, (id, nonce, dl, abi.encodePacked(r, s, v)));
    }

    function _assertBlocked() internal view {
        assertTrue(tok.reentered(), "the attack ran");
        assertEq(bytes4(tok.reentryRevert()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "reentry must be refused");
    }

    /// Mid-claim payout, the attacker tries to cancel the same payment back to the sender: a double spend.
    function test_A30_reenterCancelDuringClaimPayout() public {
        bytes32 id = _create("a", 100e6);
        tok.arm(address(escrow), _cancelArgs(id, "c"));
        (bool ok,) = address(escrow).call(_claimArgs(id, "n"));
        assertTrue(ok);
        _assertBlocked();
        assertEq(tok.balanceOf(recipient), 100e6);
        assertEq(tok.balanceOf(sender), 900e6);
        assertEq(uint8(escrow.getPayment(id).status), uint8(IEverpieceEscrow.Status.CLAIMED));
        assertEq(escrow.totalActiveLiability(), 0);
    }

    /// Mid-refund payout, the attacker refunds again (cross-call and same-call reentry).
    function test_A30_reenterRefundDuringRefund_and_otherPayment() public {
        bytes32 a = _create("a", 100e6);
        bytes32 b = _create("b", 50e6);
        vm.warp(block.timestamp + 31 days);
        tok.arm(address(escrow), abi.encodeCall(escrow.refundExpired, (a)));
        escrow.refundExpired(a);
        _assertBlocked();
        tok.arm(address(escrow), abi.encodeCall(escrow.refundExpired, (a))); // a again, during b's payout
        escrow.refundExpired(b);
        _assertBlocked();
        assertEq(tok.balanceOf(sender), 1_000e6); // exactly once each
        assertEq(tok.balanceOf(address(escrow)), 0);
    }

    /// While funding pulls the sender's money in, the attacker tries to claim the half-created payment.
    function test_A30_reenterClaimDuringCreateFunding() public {
        IEverpieceEscrow.PaymentIntent memory i = _intent("c", 100e6);
        bytes32 id = escrow.paymentIdOf(i);
        tok.arm(address(escrow), _claimArgs(id, "n"));
        escrow.createPayment(i, "");
        _assertBlocked();
        assertEq(uint8(escrow.getPayment(id).status), uint8(IEverpieceEscrow.Status.ACTIVE));
        assertEq(tok.balanceOf(recipient), 0);
        assertEq(tok.balanceOf(address(escrow)), 100e6);
    }
}
