// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EverpiecePayV2} from "../src/EverpiecePayV2.sol";
import {MockAUSD} from "./utils/MockAUSD.sol";

/// @dev Agora AgoraStableSwapPair semantics (as MockAgoraPair) but between two 6-dp dollars, in BOTH directions, as
///      the real Monad AUSD/USDC pair: 1:1 plus a purchase fee on the input, APPROVED_SWAPPER gate.
contract MockStablePair {
    address public immutable token0;
    address public immutable token1;
    mapping(address => bool) public approvedSwapper;
    uint256 public feeBps;
    bool public shortDeliver;
    bool public quoteReverts;

    error ExcessiveInputAmount();
    error Expired();
    error NotApprovedSwapper();
    error InvalidPath();

    constructor(address a, address b) {
        token0 = a;
        token1 = b;
    }

    function setApprovedSwapper(address s, bool ok) external { approvedSwapper[s] = ok; }
    function setFeeBps(uint256 f) external { feeBps = f; }
    function setShortDeliver(bool v) external { shortDeliver = v; }
    function setQuoteReverts(bool v) external { quoteReverts = v; }

    function hasRole(string memory role, address a) external view returns (bool) {
        return keccak256(bytes(role)) == keccak256("APPROVED_SWAPPER") && approvedSwapper[a];
    }

    function _check(address[] memory path) internal view {
        if (path.length != 2) revert InvalidPath();
        bool fwd = path[0] == token0 && path[1] == token1;
        bool rev = path[0] == token1 && path[1] == token0;
        if (!fwd && !rev) revert InvalidPath();
    }

    function _in(uint256 out) internal view returns (uint256) {
        return out + (out * feeBps + 9_999) / 10_000;
    }

    function getAmountsIn(uint256 amountOut, address[] memory path) external view returns (uint256[] memory a) {
        if (quoteReverts) revert InvalidPath();
        _check(path);
        a = new uint256[](2);
        a[0] = _in(amountOut);
        a[1] = amountOut;
    }

    function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory a)
    {
        if (!approvedSwapper[msg.sender]) revert NotApprovedSwapper();
        if (block.timestamp > deadline) revert Expired();
        _check(path);
        uint256 amountIn = _in(amountOut);
        if (amountIn > amountInMax) revert ExcessiveInputAmount();
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).transfer(to, shortDeliver ? amountOut - 1 : amountOut);
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = amountOut;
    }
}

