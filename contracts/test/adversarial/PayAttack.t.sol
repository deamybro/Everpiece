// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {EscrowBase} from "../utils/EscrowBase.t.sol";
import {EverpiecePay} from "../../src/EverpiecePay.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";
import {MockAgoraPair, MockPermitToken} from "../utils/MockAgoraPair.sol";

/// @dev A pair that takes `extra` more input than it reports (a dishonest or buggy settlement venue).
contract LyingPair {
    address public immutable token0;
    address public immutable token1;
    uint256 public extra;
    constructor(address s, address a) {
        token0 = s;
        token1 = a;
    }
    function setExtra(uint256 e) external {
        extra = e;
    }
    function hasRole(string memory, address) external pure returns (bool) {
        return true;
    }
    function getAmountsIn(uint256 out, address[] memory) external pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = out * 1e12;
        a[1] = out;
    }
    function swapTokensForExactTokens(uint256 out, uint256, address[] calldata, address to, uint256) external returns (uint256[] memory a) {
        uint256 reported = out * 1e12;
        IERC20(token0).transferFrom(msg.sender, address(this), reported + extra);
        IERC20(token1).transfer(to, out);
        a = new uint256[](2);
        a[0] = reported;
        a[1] = out;
    }
}

/// @dev A source token that, when armed, calls back into EverpiecePay from inside its own transfer.
contract HostileToken is ERC20Permit {
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public reentryError;
    constructor() ERC20("Hostile", "HOST") ERC20Permit("Hostile") {}
    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
    }
    function _update(address from, address to, uint256 v) internal override {
        super._update(from, to, v);
        if (target != address(0) && !reentered) {
            reentered = true;
            (bool ok, bytes memory ret) = target.call(payload);
            require(!ok, "reentry succeeded");
            reentryError = ret;
        }
    }
}

