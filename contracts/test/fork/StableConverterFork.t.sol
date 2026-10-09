// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EverpieceStableConverter, IV4PoolManager} from "../../src/EverpieceStableConverter.sol";

/// @notice EverpieceStableConverter on CURRENT Monad mainnet: the real Uniswap v4 PoolManager and AUSD/USDC pool
///         (fee 9, tickSpacing 1, no hooks; VERIFIED §4.19). Enable with RUN_FORK_TESTS=true.
contract StableConverterForkTest is Test {
    address constant PM = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AAVE_AUSDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    bytes32 constant AUSD_CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700;

    EverpieceStableConverter conv;
    address user = makeAddr("user");
    address maris = makeAddr("maris");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        conv = new EverpieceStableConverter(IV4PoolManager(PM), AUSD, USDC, 9, 1);
        vm.prank(AAVE_AUSDC);
        IERC20(USDC).transfer(user, 1_000e6);
        vm.store(AUSD, keccak256(abi.encode(user, AUSD_CORE_SLOT)), bytes32(uint256(1_000e6) << 8));
        vm.startPrank(user);
        IERC20(USDC).approve(address(conv), type(uint256).max);
        IERC20(AUSD).approve(address(conv), type(uint256).max);
        vm.stopPrank();
    }

    function test_usdc_to_ausd_exactOut() public {
        vm.prank(user);
        uint256 g = gasleft();
        uint256 used = conv.convertExactOut(USDC, AUSD, 100e6, 100_500_000, maris);
        console.log("gas USDC->AUSD:", g - gasleft());
        console.log("USDC used for 100 AUSD:", used);
        assertEq(IERC20(AUSD).balanceOf(maris), 100e6);
        assertEq(IERC20(USDC).balanceOf(user), 1_000e6 - used);
        assertLe(used, 100e6); // AUSD trades at/under par here
        assertEq(IERC20(USDC).balanceOf(address(conv)), 0);
        assertEq(IERC20(AUSD).balanceOf(address(conv)), 0);
    }

    function test_ausd_to_usdc_exactOut() public {
        vm.prank(user);
        uint256 used = conv.convertExactOut(AUSD, USDC, 100e6, 100_500_000, maris);
        console.log("AUSD used for 100 USDC:", used);
        assertEq(IERC20(USDC).balanceOf(maris), 100e6);
        assertEq(IERC20(AUSD).balanceOf(user), 1_000e6 - used);
    }

    function test_small_1_dollar() public {
        vm.prank(user);
        uint256 used = conv.convertExactOut(USDC, AUSD, 1e6, 1_010_000, maris);
        console.log("USDC used for 1 AUSD:", used);
        assertEq(IERC20(AUSD).balanceOf(maris), 1e6);
    }

    function test_maxIn_enforced() public {
        vm.prank(user);
        vm.expectRevert();
        conv.convertExactOut(AUSD, USDC, 100e6, 99e6, maris);
        assertEq(IERC20(AUSD).balanceOf(user), 1_000e6);
    }

    function test_callback_not_drivable() public {
        vm.expectRevert(EverpieceStableConverter.NotPoolManager.selector);
        conv.unlockCallback("");
        vm.prank(PM);
        vm.expectRevert(EverpieceStableConverter.NotInSwap.selector);
        conv.unlockCallback("");
    }

    function test_unsupported_pair() public {
        vm.prank(user);
        vm.expectRevert(EverpieceStableConverter.UnsupportedPair.selector);
        conv.convertExactOut(USDC, USDC, 1e6, 1e6, maris);
    }
}
