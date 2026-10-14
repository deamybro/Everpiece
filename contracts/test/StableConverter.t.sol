// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EverpieceStableConverter, IV4PoolManager} from "../src/EverpieceStableConverter.sol";

contract Tok is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 v) external { _mint(to, v); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @dev v4 PoolManager stand-in with flash accounting semantics the converter relies on: unlock → callback; swap
///      returns a packed BalanceDelta (exact output: + output to the caller, − input); take pays out; sync + transfer
///      + settle pays in. Faults: partial fill (the price limit stops the swap early), extra input, unbalanced settle.
contract MockPoolManager {
    uint256 public feeBps;
    uint256 public fillBps = 10_000; // share of the requested output actually swapped
    address synced;
    uint256 syncedBalance;
    int256 owed; // input still owed by the locker; must be settled before unlock returns

    function setFeeBps(uint256 f) external { feeBps = f; }
    function setFillBps(uint256 f) external { fillBps = f; }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        r = EverpieceStableConverter(msg.sender).unlockCallback(data);
        require(owed == 0, "CurrencyNotSettled");
    }

    function swap(IV4PoolManager.PoolKey memory, IV4PoolManager.SwapParams memory p, bytes calldata) external returns (int256) {
        require(p.amountSpecified > 0, "exact output only in this mock");
        uint256 out = uint256(p.amountSpecified) * fillBps / 10_000;
        uint256 inp = out + (out * feeBps + 9_999) / 10_000;
        owed += int256(inp);
        (int128 a0, int128 a1) = p.zeroForOne ? (-int128(int256(inp)), int128(int256(out))) : (int128(int256(out)), -int128(int256(inp)));
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function take(address currency, address to, uint256 amount) external {
        IERC20(currency).transfer(to, amount);
    }

    function sync(address currency) external {
        synced = currency;
        syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        paid = IERC20(synced).balanceOf(address(this)) - syncedBalance;
        owed -= int256(paid);
    }
}

contract StableConverterTest is Test {
    Tok a; // currency0
    Tok b; // currency1
    MockPoolManager pm;
    EverpieceStableConverter conv;
    address user = makeAddr("user");
    address maris = makeAddr("maris");

    function setUp() public {
        Tok x = new Tok("X");
        Tok y = new Tok("Y");
        (a, b) = address(x) < address(y) ? (x, y) : (y, x);
        pm = new MockPoolManager();
        conv = new EverpieceStableConverter(IV4PoolManager(address(pm)), address(a), address(b), 9, 1);
        a.mint(address(pm), 1_000_000e6);
        b.mint(address(pm), 1_000_000e6);
        a.mint(user, 1_000e6);
        b.mint(user, 1_000e6);
        vm.startPrank(user);
        a.approve(address(conv), type(uint256).max);
        b.approve(address(conv), type(uint256).max);
        vm.stopPrank();
    }

    function test_exactOut_both_directions_refunds_unused() public {
        pm.setFeeBps(2);
        vm.prank(user);
        uint256 used = conv.convertExactOut(address(b), address(a), 100e6, 101e6, maris);
        assertEq(used, 100_020_000);
        assertEq(a.balanceOf(maris), 100e6);
        assertEq(b.balanceOf(user), 1_000e6 - used);
        vm.prank(user);
        conv.convertExactOut(address(a), address(b), 50e6, 51e6, maris);
        assertEq(b.balanceOf(maris), 50e6);
        assertEq(a.balanceOf(address(conv)) + b.balanceOf(address(conv)), 0);
    }

    function test_partial_fill_reverts_nothing_moves() public {
        pm.setFillBps(9_000);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(EverpieceStableConverter.PartialFill.selector, 90e6, 100e6));
        conv.convertExactOut(address(b), address(a), 100e6, 101e6, maris);
        assertEq(b.balanceOf(user), 1_000e6);
        assertEq(a.balanceOf(maris), 0);
    }

    function test_excessive_input_reverts() public {
        pm.setFeeBps(200);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(EverpieceStableConverter.ExcessiveInput.selector, 102e6, 101e6));
        conv.convertExactOut(address(b), address(a), 100e6, 101e6, maris);
    }

    function test_guards() public {
        vm.expectRevert(EverpieceStableConverter.NotPoolManager.selector);
        conv.unlockCallback("");
        vm.prank(address(pm));
        vm.expectRevert(EverpieceStableConverter.NotInSwap.selector);
        conv.unlockCallback("");
        vm.prank(user);
        vm.expectRevert(EverpieceStableConverter.UnsupportedPair.selector);
        conv.convertExactOut(address(a), address(a), 1e6, 1e6, maris);
        vm.prank(user);
        vm.expectRevert(EverpieceStableConverter.ZeroAmount.selector);
        conv.convertExactOut(address(a), address(b), 0, 1e6, maris);
        vm.expectRevert(EverpieceStableConverter.UnsupportedPair.selector);
        new EverpieceStableConverter(IV4PoolManager(address(pm)), address(b), address(a), 9, 1);
    }

    /// The converter only ever uses the CALLER's tokens: nobody can spend another user's approval through it.
    function test_cannot_spend_someone_elses_allowance() public {
        vm.prank(makeAddr("thief"));
        vm.expectRevert();
        conv.convertExactOut(address(b), address(a), 10e6, 10e6, makeAddr("thief"));
        assertEq(b.balanceOf(user), 1_000e6);
    }

    function testFuzz_exact_or_revert(uint256 out, uint256 fee, uint256 headroom) public {
        out = bound(out, 1, 500e6);
        fee = bound(fee, 0, 50);
        headroom = bound(headroom, 0, 100);
        pm.setFeeBps(fee);
        uint256 maxIn = out + out * headroom / 10_000;
        uint256 need = out + (out * fee + 9_999) / 10_000;
        vm.prank(user);
        if (need > maxIn) {
            vm.expectRevert();
            conv.convertExactOut(address(b), address(a), out, maxIn, maris);
        } else {
            conv.convertExactOut(address(b), address(a), out, maxIn, maris);
            assertEq(a.balanceOf(maris), out);
            assertEq(b.balanceOf(user), 1_000e6 - need);
        }
    }
}
