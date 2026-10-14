// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {EverpieceAutomate} from "../src/EverpieceAutomate.sol";

contract PermitDollar is ERC20Permit {
    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}
    function mint(address to, uint256 v) external { _mint(to, v); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract Vault4626 is ERC4626 {
    constructor(IERC20 a) ERC20("Vault", "vUSDC") ERC4626(a) {}
}

contract EverpieceAutomateTest is Test {
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    PermitDollar usdc;
    Vault4626 vault;
    Vault4626 otherVault;
    EverpieceAutomate auto_;
    uint256 constant OWNER_PK = 0x0A11CE;
    address owner;
    address executor = makeAddr("relayer");

    function setUp() public {
        vm.warp(1_790_000_000);
        owner = vm.addr(OWNER_PK);
        usdc = new PermitDollar();
        vault = new Vault4626(usdc);
        otherVault = new Vault4626(usdc);
        address[] memory vs = new address[](1);
        vs[0] = address(vault);
        auto_ = new EverpieceAutomate(vs);
        usdc.mint(owner, 1_000e6);
    }

    function _grant() internal view returns (EverpieceAutomate.Grant memory) {
        return EverpieceAutomate.Grant({
            ruleId: keccak256("rule-1"),
            owner: owner,
            executor: executor,
            vault: address(vault),
            maxPerExecution: 50e6,
            maxPerDay: 80e6,
            total: 200e6,
            expiresAt: block.timestamp + 30 days
        });
    }

    function _sign(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _activate(EverpieceAutomate.Grant memory g) internal returns (bytes32 id) {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 pd = keccak256(
            abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(auto_), g.total, usdc.nonces(owner), dl)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, pd);
        id = auto_.activate(g, _sign(auto_.grantIdOf(g)), dl, v, r, s);
    }

    function test_activate_and_execute_into_owners_position() public {
        bytes32 id = _activate(_grant());
        assertEq(usdc.allowance(owner, address(auto_)), 200e6);
        vm.prank(executor);
        uint256 shares = auto_.execute(id, keccak256("exec-1"), 40e6, 40e6);
        assertEq(vault.balanceOf(owner), shares);
        assertEq(vault.convertToAssets(shares), 40e6);
        assertEq(usdc.balanceOf(owner), 960e6);
        assertEq(usdc.balanceOf(address(auto_)), 0);
        assertEq(vault.balanceOf(address(auto_)), 0);
        assertEq(auto_.principalOf(owner, address(vault)), 40e6);
    }

    function test_only_the_executor() public {
        bytes32 id = _activate(_grant());
        vm.expectRevert(EverpieceAutomate.NotExecutor.selector);
        auto_.execute(id, keccak256("x"), 1e6, 0);
        vm.prank(owner);
        vm.expectRevert(EverpieceAutomate.NotExecutor.selector);
        auto_.execute(id, keccak256("x"), 1e6, 0);
    }

    function test_caps_per_execution_day_total() public {
        bytes32 id = _activate(_grant());
        vm.startPrank(executor);
        vm.expectRevert(EverpieceAutomate.AboveExecutionCap.selector);
        auto_.execute(id, keccak256("a"), 51e6, 0);
        auto_.execute(id, keccak256("b"), 50e6, 0);
        vm.expectRevert(EverpieceAutomate.AboveDailyCap.selector);
        auto_.execute(id, keccak256("c"), 31e6, 0);
        auto_.execute(id, keccak256("c"), 30e6, 0);
        assertEq(auto_.remaining(id), 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(auto_.remaining(id), 50e6);
        auto_.execute(id, keccak256("d"), 50e6, 0);
        auto_.execute(id, keccak256("e"), 30e6, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        auto_.execute(id, keccak256("f"), 40e6, 0); // 200 total reached
        vm.expectRevert(EverpieceAutomate.AboveTotal.selector);
        auto_.execute(id, keccak256("g"), 1, 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 800e6);
    }

    function test_idempotent_by_execution_id() public {
        bytes32 id = _activate(_grant());
        vm.startPrank(executor);
        auto_.execute(id, keccak256("same"), 10e6, 0);
        vm.expectRevert(EverpieceAutomate.AlreadyExecuted.selector);
        auto_.execute(id, keccak256("same"), 10e6, 0);
        vm.stopPrank();
    }

    function test_revoke_and_revokeBySig_and_expiry() public {
        bytes32 id = _activate(_grant());
        vm.prank(executor);
        vm.expectRevert(EverpieceAutomate.NotOwner.selector);
        auto_.revoke(id);
        vm.prank(owner);
        auto_.revoke(id);
        vm.prank(executor);
        vm.expectRevert(EverpieceAutomate.Revoked.selector);
        auto_.execute(id, keccak256("x"), 1e6, 0);

        EverpieceAutomate.Grant memory g2 = _grant();
        g2.ruleId = keccak256("rule-2");
        bytes32 id2 = _activate(g2);
        bytes32 rd = keccak256(abi.encodePacked("\x19\x01", auto_.DOMAIN_SEPARATOR(), keccak256(abi.encode(auto_.REVOKE_TYPEHASH(), id2))));
        vm.expectRevert(EverpieceAutomate.InvalidSignature.selector);
        auto_.revokeBySig(id2, abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27)));
        auto_.revokeBySig(id2, _sign(rd)); // anyone relays the owner's signed revocation
        assertEq(auto_.remaining(id2), 0);

        EverpieceAutomate.Grant memory g3 = _grant();
        g3.ruleId = keccak256("rule-3");
        bytes32 id3 = _activate(g3);
        vm.warp(g3.expiresAt);
        vm.prank(executor);
        vm.expectRevert(EverpieceAutomate.GrantExpired.selector);
        auto_.execute(id3, keccak256("y"), 1e6, 0);
    }

    function test_forged_or_tampered_grant_refused() public {
        EverpieceAutomate.Grant memory g = _grant();
        bytes memory sig = _sign(auto_.grantIdOf(g));
        g.total = 1_000e6; // signed 200
        vm.expectRevert(EverpieceAutomate.InvalidSignature.selector);
        auto_.activate(g, sig, 0, 0, 0, 0);
        g = _grant();
        g.executor = address(0xBAD); // signed for the relayer
        vm.expectRevert(EverpieceAutomate.InvalidSignature.selector);
        auto_.activate(g, sig, 0, 0, 0, 0);
    }

    function test_only_allowlisted_vaults_and_sane_bounds() public {
        EverpieceAutomate.Grant memory g = _grant();
        g.vault = address(otherVault);
        vm.expectRevert(EverpieceAutomate.UnknownVault.selector);
        auto_.activate(g, "", 0, 0, 0, 0);
        g = _grant();
        g.maxPerExecution = 100e6; // > maxPerDay
        vm.expectRevert(EverpieceAutomate.InvalidGrant.selector);
        auto_.activate(g, "", 0, 0, 0, 0);
        g = _grant();
        g.expiresAt = block.timestamp + 367 days;
        vm.expectRevert(EverpieceAutomate.InvalidGrant.selector);
        auto_.activate(g, "", 0, 0, 0, 0);
        g = _grant();
        g.expiresAt = block.timestamp;
        vm.expectRevert(EverpieceAutomate.InvalidGrant.selector);
        auto_.activate(g, "", 0, 0, 0, 0);
    }

    function test_permit_front_run_still_activates() public {
        EverpieceAutomate.Grant memory g = _grant();
        uint256 dl = block.timestamp + 1 hours;
        bytes32 pd = keccak256(
            abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(auto_), g.total, usdc.nonces(owner), dl)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, pd);
        usdc.permit(owner, address(auto_), g.total, dl, v, r, s); // griefer submits the permit first
        bytes32 id = auto_.activate(g, _sign(auto_.grantIdOf(g)), dl, v, r, s);
        vm.prank(executor);
        auto_.execute(id, keccak256("z"), 5e6, 0);
        assertEq(auto_.principalOf(owner, address(vault)), 5e6);
    }

    function test_cannot_reactivate_same_grant() public {
        EverpieceAutomate.Grant memory g = _grant();
        _activate(g);
        bytes memory sig = _sign(auto_.grantIdOf(g));
        vm.expectRevert(EverpieceAutomate.AlreadyActive.selector);
        auto_.activate(g, sig, 0, 0, 0, 0);
    }

    function test_min_shares_enforced() public {
        bytes32 id = _activate(_grant());
        vm.prank(executor);
        vm.expectRevert(EverpieceAutomate.SharesMismatch.selector);
        auto_.execute(id, keccak256("m"), 10e6, 10e6 + 1);
    }

    /// Whatever the executor tries, the owner never loses more than `total` and everything lands in their own position.
    function testFuzz_never_exceeds_signed_caps(uint256[8] memory amounts, uint8[8] memory dayJumps) public {
        bytes32 id = _activate(_grant());
        uint256 moved;
        for (uint256 i = 0; i < 8; i++) {
            uint256 a = bound(amounts[i], 1, 120e6);
            vm.warp(vm.getBlockTimestamp() + uint256(dayJumps[i] % 3) * 1 days);
            vm.prank(executor);
            try auto_.execute(id, keccak256(abi.encode(i)), a, 0) {
                moved += a;
            } catch {}
        }
        assertLe(moved, 200e6);
        assertEq(usdc.balanceOf(owner), 1_000e6 - moved);
        assertEq(vault.convertToAssets(vault.balanceOf(owner)), moved);
        assertEq(auto_.principalOf(owner, address(vault)), moved);
    }
}

/// @notice The grant id computed by packages/shared (automateModule.test.ts VECTOR_GRANT_ID) equals the contract's.
contract EverpieceAutomateVectorTest is Test {
    function test_grantId_matchesSharedTypeScript() public {
        vm.chainId(143);
        deployCodeTo("EverpieceAutomate.sol:EverpieceAutomate", abi.encode(new address[](0)), address(0x4444444444444444444444444444444444444444));
        EverpieceAutomate a = EverpieceAutomate(address(0x4444444444444444444444444444444444444444));
        EverpieceAutomate.Grant memory g = EverpieceAutomate.Grant({
            ruleId: bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            owner: vm.addr(0x0A11CE),
            executor: vm.addr(2),
            vault: 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2,
            maxPerExecution: 50_000_000,
            maxPerDay: 80_000_000,
            total: 200_000_000,
            expiresAt: 1_792_592_000
        });
        assertEq(a.grantIdOf(g), 0xdb2e60df89002d05f612da796d61f312f16838928123daae74a8c18fa1405ae7);
    }
}