contract EverpiecePayV2Test is Test {
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    MockAUSD ausd;
    MockAUSD usdc; // FiatToken-like for these purposes; its AUSD flag read always reverts (USDC has no such flag)
    MockStablePair pair;
    EverpiecePayV2 pay;

    uint256 constant PK = 0xA11CE;
    address payer;
    address maris = makeAddr("maris");

    function setUp() public {
        payer = vm.addr(PK);
        ausd = new MockAUSD();
        usdc = new MockAUSD();
        usdc.setFlagReadReverts(true);
        pair = new MockStablePair(address(ausd), address(usdc));
        pay = new EverpiecePayV2(_assets(), _pairs());
        pair.setApprovedSwapper(address(pay), true);
        ausd.mint(payer, 1_000e6);
        usdc.mint(payer, 1_000e6);
        ausd.mint(address(pair), 1_000_000e6);
        usdc.mint(address(pair), 1_000_000e6);
    }

    function _assets() internal view returns (EverpiecePayV2.Asset[] memory a) {
        a = new EverpiecePayV2.Asset[](2);
        a[0] = EverpiecePayV2.Asset({token: address(usdc), ausdSemantics: false});
        a[1] = EverpiecePayV2.Asset({token: address(ausd), ausdSemantics: true});
    }

    function _pairs() internal view returns (address[] memory p) {
        p = new address[](1);
        p[0] = address(pair);
    }

    function _p(address asset, uint256 amount, address source, uint256 maxSource)
        internal
        view
        returns (EverpiecePayV2.Payment memory)
    {
        return EverpiecePayV2.Payment({
            ref: keccak256("req-1"),
            sender: payer,
            recipient: maris,
            asset: asset,
            amount: amount,
            sourceToken: source,
            maxSourceAmount: maxSource,
            deadline: block.timestamp + 10 minutes
        });
    }

    function _sig(EverpiecePayV2.Payment memory p) internal view returns (bytes memory) {
        bytes32 id = pay.paymentIdOf(p);
        bytes32 structHash =
            keccak256(abi.encode(RWA_TYPEHASH, p.sender, address(pay), p.maxSourceAmount, 0, p.deadline, id));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", MockAUSD(p.sourceToken).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _noDust() internal view {
        assertEq(ausd.balanceOf(address(pay)), 0);
        assertEq(usdc.balanceOf(address(pay)), 0);
    }

    // ---- direct ----------------------------------------------------------------------------------

    function test_direct_usdc() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 25e6, address(usdc), 25e6);
        bytes32 id = pay.paymentIdOf(p);
        vm.expectEmit(address(pay));
        emit EverpiecePayV2.Paid(id, p.ref, payer, maris, address(usdc), 25e6, address(usdc), 25e6, address(0));
        assertEq(pay.pay(p, _sig(p)), id);
        assertEq(usdc.balanceOf(maris), 25e6);
        assertEq(usdc.balanceOf(payer), 975e6);
        assertEq(ausd.balanceOf(maris), 0); // no silent substitution
        assertTrue(pay.settled(id));
        _noDust();
    }

    function test_direct_ausd() public {
        EverpiecePayV2.Payment memory p = _p(address(ausd), 7e6, address(ausd), 7e6);
        pay.pay(p, _sig(p));
        assertEq(ausd.balanceOf(maris), 7e6);
        assertEq(usdc.balanceOf(maris), 0);
        _noDust();
    }

    function test_direct_requires_exact_max() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 5e6, address(usdc), 6e6);
        bytes memory sig = _sig(p);
        vm.expectRevert(EverpiecePayV2.DirectAmountMismatch.selector);
        pay.pay(p, sig);
    }

    // ---- converted -------------------------------------------------------------------------------

    function test_usdc_to_ausd_exact_output_and_refund() public {
        pair.setFeeBps(3); // 0.03%
        (bool ok, uint256 need, address via) = pay.quote(address(usdc), address(ausd), 100e6);
        assertTrue(ok);
        assertEq(via, address(pair));
        assertEq(need, 100_030_000);
        EverpiecePayV2.Payment memory p = _p(address(ausd), 100e6, address(usdc), 101e6); // 1% headroom
        pay.pay(p, _sig(p));
        assertEq(ausd.balanceOf(maris), 100e6);
        assertEq(usdc.balanceOf(payer), 1_000e6 - need); // the unused headroom came back
        _noDust();
    }

    function test_ausd_to_usdc() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 40e6, address(ausd), 40e6);
        pay.pay(p, _sig(p));
        assertEq(usdc.balanceOf(maris), 40e6);
        assertEq(ausd.balanceOf(payer), 960e6);
        _noDust();
    }

    function test_conversion_unavailable_reverts_without_moving_funds() public {
        pair.setApprovedSwapper(address(pay), false);
        (bool ok,,) = pay.quote(address(usdc), address(ausd), 10e6);
        assertFalse(ok);
        EverpiecePayV2.Payment memory p = _p(address(ausd), 10e6, address(usdc), 10e6);
        bytes memory sig = _sig(p);
        vm.expectRevert(MockStablePair.NotApprovedSwapper.selector);
        pay.pay(p, sig);
        // atomic: the authorization is still unused, nothing moved, nothing stranded
        assertFalse(usdc.authorizationState(payer, pay.paymentIdOf(p)));
        assertEq(usdc.balanceOf(payer), 1_000e6);
        assertFalse(pay.settled(pay.paymentIdOf(p)));
        _noDust();
    }

    function test_price_moved_past_max_reverts() public {
        pair.setFeeBps(100);
        EverpiecePayV2.Payment memory p = _p(address(ausd), 10e6, address(usdc), 10_050_000);
        bytes memory sig = _sig(p);
        vm.expectRevert(MockStablePair.ExcessiveInputAmount.selector);
        pay.pay(p, sig);
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    function test_short_delivery_reverts() public {
        pair.setShortDeliver(true);
        EverpiecePayV2.Payment memory p = _p(address(ausd), 10e6, address(usdc), 10e6);
        bytes memory sig = _sig(p);
        vm.expectRevert(EverpiecePayV2.SettlementMismatch.selector);
        pay.pay(p, sig);
    }

    // ---- authorization ---------------------------------------------------------------------------

    function test_replay_reverts() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 1e6, address(usdc), 1e6);
        bytes memory sig = _sig(p);
        pay.pay(p, sig);
        vm.expectRevert(EverpiecePayV2.AlreadySettled.selector);
        pay.pay(p, sig);
    }

    function test_relayer_cannot_change_recipient_amount_or_asset() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 5e6, address(usdc), 5e6);
        bytes memory sig = _sig(p);

        EverpiecePayV2.Payment memory q = _p(address(usdc), 5e6, address(usdc), 5e6);
        q.recipient = address(0xBAD);
        vm.expectRevert(MockAUSD.InvalidSignature.selector);
        pay.pay(q, sig);

        q = _p(address(usdc), 6e6, address(usdc), 6e6);
        vm.expectRevert(MockAUSD.InvalidSignature.selector);
        pay.pay(q, sig);

        // same numbers, other asset: the USDC signature is not valid in the AUSD domain nor for the other id
        q = _p(address(ausd), 5e6, address(usdc), 5e6);
        vm.expectRevert(MockAUSD.InvalidSignature.selector);
        pay.pay(q, sig);

        pay.pay(p, sig);
        assertEq(usdc.balanceOf(maris), 5e6);
    }

    function test_front_run_receive_blocked_by_payee_check() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 5e6, address(usdc), 5e6);
        bytes memory sig = _sig(p);
        bytes32 id = pay.paymentIdOf(p);
        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(MockAUSD.InvalidPayee.selector, address(0xBEEF), address(pay)));
        usdc.receiveWithAuthorization(payer, address(pay), 5e6, 0, p.deadline, id, sig);
    }

    function test_expired() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 1e6, address(usdc), 1e6);
        bytes memory sig = _sig(p);
        vm.warp(p.deadline);
        vm.expectRevert(EverpiecePayV2.Expired.selector);
        pay.pay(p, sig);
    }

    // ---- assets & routes -------------------------------------------------------------------------

    function test_unsupported_asset_and_route() public {
        MockAUSD other = new MockAUSD();
        EverpiecePayV2.Payment memory p = _p(address(other), 1e6, address(other), 1e6);
        vm.expectRevert(EverpiecePayV2.UnsupportedAsset.selector);
        pay.pay(p, "");
        p = _p(address(usdc), 1e6, address(other), 1e6);
        vm.expectRevert(EverpiecePayV2.UnsupportedRoute.selector);
        pay.pay(p, "");
        (bool ok,,) = pay.quote(address(other), address(usdc), 1e6);
        assertFalse(ok);
    }

    function test_no_pair_means_direct_only() public {
        EverpiecePayV2 directOnly = new EverpiecePayV2(_assets(), new address[](0));
        (bool ok,,) = directOnly.quote(address(usdc), address(ausd), 1e6);
        assertFalse(ok);
        (bool ok2, uint256 amt,) = directOnly.quote(address(usdc), address(usdc), 1e6);
        assertTrue(ok2);
        assertEq(amt, 1e6);
    }

    function test_quote_reverting_pair_is_unavailable() public {
        pair.setQuoteReverts(true);
        (bool ok,,) = pay.quote(address(usdc), address(ausd), 1e6);
        assertFalse(ok);
    }

    function test_ausd_upgrade_fails_closed_usdc_unaffected() public {
        ausd.setReceiveWithAuthorizationUpgraded(true);
        EverpiecePayV2.Payment memory p = _p(address(ausd), 1e6, address(ausd), 1e6);
        bytes memory sig = _sig(p);
        vm.expectRevert(EverpiecePayV2.AusdSemanticsChanged.selector);
        pay.pay(p, sig);
        // USDC (no flag; its read even reverts) keeps working
        EverpiecePayV2.Payment memory q = _p(address(usdc), 1e6, address(usdc), 1e6);
        pay.pay(q, _sig(q));
        assertEq(usdc.balanceOf(maris), 1e6);
    }

    function test_ausd_flag_unreadable_fails_closed() public {
        ausd.setFlagReadReverts(true);
        EverpiecePayV2.Payment memory p = _p(address(ausd), 1e6, address(ausd), 1e6);
        bytes memory sig = _sig(p);
        vm.expectRevert(EverpiecePayV2.AusdSemanticsChanged.selector);
        pay.pay(p, sig);
    }

    function test_funding_shortfall_reverts() public {
        usdc.setFundingShortfall(1);
        EverpiecePayV2.Payment memory p = _p(address(usdc), 1e6, address(usdc), 1e6);
        bytes memory sig = _sig(p);
        vm.expectRevert(EverpiecePayV2.FundingMismatch.selector);
        pay.pay(p, sig);
    }

    function test_invalid_recipient_and_zero_amount() public {
        EverpiecePayV2.Payment memory p = _p(address(usdc), 1e6, address(usdc), 1e6);
        p.recipient = address(pay);
        vm.expectRevert(EverpiecePayV2.InvalidRecipient.selector);
        pay.pay(p, "");
        p = _p(address(usdc), 0, address(usdc), 0);
        vm.expectRevert(EverpiecePayV2.ZeroAmount.selector);
        pay.pay(p, "");
    }

    function test_constructor_rejects_bad_config() public {
        EverpiecePayV2.Asset[] memory dup = new EverpiecePayV2.Asset[](2);
        dup[0] = EverpiecePayV2.Asset({token: address(usdc), ausdSemantics: false});
        dup[1] = EverpiecePayV2.Asset({token: address(usdc), ausdSemantics: true});
        vm.expectRevert(EverpiecePayV2.DuplicateAsset.selector);
        new EverpiecePayV2(dup, new address[](0));

        EverpiecePayV2.Asset[] memory onlyUsdc = new EverpiecePayV2.Asset[](1);
        onlyUsdc[0] = EverpiecePayV2.Asset({token: address(usdc), ausdSemantics: false});
        vm.expectRevert(EverpiecePayV2.InvalidPair.selector); // a pair token that isn't an asset
        new EverpiecePayV2(onlyUsdc, _pairs());

        address[] memory twice = new address[](2);
        twice[0] = address(pair);
        twice[1] = address(pair);
        vm.expectRevert(EverpiecePayV2.DuplicatePair.selector);
        new EverpiecePayV2(_assets(), twice);
    }

    // ---- fuzz ------------------------------------------------------------------------------------

    function testFuzz_conversion_exact_and_no_dust(uint256 amount, uint256 feeBps, uint256 headroomBps, bool toAusd) public {
        amount = bound(amount, 1, 500e6);
        feeBps = bound(feeBps, 0, 50);
        headroomBps = bound(headroomBps, feeBps + 1, 100);
        pair.setFeeBps(feeBps);
        (address asset, address source) = toAusd ? (address(ausd), address(usdc)) : (address(usdc), address(ausd));
        uint256 maxSource = amount + (amount * headroomBps) / 10_000 + 1;
        vm.assume(maxSource <= 1_000e6);
        EverpiecePayV2.Payment memory p = _p(asset, amount, source, maxSource);
        uint256 srcBefore = IERC20(source).balanceOf(payer);
        (, uint256 need,) = pay.quote(source, asset, amount);
        pay.pay(p, _sig(p));
        assertEq(IERC20(asset).balanceOf(maris), amount);
        assertEq(srcBefore - IERC20(source).balanceOf(payer), need);
        _noDust();
    }
}

