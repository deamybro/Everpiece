// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EverpieceEarn} from "../../src/EverpieceEarn.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";

/// @notice EverpieceEarn against the REAL Monad mainnet AUSD and Aave V3 "Wrapped Aave Monad AUSD" (waMonAUSD,
///         ERC-4626 + permit; docs/EARN.md, VERIFIED §4.17). Deposit, real interest accrual over time, harvest exactly
///         the yield, principal intact; gas for the relayer limits. Nothing is broadcast. RUN_FORK_TESTS=true.
contract EverpieceEarnMainnetForkTest is Test {
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address constant WA_AUSD = 0x9e1AcC5BFbf34e2E579763cE14042d957719fE76; // Aave address book AUSD_STATA_TOKEN
    address constant A_AUSD = 0xdeBFeDF35faEd5d1664E553545e144C02227A2Ec;
    bytes32 constant CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700; // VERIFIED §2.12
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant PK = 0xE4A1;
    /// Relayer gas limits (server/relayer config + test/gasLimits.test.ts). Monad charges the full limit.
    uint256 constant LIMIT_EARN_DEPOSIT = 800_000;
    uint256 constant LIMIT_EARN_WITHDRAW = 750_000;

    EverpieceEarn earn;
    address owner;
    address relayer = makeAddr("relayer");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);
        owner = vm.addr(PK);
        vm.store(AUSD, keccak256(abi.encode(owner, CORE_SLOT)), bytes32(uint256(1_000e6) << 8));
        assertEq(IERC20(AUSD).balanceOf(owner), 1_000e6);
        address[] memory vs = new address[](1);
        vs[0] = WA_AUSD;
        earn = new EverpieceEarn(IAUSD(AUSD), vs);
    }

    function _deposit(uint256 assets) internal returns (uint256 shares, uint256 gasUsed) {
        EverpieceEarn.Deposit memory d = EverpieceEarn.Deposit(bytes32("leg"), owner, WA_AUSD, assets, IERC4626(WA_AUSD).previewDeposit(assets), block.timestamp + 600);
        bytes32 id = earn.depositIdOf(d);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(AUSD).DOMAIN_SEPARATOR(), keccak256(abi.encode(RWA_TYPEHASH, owner, address(earn), assets, 0, d.deadline, id))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        vm.prank(relayer);
        uint256 g = gasleft();
        (, shares) = earn.deposit(d, abi.encodePacked(r, s, v));
        gasUsed = g - gasleft();
    }

    function _withdraw(uint256 assets) internal returns (uint256 shares, uint256 gasUsed) {
        return _withdraw(assets, bytes32("out"));
    }

    function _withdraw(uint256 assets, bytes32 ref) internal returns (uint256 shares, uint256 gasUsed) {
        EverpieceEarn.Withdrawal memory w = EverpieceEarn.Withdrawal(ref, owner, WA_AUSD, assets, IERC4626(WA_AUSD).previewWithdraw(assets), block.timestamp + 600);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK, earn.withdrawalIdOf(w));
        bytes32 pd = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(WA_AUSD).DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(earn), w.maxShares, IERC20Permit(WA_AUSD).nonces(owner), w.deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, pd);
        vm.prank(relayer);
        uint256 g = gasleft();
        (, shares) = earn.withdraw(w, abi.encodePacked(r0, s0, v0), v, r, s);
        gasUsed = g - gasleft();
    }

    function test_realAave_deposit_accrue_harvestYieldOnly() public {
        assertEq(IERC4626(WA_AUSD).asset(), AUSD);
        (uint256 shares, uint256 gasDep) = _deposit(100e6);
        assertEq(IERC20(WA_AUSD).balanceOf(owner), shares);
        uint256 v0 = IERC4626(WA_AUSD).convertToAssets(shares);
        assertApproxEqAbs(v0, 100e6, 1); // ERC-4626 rounds down by at most 1 unit
        assertEq(IERC20(AUSD).balanceOf(address(earn)), 0);
        assertEq(IERC20(WA_AUSD).balanceOf(address(earn)), 0);

        // real interest: Aave's normalized income grows with time
        vm.warp(block.timestamp + 30 days);
        uint256 v1 = IERC4626(WA_AUSD).convertToAssets(shares);
        assertGt(v1, v0);
        assertEq(earn.principalOf(owner, WA_AUSD), 100e6);
        uint256 harvestable = v1 - 100e6 - 2; // principal is on-chain; 2 units of ERC-4626 rounding margin
        console2.log("30-day yield on $100 (base units)", harvestable);

        uint256 before = IERC20(AUSD).balanceOf(owner);
        (, uint256 gasWd) = _withdraw(harvestable, bytes32(abi.encodePacked(bytes4(0x48525631), bytes28(0)))); // HARVEST
        assertEq(IERC20(AUSD).balanceOf(owner), before + harvestable);
        // principal intact (to rounding)
        assertGe(IERC4626(WA_AUSD).convertToAssets(IERC20(WA_AUSD).balanceOf(owner)), 100e6);
        console2.log("gas deposit", gasDep);
        console2.log("gas withdraw", gasWd);
        assertLt(gasDep, LIMIT_EARN_DEPOSIT);
        assertLt(gasWd, LIMIT_EARN_WITHDRAW);
    }

    function test_realAave_withdrawAll_liquidityBound() public {
        _deposit(100e6);
        uint256 maxW = IERC4626(WA_AUSD).maxWithdraw(owner);
        assertApproxEqAbs(maxW, 100e6, 1);
        // the reserve's free liquidity bounds every withdrawal (utilization risk, docs/EARN.md)
        assertGt(IERC20(AUSD).balanceOf(A_AUSD), maxW);
        _withdraw(maxW);
        assertLe(IERC4626(WA_AUSD).convertToAssets(IERC20(WA_AUSD).balanceOf(owner)), 1);
    }
}
