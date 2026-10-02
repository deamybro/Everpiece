// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EscrowBase} from "../utils/EscrowBase.t.sol";
import {MockAUSD} from "../utils/MockAUSD.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {TestDollar} from "../../src/testnet/TestDollar.sol";

/// @dev TestDollar on its own: the AUSD surface the escrow relies on, plus the faucet rules.
contract TestDollarTokenTest is Test {
    TestDollar internal t;
    address internal minter = makeAddr("minter");
    uint256 internal constant ALICE_PK = 0xA11CE;
    address internal alice;
    address internal bob = makeAddr("bob");

    bytes32 internal constant RWA = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_790_700_000);
        alice = vm.addr(ALICE_PK);
        t = new TestDollar(minter);
        vm.prank(minter);
        t.mint(alice, 100e6);
    }

    function _rwaSig(address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), keccak256(abi.encode(RWA, alice, to, value, va, vb, nonce))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, d);
        return abi.encodePacked(r, s, v);
    }

    function test_metadataAndDomain() public view {
        assertEq(t.name(), "Everpiece Test Dollar");
        assertEq(t.symbol(), "tUSD");
        assertEq(t.decimals(), 6);
        assertFalse(t.isReceiveWithAuthorizationUpgraded());
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Everpiece Test Dollar"), keccak256("1"), uint256(10143), address(t)
            )
        );
        assertEq(t.DOMAIN_SEPARATOR(), expected);
    }

    function test_mint_onlyMinter_capped() public {
        vm.expectRevert(TestDollar.NotMinter.selector);
        t.mint(bob, 1);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(TestDollar.MintTooLarge.selector, 100e6 + 1));
        t.mint(bob, 100e6 + 1);
        vm.prank(minter);
        t.mint(bob, 100e6);
        assertEq(t.balanceOf(bob), 100e6);
        assertEq(t.totalSupply(), 200e6);
    }

    function test_receive_payeeCheck_window_nonce_signature() public {
        bytes32 n = keccak256("n1");
        uint256 va = block.timestamp - 1;
        uint256 vb = block.timestamp + 100;
        bytes memory sig = _rwaSig(bob, 5e6, va, vb, n);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.InvalidPayee.selector, address(this), bob));
        t.receiveWithAuthorization(alice, bob, 5e6, va, vb, n, sig); // caller is not the payee

        vm.prank(bob);
        t.receiveWithAuthorization(alice, bob, 5e6, va, vb, n, sig);
        assertEq(t.balanceOf(bob), 5e6);
        assertTrue(t.authorizationState(alice, n));

        vm.prank(bob);
        vm.expectRevert(TestDollar.UsedOrCanceledAuthorization.selector);
        t.receiveWithAuthorization(alice, bob, 5e6, va, vb, n, sig); // nonce single-use

        bytes32 n2 = keccak256("n2");
        bytes memory early = _rwaSig(bob, 1, block.timestamp, vb, n2);
        vm.prank(bob);
        vm.expectRevert(TestDollar.InvalidAuthorization.selector);
        t.receiveWithAuthorization(alice, bob, 1, block.timestamp, vb, n2, early); // now must be > validAfter

        bytes memory late = _rwaSig(bob, 1, va, block.timestamp, n2);
        vm.prank(bob);
        vm.expectRevert(TestDollar.ExpiredAuthorization.selector);
        t.receiveWithAuthorization(alice, bob, 1, va, block.timestamp, n2, late); // now must be < validBefore

        bytes memory wrongValue = _rwaSig(bob, 2, va, vb, n2);
        vm.prank(bob);
        vm.expectRevert(TestDollar.InvalidSignature.selector);
        t.receiveWithAuthorization(alice, bob, 1, va, vb, n2, wrongValue);
    }

    function test_cancelAuthorization_blocksLaterUse() public {
        bytes32 n = keccak256("c");
        bytes32 d = keccak256(
            abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), keccak256(abi.encode(t.CANCEL_AUTHORIZATION_TYPEHASH(), alice, n)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, d);
        t.cancelAuthorization(alice, n, abi.encodePacked(r, s, v));
        bytes memory sig = _rwaSig(bob, 1, block.timestamp - 1, block.timestamp + 100, n);
        vm.prank(bob);
        vm.expectRevert(TestDollar.UsedOrCanceledAuthorization.selector);
        t.receiveWithAuthorization(alice, bob, 1, block.timestamp - 1, block.timestamp + 100, n, sig);
    }

    function test_transferFrom_allowance() public {
        vm.prank(alice);
        t.approve(bob, 3e6);
        vm.prank(bob);
        t.transferFrom(alice, bob, 3e6);
        assertEq(t.allowance(alice, bob), 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TestDollar.ERC20InsufficientAllowance.selector, bob, 0, 1));
        t.transferFrom(alice, bob, 1);
    }
}

