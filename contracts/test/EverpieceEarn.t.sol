// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {EverpieceEarn} from "../src/EverpieceEarn.sol";
import {TestYieldVault} from "../src/testnet/TestYieldVault.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";

contract OtherAsset is ERC20 {
    constructor() ERC20("Other", "OTH") {}
}

/// @notice EverpieceEarn against MockAUSD (at the real AUSD address) and the TestYieldVault (same ERC-4626 + permit
///         surface as Aave's "Wrapped Aave Monad AUSD", which runs in test/fork/EverpieceEarnFork.t.sol).
contract EverpieceEarnTest is EscrowBase {
    EverpieceEarn internal earn;
    TestYieldVault internal vault;
    TestYieldVault internal vault2;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public override {
        super.setUp();
        vault = new TestYieldVault(IERC20(AUSD_ADDR));
        vault2 = new TestYieldVault(IERC20(AUSD_ADDR));
        address[] memory vs = new address[](1);
        vs[0] = address(vault);
        earn = new EverpieceEarn(IAUSD(AUSD_ADDR), vs);
        ausd.mint(sender, 1_000 * DOLLAR);
        start = ausd.balanceOf(sender);
    }

    uint256 internal start;

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    function _dep(uint256 assets) internal view returns (EverpieceEarn.Deposit memory) {
        return EverpieceEarn.Deposit({ref: bytes32("leg-1"), owner: sender, vault: address(vault), assets: assets, minShares: vault.previewDeposit(assets), deadline: block.timestamp + 600});
    }

    function _depSig(uint256 pk, EverpieceEarn.Deposit memory d) internal view returns (bytes memory) {
        bytes32 id = earn.depositIdOf(d);
        return _sig(pk, _ausdDigest(RWA_TYPEHASH, d.owner, address(earn), d.assets, 0, d.deadline, id));
    }

    function _deposit(uint256 assets) internal returns (uint256 shares) {
        EverpieceEarn.Deposit memory d = _dep(assets);
        bytes memory sig = _depSig(SENDER_PK, d);
        vm.prank(relayer);
        (, shares) = earn.deposit(d, sig);
    }

    function _wd(uint256 assets) internal view returns (EverpieceEarn.Withdrawal memory) {
        return EverpieceEarn.Withdrawal({ref: bytes32("harvest-1"), owner: sender, vault: address(vault), assets: assets, maxShares: vault.previewWithdraw(assets), deadline: block.timestamp + 600});
    }

    function _permit(uint256 pk, address ownerAddr, uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, ownerAddr, address(earn), value, vault.nonces(ownerAddr), deadline))));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _withdraw(EverpieceEarn.Withdrawal memory w, uint256 signerPk) internal returns (uint256 shares) {
        bytes memory os = _sig(signerPk, earn.withdrawalIdOf(w));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, w.owner, w.maxShares, w.deadline);
        vm.prank(relayer);
        (, shares) = earn.withdraw(w, os, v, r, s);
    }

    // ── deposits ─────────────────────────────────────────────────────────────────────────────────

    function test_deposit_sharesGoToOwner_contractKeepsNothing() public {
        uint256 shares = _deposit(100 * DOLLAR);
        assertEq(vault.balanceOf(sender), shares);
        assertEq(vault.convertToAssets(shares), 100 * DOLLAR);
        assertEq(ausd.balanceOf(sender), start - 100 * DOLLAR);
        assertEq(ausd.balanceOf(address(earn)), 0);
        assertEq(vault.balanceOf(address(earn)), 0);
        assertEq(IERC20(AUSD_ADDR).allowance(address(earn), address(vault)), 0);
    }

    function test_deposit_relayerCannotChangeTerms() public {
        EverpieceEarn.Deposit memory d = _dep(100 * DOLLAR);
        bytes memory sig = _depSig(SENDER_PK, d);
        EverpieceEarn.Deposit memory more = d;
        more.assets = 500 * DOLLAR; // the nonce (deposit id) changes → AUSD rejects the signature
        vm.expectRevert();
        earn.deposit(more, sig);
        EverpieceEarn.Deposit memory lowMin = d;
        lowMin.minShares = 0;
        vm.expectRevert();
        earn.deposit(lowMin, sig);
    }

    function test_deposit_onlyListedVaults() public {
        EverpieceEarn.Deposit memory d = _dep(100 * DOLLAR);
        d.vault = address(vault2);
        bytes memory sig = _depSig(SENDER_PK, d);
        vm.expectRevert(EverpieceEarn.UnknownVault.selector);
        earn.deposit(d, sig);
    }

    function test_deposit_replayExpiredAndSlippage() public {
        EverpieceEarn.Deposit memory d = _dep(100 * DOLLAR);
        bytes memory sig = _depSig(SENDER_PK, d);
        earn.deposit(d, sig);
        vm.expectRevert(EverpieceEarn.AlreadySettled.selector);
        earn.deposit(d, sig);

        // the share price moves up between quote and execution → fewer shares than signed for → revert
        EverpieceEarn.Deposit memory q = _dep(50 * DOLLAR);
        bytes memory qSig = _depSig(SENDER_PK, q);
        ausd.mint(address(vault), 20 * DOLLAR); // yield arrives first
        vm.expectRevert(EverpieceEarn.SlippageExceeded.selector);
        earn.deposit(q, qSig);

        EverpieceEarn.Deposit memory late = _dep(10 * DOLLAR);
        bytes memory lateSig = _depSig(SENDER_PK, late);
        vm.warp(late.deadline);
        vm.expectRevert(EverpieceEarn.Expired.selector);
        earn.deposit(late, lateSig);
    }

    // ── withdrawals ──────────────────────────────────────────────────────────────────────────────

    function test_withdraw_toOwnerOnly_onceOnly() public {
        _deposit(100 * DOLLAR);
        EverpieceEarn.Withdrawal memory w = _wd(40 * DOLLAR);
        _withdraw(w, SENDER_PK);
        assertEq(ausd.balanceOf(sender), start - 60 * DOLLAR);
        assertEq(vault.convertToAssets(vault.balanceOf(sender)), 60 * DOLLAR);
        assertEq(ausd.balanceOf(address(earn)), 0);
        // replay
        bytes memory os = _sig(SENDER_PK, earn.withdrawalIdOf(w));
        vm.expectRevert(EverpieceEarn.AlreadySettled.selector);
        earn.withdraw(w, os, 0, 0, 0);
    }

    function test_withdraw_needsOwnersSignature() public {
        _deposit(100 * DOLLAR);
        EverpieceEarn.Withdrawal memory w = _wd(40 * DOLLAR);
        bytes memory os = _sig(STRANGER_PK, earn.withdrawalIdOf(w));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, w.maxShares, w.deadline);
        vm.expectRevert(EverpieceEarn.InvalidOwnerSignature.selector);
        earn.withdraw(w, os, v, r, s);
    }

    function test_withdraw_permitFrontRunStillWorks() public {
        _deposit(100 * DOLLAR);
        EverpieceEarn.Withdrawal memory w = _wd(40 * DOLLAR);
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, w.maxShares, w.deadline);
        vault.permit(sender, address(earn), w.maxShares, w.deadline, v, r, s); // griefer submits the permit first
        bytes memory os = _sig(SENDER_PK, earn.withdrawalIdOf(w));
        earn.withdraw(w, os, v, r, s);
        assertEq(ausd.balanceOf(sender), start - 60 * DOLLAR);
    }

    function test_withdraw_maxSharesBounds_andLeftoverAllowanceIsUseless() public {
        _deposit(100 * DOLLAR);
        EverpieceEarn.Withdrawal memory w = _wd(40 * DOLLAR);
        w.maxShares = w.maxShares - 1; // signed for fewer shares than the withdrawal burns
        bytes memory os = _sig(SENDER_PK, earn.withdrawalIdOf(w));
        (uint8 v, bytes32 r, bytes32 s) = _permit(SENDER_PK, sender, w.maxShares, w.deadline);
        vm.expectRevert();
        earn.withdraw(w, os, v, r, s);
    }

    /// @notice The Earn → Invest building block: withdrawing exactly the yield leaves the principal's value intact.
    function test_harvestYieldOnly_principalIntact() public {
        _deposit(500 * DOLLAR);
        ausd.mint(address(vault), 12_400_000); // $12.40 of simulated yield (the only depositor gets all of it)
        uint256 value = vault.convertToAssets(vault.balanceOf(sender));
        assertApproxEqAbs(value, 512_400_000, 1);
        uint256 harvestable = value - 500 * DOLLAR;
        _withdraw(_wd(harvestable), SENDER_PK);
        assertGe(vault.convertToAssets(vault.balanceOf(sender)), 500 * DOLLAR - 1);
        assertEq(ausd.balanceOf(sender), start - 500 * DOLLAR + harvestable);
    }

    // ── construction ─────────────────────────────────────────────────────────────────────────────

    function test_constructor_rejectsNonAusdVaults() public {
        ERC4626 other = new TestYieldVault(IERC20(address(new OtherAsset())));
        address[] memory vs = new address[](1);
        vs[0] = address(other);
        vm.expectRevert(EverpieceEarn.InvalidVault.selector);
        new EverpieceEarn(IAUSD(AUSD_ADDR), vs);
        address[] memory dup = new address[](2);
        dup[0] = address(vault);
        dup[1] = address(vault);
        vm.expectRevert(EverpieceEarn.DuplicateVault.selector);
        new EverpieceEarn(IAUSD(AUSD_ADDR), dup);
        address[] memory eoa = new address[](1);
        eoa[0] = makeAddr("eoa");
        vm.expectRevert(EverpieceEarn.InvalidVault.selector);
        new EverpieceEarn(IAUSD(AUSD_ADDR), eoa);
    }

    function testFuzz_depositWithdraw_neverLeavesFundsInRouter(uint96 a, uint96 b) public {
        uint256 assets = bound(uint256(a), 1, 1_000 * DOLLAR);
        _deposit(assets);
        uint256 out = bound(uint256(b), 1, vault.maxWithdraw(sender));
        _withdraw(_wd(out), SENDER_PK);
        assertEq(ausd.balanceOf(address(earn)), 0);
        assertEq(vault.balanceOf(address(earn)), 0);
        assertGe(ausd.balanceOf(sender) + vault.convertToAssets(vault.balanceOf(sender)) + 1, start);
    }
}
