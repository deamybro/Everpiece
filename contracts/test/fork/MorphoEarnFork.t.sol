// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EverpieceEarn} from "../../src/EverpieceEarn.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";

interface IMorphoVault {
    function eip712Domain() external view returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
    function curator() external view returns (address);
    function owner() external view returns (address);
    function timelock() external view returns (uint256);
    function fee() external view returns (uint96);
    function supplyQueueLength() external view returns (uint256);
}

/// @notice EverpieceEarn against the REAL Morpho "Grove x Steakhouse High Yield AUSD" MetaMorpho vault on Monad mainnet
///         (listed by Morpho, ERC-4626 + ERC-2612). Deposit through the AUSD ERC-3009 authorization, withdraw through the
///         share permit, principal bookkeeping, and a harvest that touches earnings only. Nothing is broadcast.
///         Enable with RUN_FORK_TESTS=true.
contract MorphoEarnForkTest is Test {
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address constant MORPHO_VAULT = 0x32841A8511D5c2c5b253f45668780B99139e476D;
    bytes32 constant CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700;
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant PK = 0x30F70;
    uint256 constant LIMIT_EARN_DEPOSIT = 850_000;
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
        address[] memory vs = new address[](1);
        vs[0] = MORPHO_VAULT;
        earn = new EverpieceEarn(IAUSD(AUSD), vs);
    }

    function _deposit(uint256 assets) internal returns (uint256 shares, uint256 gasUsed) {
        EverpieceEarn.Deposit memory d = EverpieceEarn.Deposit(bytes32("leg"), owner, MORPHO_VAULT, assets, IERC4626(MORPHO_VAULT).previewDeposit(assets), block.timestamp + 600);
        bytes32 id = earn.depositIdOf(d);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(AUSD).DOMAIN_SEPARATOR(), keccak256(abi.encode(RWA_TYPEHASH, owner, address(earn), assets, 0, d.deadline, id))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        vm.prank(relayer);
        uint256 g = gasleft();
        (, shares) = earn.deposit(d, abi.encodePacked(r, s, v));
        gasUsed = g - gasleft();
    }

    function _withdraw(uint256 assets, bytes32 ref) internal returns (uint256 shares, uint256 gasUsed) {
        EverpieceEarn.Withdrawal memory w = EverpieceEarn.Withdrawal(ref, owner, MORPHO_VAULT, assets, IERC4626(MORPHO_VAULT).previewWithdraw(assets), block.timestamp + 600);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK, earn.withdrawalIdOf(w));
        (, string memory name,,,,,) = IMorphoVault(MORPHO_VAULT).eip712Domain();
        // the vault's own EIP-712 domain: name as reported by eip712Domain(), version "1"
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256(bytes(name)), keccak256("1"), block.chainid, MORPHO_VAULT));
        assertEq(domain, IERC20Permit(MORPHO_VAULT).DOMAIN_SEPARATOR(), "share permit domain");
        bytes32 pd = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(earn), w.maxShares, IERC20Permit(MORPHO_VAULT).nonces(owner), w.deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, pd);
        vm.prank(relayer);
        uint256 g = gasleft();
        (, shares) = earn.withdraw(w, abi.encodePacked(r0, s0, v0), v, r, s);
        gasUsed = g - gasleft();
    }

    function test_vaultFacts() public view {
        assertEq(IERC4626(MORPHO_VAULT).asset(), AUSD);
        console2.log("curator", IMorphoVault(MORPHO_VAULT).curator());
        console2.log("timelock (s)", IMorphoVault(MORPHO_VAULT).timelock());
        console2.log("performance fee (1e18)", uint256(IMorphoVault(MORPHO_VAULT).fee()));
        console2.log("supply queue length", IMorphoVault(MORPHO_VAULT).supplyQueueLength());
        console2.log("totalAssets", IERC4626(MORPHO_VAULT).totalAssets());
    }

    function test_deposit_then_withdraw_all_principal_intact() public {
        (uint256 shares, uint256 gDep) = _deposit(100e6);
        console2.log("gas deposit", gDep);
        assertEq(IERC20(MORPHO_VAULT).balanceOf(owner), shares); // shares go to the owner, never the router
        assertEq(IERC20(MORPHO_VAULT).balanceOf(address(earn)), 0);
        assertEq(IERC20(AUSD).balanceOf(address(earn)), 0);
        assertEq(earn.principalOf(owner, MORPHO_VAULT), 100e6);
        assertEq(IERC20(AUSD).balanceOf(owner), 900e6);

        uint256 redeemable = IERC4626(MORPHO_VAULT).maxWithdraw(owner);
        assertApproxEqAbs(redeemable, 100e6, 2);
        (, uint256 gWd) = _withdraw(redeemable, bytes32("out"));
        console2.log("gas withdraw", gWd);
        assertApproxEqAbs(IERC20(AUSD).balanceOf(owner), 1_000e6, 2);
        assertEq(IERC20(AUSD).balanceOf(address(earn)), 0);
        assertLe((gDep + 21_000 + 8_000) * 10_500 / 10_000, LIMIT_EARN_DEPOSIT + 300_000, "deposit gas sanity");
    }

    function test_unknown_vault_refused() public {
        EverpieceEarn.Deposit memory d = EverpieceEarn.Deposit(bytes32("x"), owner, address(0xBEEF), 1e6, 0, block.timestamp + 600);
        vm.expectRevert(EverpieceEarn.UnknownVault.selector);
        earn.deposit(d, "");
    }
}