/// @dev The UNCHANGED EverpieceEscrow running full lifecycles on TestDollar (the testnet deployment pairing).
///      Reuses the escrow fixture with TestDollar in place of MockAUSD at the same address.
contract EscrowOnTestDollarTest is EscrowBase {
    function setUp() public override {
        vm.chainId(143);
        vm.warp(T0);
        sender = vm.addr(SENDER_PK);
        recipient = vm.addr(RECIPIENT_PK);
        approver = vm.addr(APPROVER_PK);
        claimKey = vm.addr(CLAIMKEY_PK);
        approver2 = vm.addr(APPROVER2_PK);
        stranger = vm.addr(STRANGER_PK);

        deployCodeTo("TestDollar.sol:TestDollar", abi.encode(address(this)), AUSD_ADDR);
        ausd = MockAUSD(AUSD_ADDR); // same function selectors the fixture uses (DOMAIN_SEPARATOR, balanceOf)
        deployCodeTo("EverpieceEscrow.sol:EverpieceEscrow", abi.encode(AUSD_ADDR, owner, approver), ESCROW_ADDR);
        escrow = EverpieceEscrow(ESCROW_ADDR);
        for (uint256 k = 0; k < 5; k++) TestDollar(AUSD_ADDR).mint(sender, 100 * DOLLAR);
    }

    function test_username_create_claim() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(25 * DOLLAR);
        bytes32 id = _create(i);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.ACTIVE));
        assertEq(TestDollar(AUSD_ADDR).balanceOf(ESCROW_ADDR), 25 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 25 * DOLLAR);
        _claimUsername(id, recipient, bytes32("rsalt"), RECIPIENT_PK);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CLAIMED));
        assertEq(TestDollar(AUSD_ADDR).balanceOf(recipient), 25 * DOLLAR);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_link_create_claim_twoFactors() public {
        IEverpieceEscrow.PaymentIntent memory i = _linkIntent(10 * DOLLAR);
        bytes32 id = _create(i);
        _claimLink(id, _linkArgs(id, recipient, CLAIMKEY_PK, APPROVER_PK));
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CLAIMED));
        assertEq(TestDollar(AUSD_ADDR).balanceOf(recipient), 10 * DOLLAR);
    }

    function test_cancel_refunds_exactly() public {
        uint256 before = TestDollar(AUSD_ADDR).balanceOf(sender);
        bytes32 id = _create(_usernameIntent(7 * DOLLAR));
        _cancel(id);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.CANCELLED));
        assertEq(TestDollar(AUSD_ADDR).balanceOf(sender), before);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_expired_refund_permissionless() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(3 * DOLLAR);
        uint256 before = TestDollar(AUSD_ADDR).balanceOf(sender);
        bytes32 id = _create(i);
        vm.warp(i.expiresAt);
        vm.prank(stranger);
        escrow.refundExpired(id);
        assertEq(uint8(_status(id)), uint8(IEverpieceEscrow.Status.REFUNDED));
        assertEq(TestDollar(AUSD_ADDR).balanceOf(sender), before);
    }
}