/// @notice The V2 payment id computed by packages/shared (payV2.test.ts VECTOR_PAYMENT_V2_ID) equals the contract's,
///         so the ERC-3009 nonce a payer signs in the app is exactly the id EverpiecePayV2 settles.
contract EverpiecePayV2VectorTest is Test {
    function test_paymentId_matchesSharedTypeScript() public {
        vm.chainId(143);
        EverpiecePayV2.Asset[] memory assets = new EverpiecePayV2.Asset[](0);
        deployCodeTo("EverpiecePayV2.sol:EverpiecePayV2", abi.encode(assets, new address[](0)), address(0x3333333333333333333333333333333333333333));
        EverpiecePayV2 pay = EverpiecePayV2(address(0x3333333333333333333333333333333333333333));
        EverpiecePayV2.Payment memory p = EverpiecePayV2.Payment({
            ref: bytes32(0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e),
            sender: vm.addr(1),
            recipient: vm.addr(2),
            asset: 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a,
            amount: 25_000_000,
            sourceToken: 0x754704Bc059F8C67012fEd69BC8A327a5aafb603,
            maxSourceAmount: 25_025_000,
            deadline: 1_790_700_600
        });
        assertEq(pay.paymentIdOf(p), 0x319990f49f91463a7fa68487ee40c1d804c088d4cf562bea596936e4b7b72df4);
    }
}
