// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {EverpiecePay} from "../src/EverpiecePay.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";
import {MockAgoraPair, MockPermitToken} from "./utils/MockAgoraPair.sol";

/// @notice EverpiecePay: instant AUSD payments, direct or through an Agora fixed-output swap. MockAUSD sits at the
///         real AUSD address (EscrowBase); the pair mirrors the documented Agora semantics. The same flows run against
///         the REAL Monad testnet AUSD + CTK/AUSD pair in test/fork/EverpiecePayFork.t.sol.
contract EverpiecePayTest is EscrowBase {
    EverpiecePay internal pay;
    MockPermitToken internal ctk;
    MockAgoraPair internal pair;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public override {
        super.setUp();
        ctk = new MockPermitToken();
        pair = new MockAgoraPair(address(ctk), AUSD_ADDR);
        address[] memory pairs = new address[](1);
        pairs[0] = address(pair);
        pay = new EverpiecePay(IAUSD(AUSD_ADDR), pairs);
        pair.setApprovedSwapper(address(pay), true);
        ausd.mint(address(pair), 1_000_000 * DOLLAR); // pair liquidity
        ctk.mint(sender, 1_000 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _p(address sourceToken, uint256 amount, uint256 maxSource) internal view returns (EverpiecePay.Payment memory) {
        return EverpiecePay.Payment({
            ref: keccak256("request-1"),
            sender: sender,
            recipient: recipient,
            amount: amount,
            sourceToken: sourceToken,
            maxSourceAmount: maxSource,
            deadline: block.timestamp + 10 minutes
        });
    }

    function _ausdSig(EverpiecePay.Payment memory p) internal view returns (bytes memory) {
        bytes32 id = pay.paymentIdOf(p);
        return _sig(SENDER_PK, _ausdDigest(RWA_TYPEHASH, p.sender, address(pay), p.amount, 0, p.deadline, id));
    }

    function _permit(uint256 pk, address owner_, uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner_, address(pay), value, ctk.nonces(owner_), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", ctk.DOMAIN_SEPARATOR(), structHash)));
    }

    function _payToken(EverpiecePay.Payment memory p) internal returns (bytes32) {
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, p.sender, p.maxSourceAmount, p.deadline);
        vm.prank(relayer);
        return pay.payWithToken(p, payerSig, p.deadline, v, r, s);
    }

    // ============================================================================ direct AUSD
    function test_payWithAusd_exactAmount_final() public {
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 25 * DOLLAR, 25 * DOLLAR);
        bytes memory s = _ausdSig(p);
        vm.prank(relayer);
        bytes32 id = pay.payWithAusd(p, s);
        assertEq(ausd.balanceOf(recipient), 25 * DOLLAR);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR - 25 * DOLLAR);
        assertEq(ausd.balanceOf(address(pay)), 0);
        assertTrue(pay.settled(id));
        vm.expectRevert(EverpiecePay.AlreadySettled.selector);
        pay.payWithAusd(p, s);
    }

    function test_payWithAusd_relayerCannotChangeTerms() public {
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 25 * DOLLAR, 25 * DOLLAR);
        bytes memory s = _ausdSig(p);
        EverpiecePay.Payment memory q = _p(AUSD_ADDR, 25 * DOLLAR, 25 * DOLLAR);
        q.recipient = stranger;
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        pay.payWithAusd(q, s);
        q = _p(AUSD_ADDR, 26 * DOLLAR, 26 * DOLLAR);
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        pay.payWithAusd(q, s);
        q = _p(AUSD_ADDR, 25 * DOLLAR, 25 * DOLLAR);
        q.deadline = p.deadline + 1;
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        pay.payWithAusd(q, s);
        pay.payWithAusd(p, s);
    }

    function test_payWithAusd_guards() public {
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 25 * DOLLAR, 25 * DOLLAR);
        p.recipient = address(pay);
        vm.expectRevert(EverpiecePay.InvalidRecipient.selector);
        pay.payWithAusd(p, "");
        p = _p(AUSD_ADDR, 0, 1);
        vm.expectRevert(EverpiecePay.ZeroAmount.selector);
        pay.payWithAusd(p, "");
        p = _p(address(ctk), 25 * DOLLAR, 25 ether);
        vm.expectRevert(EverpiecePay.WrongSourceToken.selector);
        pay.payWithAusd(p, "");
        p = _p(AUSD_ADDR, 25 * DOLLAR, 25 * DOLLAR);
        bytes memory s = _ausdSig(p);
        vm.warp(p.deadline);
        vm.expectRevert(EverpiecePay.Expired.selector);
        pay.payWithAusd(p, s);
        vm.warp(T0);
        ausd.setReceiveWithAuthorizationUpgraded(true);
        vm.expectRevert(EverpiecePay.AusdSemanticsChanged.selector);
        pay.payWithAusd(p, s);
    }

    // ============================================================================ token → exact AUSD via Agora
    function test_payWithToken_recipientGetsExactAusd_payerRefundedTheRest() public {
        uint256 quoted = pay.quote(address(ctk), 25 * DOLLAR);
        assertEq(quoted, 25 ether); // 1:1, no fee
        EverpiecePay.Payment memory p = _p(address(ctk), 25 * DOLLAR, quoted + 1 ether); // the client adds headroom
        bytes32 id = _payToken(p);
        assertEq(ausd.balanceOf(recipient), 25 * DOLLAR, "exactly the requested AUSD");
        assertEq(ctk.balanceOf(sender), 1_000 ether - 25 ether, "only what the swap used");
        assertEq(ctk.balanceOf(address(pay)), 0, "keeps nothing");
        assertEq(ctk.allowance(address(pay), address(pair)), 0, "no lingering approval");
        assertTrue(pay.settled(id));
    }

    function test_payWithToken_withFee_quoteIsWhatIsCharged() public {
        pair.setFeeBps(30);
        uint256 quoted = pay.quote(address(ctk), 10 * DOLLAR);
        _payToken(_p(address(ctk), 10 * DOLLAR, quoted));
        assertEq(ausd.balanceOf(recipient), 10 * DOLLAR);
        assertEq(ctk.balanceOf(sender), 1_000 ether - quoted);
    }

    function test_payWithToken_maxTooLow_nothingMoves() public {
        EverpiecePay.Payment memory p = _p(address(ctk), 25 * DOLLAR, 24 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, p.maxSourceAmount, p.deadline);
        vm.expectRevert(MockAgoraPair.ExcessiveInputAmount.selector);
        pay.payWithToken(p, payerSig, p.deadline, v, r, s);
        assertEq(ctk.balanceOf(sender), 1_000 ether);
        assertEq(ausd.balanceOf(recipient), 0);
        assertFalse(pay.settled(pay.paymentIdOf(p))); // reverted as a whole
    }

    function test_payWithToken_relayerCannotRedirect_or_replay() public {
        EverpiecePay.Payment memory p = _p(address(ctk), 25 * DOLLAR, 25 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, p.maxSourceAmount, p.deadline);
        EverpiecePay.Payment memory q = _p(address(ctk), 25 * DOLLAR, 25 ether);
        q.recipient = stranger; // same permit + payer signature, new payee
        vm.expectRevert(EverpiecePay.InvalidPayerSignature.selector);
        pay.payWithToken(q, payerSig, p.deadline, v, r, s);
        // a signature by anyone else
        bytes memory strangerSig = _sig(STRANGER_PK, pay.paymentIdOf(p));
        vm.expectRevert(EverpiecePay.InvalidPayerSignature.selector);
        pay.payWithToken(p, strangerSig, p.deadline, v, r, s);
        pay.payWithToken(p, payerSig, p.deadline, v, r, s);
        vm.expectRevert(EverpiecePay.AlreadySettled.selector);
        pay.payWithToken(p, payerSig, p.deadline, v, r, s);
        assertEq(ausd.balanceOf(recipient), 25 * DOLLAR);
        assertEq(ausd.balanceOf(stranger), 0);
    }

    function test_payWithToken_frontRunPermit_stillSettles() public {
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 5 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, p.maxSourceAmount, p.deadline);
        ctk.permit(sender, address(pay), p.maxSourceAmount, p.deadline, v, r, s); // a griefer submits it first
        pay.payWithToken(p, payerSig, p.deadline, v, r, s);
        assertEq(ausd.balanceOf(recipient), 5 * DOLLAR);
    }

    function test_payWithToken_noPermitNoAllowance_reverts() public {
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 5 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        vm.expectRevert(); // ERC20InsufficientAllowance
        pay.payWithToken(p, payerSig, p.deadline, 27, bytes32(0), bytes32(0));
    }

    function test_payWithToken_unsupportedToken_and_notWhitelisted() public {
        MockPermitToken other = new MockPermitToken();
        EverpiecePay.Payment memory p = _p(address(other), 5 * DOLLAR, 5 ether);
        vm.expectRevert(EverpiecePay.UnsupportedToken.selector);
        pay.payWithToken(p, "", 0, 0, 0, 0);
        vm.expectRevert(EverpiecePay.UnsupportedToken.selector);
        pay.quote(address(other), 1);

        pair.setApprovedSwapper(address(pay), false); // Agora revoked the role
        p = _p(address(ctk), 5 * DOLLAR, 5 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, p.maxSourceAmount, p.deadline);
        vm.expectRevert(MockAgoraPair.NotApprovedSwapper.selector);
        pay.payWithToken(p, payerSig, p.deadline, v, r, s);
        assertEq(ctk.balanceOf(sender), 1_000 ether);
    }

    function test_payWithToken_shortDelivery_reverts() public {
        pair.setShortDeliver(true);
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 5 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, p.maxSourceAmount, p.deadline);
        vm.expectRevert(EverpiecePay.SettlementMismatch.selector);
        pay.payWithToken(p, payerSig, p.deadline, v, r, s);
        assertEq(ctk.balanceOf(sender), 1_000 ether);
    }

    function test_payWithToken_convertToSelf_forProtectedSend() public {
        // Protected Send with a token: convert to the sender's own AUSD first, then fund the escrow with it.
        EverpiecePay.Payment memory p = _p(address(ctk), 7 * DOLLAR, 7 ether);
        p.recipient = sender;
        _payToken(p);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR + 7 * DOLLAR);
    }

    function test_constructor_rejectsPairsWithoutAusd_andDuplicates() public {
        MockPermitToken a = new MockPermitToken();
        MockPermitToken b = new MockPermitToken();
        address[] memory pairs = new address[](1);
        pairs[0] = address(new MockAgoraPair(address(a), address(b)));
        vm.expectRevert(EverpiecePay.InvalidPair.selector);
        new EverpiecePay(IAUSD(AUSD_ADDR), pairs);
        pairs = new address[](2);
        pairs[0] = address(pair);
        pairs[1] = address(new MockAgoraPair(address(ctk), AUSD_ADDR));
        vm.expectRevert(EverpiecePay.DuplicatePair.selector);
        new EverpiecePay(IAUSD(AUSD_ADDR), pairs);
    }

    function testFuzz_payWithToken_exactOutput(uint64 amount, uint16 feeBps) public {
        amount = uint64(bound(amount, 1, 500 * DOLLAR));
        feeBps = uint16(bound(feeBps, 0, 500));
        pair.setFeeBps(feeBps);
        uint256 quoted = pay.quote(address(ctk), amount);
        vm.assume(quoted <= 1_000 ether);
        _payToken(_p(address(ctk), amount, quoted));
        assertEq(ausd.balanceOf(recipient), amount);
        assertEq(ctk.balanceOf(sender), 1_000 ether - quoted);
        assertEq(ctk.balanceOf(address(pay)), 0);
    }
}