/// @notice Adversarial review of EverpiecePay (audit 2026-10-06, finding O2): every way a relayer, a third party, a
///         dishonest pair or a hostile token could move value the payer didn't sign for, or leave value behind.
///         P01–P12; the results are in FINDINGS.md.
contract PayAttackTest is EscrowBase {
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
        ausd.mint(address(pair), 1_000_000 * DOLLAR);
        ctk.mint(sender, 1_000 ether);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
    function _p(address source, uint256 amount, uint256 maxSource) internal view returns (EverpiecePay.Payment memory) {
        return EverpiecePay.Payment({
            ref: keccak256("ref"), sender: sender, recipient: recipient, amount: amount, sourceToken: source,
            maxSourceAmount: maxSource, deadline: block.timestamp + 10 minutes
        });
    }
    function _ausdSigFor(EverpiecePay target, EverpiecePay.Payment memory p) internal view returns (bytes memory) {
        return _sig(SENDER_PK, _ausdDigest(RWA_TYPEHASH, p.sender, address(target), p.amount, 0, p.deadline, target.paymentIdOf(p)));
    }
    function _permitFor(ERC20Permit token, address spender, uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 h = keccak256(abi.encode(PERMIT_TYPEHASH, sender, spender, value, token.nonces(sender), deadline));
        (v, r, s) = vm.sign(SENDER_PK, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), h)));
    }
    function _payToken(EverpiecePay target, ERC20Permit token, EverpiecePay.Payment memory p) internal returns (bytes32) {
        bytes memory payerSig = _sig(SENDER_PK, target.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permitFor(token, address(target), p.maxSourceAmount, p.deadline);
        vm.prank(relayer);
        return target.payWithToken(p, payerSig, p.deadline, v, r, s);
    }

    // ── P01 path confusion ───────────────────────────────────────────────────────────────────────────────────────
    function test_P01_ausdPaymentCannotGoThroughTokenPath_andViceVersa() public {
        EverpiecePay.Payment memory a = _p(AUSD_ADDR, 5 * DOLLAR, 5 * DOLLAR);
        bytes memory aSig = _sig(SENDER_PK, pay.paymentIdOf(a)); // signed before expectRevert (it binds the next call)
        vm.expectRevert(EverpiecePay.UnsupportedToken.selector);
        vm.prank(relayer);
        pay.payWithToken(a, aSig, a.deadline, 0, bytes32(0), bytes32(0));
        EverpiecePay.Payment memory t = _p(address(ctk), 5 * DOLLAR, 6 ether);
        bytes memory tSig = _ausdSigFor(pay, t);
        vm.expectRevert(EverpiecePay.WrongSourceToken.selector);
        vm.prank(relayer);
        pay.payWithAusd(t, tSig);
    }

    // ── P02 / P03 authorizations don't cross contracts ───────────────────────────────────────────────────────────
    function test_P02_escrowFundingAuthorizationCannotFundAPayment() public {
        IEverpieceEscrow.PaymentIntent memory i = _usernameIntent(5 * DOLLAR);
        bytes memory escrowAuth = _fundingSig(SENDER_PK, i); // ReceiveWithAuthorization to = escrow, nonce = escrow id
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 5 * DOLLAR, 5 * DOLLAR);
        vm.expectRevert();
        vm.prank(relayer);
        pay.payWithAusd(p, escrowAuth);
        assertEq(ausd.balanceOf(recipient), 0);
        _create(i); // and the escrow authorization is still usable where it belongs
    }
    function test_P03_signatureForOneDeploymentCannotSettleOnAnother() public {
        address[] memory pairs = new address[](1);
        pairs[0] = address(pair);
        EverpiecePay other = new EverpiecePay(IAUSD(AUSD_ADDR), pairs);
        pair.setApprovedSwapper(address(other), true);
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 5 * DOLLAR, 5 * DOLLAR);
        bytes memory sigForPay = _ausdSigFor(pay, p);
        vm.expectRevert();
        vm.prank(relayer);
        other.payWithAusd(p, sigForPay);
        EverpiecePay.Payment memory t = _p(address(ctk), 5 * DOLLAR, 6 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(t));
        (uint8 v, bytes32 r, bytes32 s) = _permitFor(ctk, address(other), t.maxSourceAmount, t.deadline);
        vm.expectRevert(EverpiecePay.InvalidPayerSignature.selector);
        vm.prank(relayer);
        other.payWithToken(t, payerSig, t.deadline, v, r, s);
    }

    // ── P04 no field can be changed under a signature (fuzzed) ───────────────────────────────────────────────────
    function testFuzz_P04_anyChangedField_isRejected(uint8 field, uint256 noise) public {
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 6 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permitFor(ctk, address(pay), p.maxSourceAmount, p.deadline);
        EverpiecePay.Payment memory q = p;
        field = field % 6;
        if (field == 0) q.ref = keccak256(abi.encode(noise));
        else if (field == 1) {
            q.recipient = address(uint160(bound(noise, 1, type(uint160).max)));
            if (q.recipient == recipient) q.recipient = address(0xBEEF);
        }
        else if (field == 2) q.amount = p.amount + bound(noise, 1, 1e12);
        else if (field == 3) q.maxSourceAmount = p.maxSourceAmount + bound(noise, 1, 1e24);
        else if (field == 4) q.deadline = p.deadline + bound(noise, 1, 1 days);
        else q.amount = bound(noise, 1, p.amount - 1);
        if (q.recipient == address(pay)) q.recipient = address(0xBEEF);
        vm.expectRevert();
        vm.prank(relayer);
        pay.payWithToken(q, payerSig, p.deadline, v, r, s);
        assertEq(ausd.balanceOf(q.recipient == address(0) ? recipient : q.recipient), 0);
        assertEq(ctk.balanceOf(sender), 1_000 ether);
    }

    // ── P05 value already in the contract is never paid out ──────────────────────────────────────────────────────
    function test_P05_strandedTokensStayPut_payerGetsOnlyTheirOwnLeftover() public {
        ctk.mint(address(pay), 7 ether); // someone sent tokens to the contract
        ausd.mint(address(pay), 3 * DOLLAR);
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 6 ether); // quote 5e18, ceiling 6e18
        _payToken(pay, ctk, p);
        assertEq(ausd.balanceOf(recipient), 5 * DOLLAR);
        assertEq(ctk.balanceOf(sender), 1_000 ether - 5 ether, "charged exactly the swap's input");
        assertEq(ctk.balanceOf(address(pay)), 7 ether, "stranded source untouched");
        assertEq(ausd.balanceOf(address(pay)), 3 * DOLLAR, "stranded AUSD untouched");
    }

    // ── P06 a pair that takes more than it reports ───────────────────────────────────────────────────────────────
    function test_P06_lyingPair_cannotOvercharge() public {
        LyingPair liar = new LyingPair(address(ctk), AUSD_ADDR);
        ausd.mint(address(liar), 1_000 * DOLLAR);
        address[] memory pairs = new address[](1);
        pairs[0] = address(liar);
        EverpiecePay p2 = new EverpiecePay(IAUSD(AUSD_ADDR), pairs);
        liar.setExtra(0.5 ether);
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 6 ether);
        bytes memory payerSig = _sig(SENDER_PK, p2.paymentIdOf(p));
        (uint8 v, bytes32 r, bytes32 s) = _permitFor(ctk, address(p2), p.maxSourceAmount, p.deadline);
        vm.expectRevert(EverpiecePay.SettlementMismatch.selector);
        vm.prank(relayer);
        p2.payWithToken(p, payerSig, p.deadline, v, r, s);
        assertEq(ctk.balanceOf(sender), 1_000 ether, "nothing charged");
    }

    // ── P07 a hostile source token re-entering mid-payment ───────────────────────────────────────────────────────
    function test_P07_reentryFromSourceToken_isBlocked_andNothingExtraMoves() public {
        HostileToken host = new HostileToken();
        MockAgoraPair hp = new MockAgoraPair(address(host), AUSD_ADDR);
        ausd.mint(address(hp), 1_000 * DOLLAR);
        address[] memory pairs = new address[](1);
        pairs[0] = address(hp);
        EverpiecePay p3 = new EverpiecePay(IAUSD(AUSD_ADDR), pairs);
        hp.setApprovedSwapper(address(p3), true);
        host.mint(sender, 100 ether);
        // the re-entrant call tries a second, separately signed payment to an attacker during the first one
        EverpiecePay.Payment memory evil = _p(address(host), 5 * DOLLAR, 6 ether);
        evil.recipient = stranger;
        evil.ref = keccak256("evil");
        bytes memory evilSig = _sig(SENDER_PK, p3.paymentIdOf(evil));
        host.arm(address(p3), abi.encodeCall(EverpiecePay.payWithToken, (evil, evilSig, evil.deadline, 0, bytes32(0), bytes32(0))));
        EverpiecePay.Payment memory p = _p(address(host), 5 * DOLLAR, 6 ether);
        _payToken(p3, host, p);
        assertTrue(host.reentered(), "the hostile callback ran");
        assertEq(bytes4(host.reentryError()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(ausd.balanceOf(stranger), 0, "the re-entrant payment moved nothing");
        assertEq(ausd.balanceOf(recipient), 5 * DOLLAR);
        assertEq(host.balanceOf(address(p3)), 0);
    }

    // ── P08 recipients that would break accounting ───────────────────────────────────────────────────────────────
    function test_P08_recipientIsThisContract_orThePair_isRejected() public {
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 5 * DOLLAR, 5 * DOLLAR);
        p.recipient = address(pay);
        bytes memory pSig = _ausdSigFor(pay, p);
        vm.expectRevert(EverpiecePay.InvalidRecipient.selector);
        vm.prank(relayer);
        pay.payWithAusd(p, pSig);
        EverpiecePay.Payment memory t = _p(address(ctk), 5 * DOLLAR, 6 ether);
        t.recipient = address(pair); // the pair paying itself would show no AUSD gain
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(t));
        (uint8 v, bytes32 r, bytes32 s) = _permitFor(ctk, address(pay), t.maxSourceAmount, t.deadline);
        vm.expectRevert(EverpiecePay.SettlementMismatch.selector);
        vm.prank(relayer);
        pay.payWithToken(t, payerSig, t.deadline, v, r, s);
        assertEq(ctk.balanceOf(sender), 1_000 ether);
    }

    // ── P09 no allowance is left behind ──────────────────────────────────────────────────────────────────────────
    function test_P09_noLeftoverAllowances() public {
        _payToken(pay, ctk, _p(address(ctk), 5 * DOLLAR, 6 ether));
        assertEq(ctk.allowance(sender, address(pay)), 0, "payer -> contract");
        assertEq(ctk.allowance(address(pay), address(pair)), 0, "contract -> pair");
    }

    // ── P10 exact deadline boundary ──────────────────────────────────────────────────────────────────────────────
    function test_P10_deadlineIsExclusive() public {
        EverpiecePay.Payment memory p = _p(AUSD_ADDR, 5 * DOLLAR, 5 * DOLLAR);
        bytes memory sig = _ausdSigFor(pay, p);
        vm.warp(p.deadline);
        vm.expectRevert(EverpiecePay.Expired.selector);
        vm.prank(relayer);
        pay.payWithAusd(p, sig);
        vm.warp(p.deadline - 1);
        vm.prank(relayer);
        pay.payWithAusd(p, sig);
        assertEq(ausd.balanceOf(recipient), 5 * DOLLAR);
    }

    // ── P11 griefing with a bad permit doesn't burn the payment ──────────────────────────────────────────────────
    function test_P11_frontRunWithBadPermit_moveNothing_realSubmissionStillWorks() public {
        EverpiecePay.Payment memory p = _p(address(ctk), 5 * DOLLAR, 6 ether);
        bytes memory payerSig = _sig(SENDER_PK, pay.paymentIdOf(p));
        vm.expectRevert(); // no allowance: the payment reverts and stays unsettled
        vm.prank(stranger);
        pay.payWithToken(p, payerSig, p.deadline + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        assertFalse(pay.settled(pay.paymentIdOf(p)));
        _payToken(pay, ctk, p);
        assertEq(ausd.balanceOf(recipient), 5 * DOLLAR);
    }

    // ── P12 the contract never keeps anything (fuzzed over amount and fee) ───────────────────────────────────────
    function testFuzz_P12_contractKeepsNothing(uint64 amount, uint16 feeBps) public {
        amount = uint64(bound(amount, 1, 500 * DOLLAR));
        pair.setFeeBps(bound(feeBps, 0, 500));
        uint256 need = pay.quote(address(ctk), amount);
        uint256 ceiling = need + need / 100 + 1;
        vm.assume(ceiling <= 1_000 ether);
        uint256 ctkBefore = ctk.balanceOf(address(pay));
        uint256 ausdBefore = ausd.balanceOf(address(pay));
        _payToken(pay, ctk, _p(address(ctk), amount, ceiling));
        assertEq(ctk.balanceOf(address(pay)), ctkBefore);
        assertEq(ausd.balanceOf(address(pay)), ausdBefore);
        assertEq(ausd.balanceOf(recipient), amount);
        assertEq(ctk.balanceOf(sender), 1_000 ether - need);
    }
}
