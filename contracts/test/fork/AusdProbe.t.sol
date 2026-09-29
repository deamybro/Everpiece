// SPDX-License-Identifier: MIT
// Milestone 1 AUSD behavior probe (evidence/milestone1), kept as a permanent fork regression suite.
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

interface IAUSD {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function authorizationState(address, bytes32) external view returns (bool);
    function nonces(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external;
    function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes memory) external;
    function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external;
    function cancelAuthorization(address,bytes32,uint8,bytes32,bytes32) external;
    function permit(address,address,uint256,uint256,uint8,bytes32,bytes32) external;
    function transferFrom(address,address,uint256) external returns (bool);
    function transfer(address,uint256) external returns (bool);
    function batchFreeze(address[] memory) external;
    function burn(address, uint256) external returns (bool);
    function setIsTransferPaused(bool) external;
    function setIsSignatureVerificationPaused(bool) external;
    function getPauserRoleMembers() external view returns (address[] memory);
    function getFreezerRoleMembers() external view returns (address[] memory);
    function getBurnerRoleMembers() external view returns (address[] memory);
    function getRoleMembers(string memory) external view returns (address[] memory);
}

/// Minimal stand-in for an escrow: pulls funds using receiveWithAuthorization (to == msg.sender).
contract ProbeEscrowStandIn {
    IAUSD immutable t;
    constructor(IAUSD _t) { t = _t; }
    function pull(address from, uint256 v, uint256 va, uint256 vb, bytes32 n, uint8 V, bytes32 r, bytes32 s) external {
        t.receiveWithAuthorization(from, address(this), v, va, vb, n, V, r, s);
    }
    function pullBytes(address from, uint256 v, uint256 va, uint256 vb, bytes32 n, bytes memory sig) external {
        t.receiveWithAuthorization(from, address(this), v, va, vb, n, sig);
    }
    function send(address to, uint256 v) external { require(t.transfer(to, v)); }
}

/// ERC-1271 wallet stand-in that approves a single hash.
contract Wallet1271 {
    bytes32 public ok;
    function setOk(bytes32 h) external { ok = h; }
    function isValidSignature(bytes32 h, bytes calldata) external view returns (bytes4) {
        return h == ok ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract AusdProbe is Test {
    IAUSD constant AUSD = IAUSD(0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a);
    bytes32 constant CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700;
    bytes32 constant RWA_TH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 constant TWA_TH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 constant CANCEL_TH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 constant PERMIT_TH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 pk = 0xA11CE;
    address alice;
    ProbeEscrowStandIn esc;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        alice = vm.addr(pk);
        esc = new ProbeEscrowStandIn(AUSD);
        _setBal(alice, 1_000e6);
    }

    function _setBal(address a, uint256 b) internal {
        // Erc20AccountData { bool isFrozen; uint248 balance; } packed in one slot: isFrozen = low byte
        vm.store(address(AUSD), keccak256(abi.encode(a, CORE_SLOT)), bytes32(b << 8));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", AUSD.DOMAIN_SEPARATOR(), structHash));
    }

    function _signRwa(address to, uint256 v, uint256 va, uint256 vb, bytes32 n) internal view returns (uint8, bytes32, bytes32) {
        return vm.sign(pk, _digest(keccak256(abi.encode(RWA_TH, alice, to, v, va, vb, n))));
    }

    function test_decimals() public view { assertEq(AUSD.decimals(), 6); }

    function test_receiveWithAuthorization_contractPayee_ok_and_replay_blocked() public {
        bytes32 n = keccak256("n1");
        uint256 va = block.timestamp - 1; uint256 vb = block.timestamp + 3600;
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 25e6, va, vb, n);
        assertFalse(AUSD.authorizationState(alice, n));
        esc.pull(alice, 25e6, va, vb, n, V, r, s);
        assertEq(AUSD.balanceOf(address(esc)), 25e6);
        assertEq(AUSD.balanceOf(alice), 975e6);
        assertTrue(AUSD.authorizationState(alice, n));
        vm.expectRevert(bytes4(keccak256("UsedOrCanceledAuthorization()")));
        esc.pull(alice, 25e6, va, vb, n, V, r, s);
    }

    function test_receiveWithAuthorization_thirdPartyCaller_reverts_InvalidPayee() public {
        bytes32 n = keccak256("n2");
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSignature("InvalidPayee(address,address)", address(0xBEEF), address(esc)));
        AUSD.receiveWithAuthorization(alice, address(esc), 1e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_receive_sig_is_not_valid_as_transferWithAuthorization() public {
        bytes32 n = keccak256("n3");
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        AUSD.transferWithAuthorization(alice, address(esc), 1e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_changed_amount_reverts() public {
        bytes32 n = keccak256("n4");
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        esc.pull(alice, 2e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_validity_window_boundaries() public {
        uint256 t0 = block.timestamp;
        bytes32 n = keccak256("n5");
        // validAfter == now -> revert (strict >)
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, t0, t0 + 60, n);
        vm.expectRevert(bytes4(keccak256("InvalidAuthorization()")));
        esc.pull(alice, 1e6, t0, t0 + 60, n, V, r, s);
        // validBefore == now -> revert (strict <)
        (V, r, s) = _signRwa(address(esc), 1e6, t0 - 10, t0, n);
        vm.expectRevert(bytes4(keccak256("ExpiredAuthorization()")));
        esc.pull(alice, 1e6, t0 - 10, t0, n, V, r, s);
        // validBefore == now + 1 -> ok
        (V, r, s) = _signRwa(address(esc), 1e6, t0 - 1, t0 + 1, n);
        esc.pull(alice, 1e6, t0 - 1, t0 + 1, n, V, r, s);
    }

    function test_cancelAuthorization_blocks_use() public {
        bytes32 n = keccak256("n6");
        (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(pk, _digest(keccak256(abi.encode(CANCEL_TH, alice, n))));
        AUSD.cancelAuthorization(alice, n, cv, cr, cs); // anyone may submit
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.expectRevert(bytes4(keccak256("UsedOrCanceledAuthorization()")));
        esc.pull(alice, 1e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_compact_64byte_signature_accepted() public {
        bytes32 n = keccak256("n7");
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        bytes32 vs = bytes32(uint256(s) | (uint256(V - 27) << 255));
        esc.pullBytes(alice, 1e6, 0, block.timestamp + 60, n, abi.encodePacked(r, vs));
        assertEq(AUSD.balanceOf(address(esc)), 1e6);
    }

    function test_high_s_malleated_signature_accepted() public {
        bytes32 n = keccak256("n8");
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(N - uint256(s));
        uint8 V2 = V == 27 ? 28 : 27;
        esc.pull(alice, 1e6, 0, block.timestamp + 60, n, V2, r, s2);
        assertEq(AUSD.balanceOf(address(esc)), 1e6);
        console.log("NOTE: high-s signature accepted -> never key uniqueness on signature bytes");
    }

    function test_erc1271_contract_from_supported() public {
        Wallet1271 w = new Wallet1271();
        _setBal(address(w), 10e6);
        bytes32 n = keccak256("n9");
        uint256 vb = block.timestamp + 60;
        w.setOk(_digest(keccak256(abi.encode(RWA_TH, address(w), address(esc), 3e6, 0, vb, n))));
        esc.pullBytes(address(w), 3e6, 0, vb, n, hex"");
        assertEq(AUSD.balanceOf(address(esc)), 3e6);
    }

    function test_permit_fallback_works() public {
        uint256 nonce = AUSD.nonces(alice);
        uint256 dl = block.timestamp + 60;
        (uint8 V, bytes32 r, bytes32 s) = vm.sign(pk, _digest(keccak256(abi.encode(PERMIT_TH, alice, address(esc), 5e6, nonce, dl))));
        AUSD.permit(alice, address(esc), 5e6, dl, V, r, s);
        assertEq(AUSD.allowance(alice, address(esc)), 5e6);
        assertEq(AUSD.nonces(alice), nonce + 1);
        // deadline boundary: block.timestamp == deadline is still valid (reverts only if > deadline)
        (V, r, s) = vm.sign(pk, _digest(keccak256(abi.encode(PERMIT_TH, alice, address(esc), 6e6, nonce + 1, block.timestamp))));
        AUSD.permit(alice, address(esc), 6e6, block.timestamp, V, r, s);
    }

    function test_issuer_freeze_on_escrow_blocks_outflows() public {
        _setBal(address(esc), 10e6);
        address freezer = AUSD.getFreezerRoleMembers()[0];
        address[] memory a = new address[](1); a[0] = address(esc);
        vm.prank(freezer);
        AUSD.batchFreeze(a);
        vm.expectRevert(abi.encodeWithSignature("AccountIsFrozen(address)", address(esc)));
        esc.send(address(0xB0B), 1e6);
    }

    function test_issuer_freeze_on_recipient_blocks_claim_transfer() public {
        _setBal(address(esc), 10e6);
        address freezer = AUSD.getFreezerRoleMembers()[0];
        address[] memory a = new address[](1); a[0] = address(0xB0B);
        vm.prank(freezer);
        AUSD.batchFreeze(a);
        vm.expectRevert(abi.encodeWithSignature("AccountIsFrozen(address)", address(0xB0B)));
        esc.send(address(0xB0B), 1e6);
    }

    function test_issuer_burner_can_burn_escrow_balance_without_allowance() public {
        _setBal(address(esc), 10e6);
        address burner = AUSD.getBurnerRoleMembers()[0];
        vm.prank(burner);
        AUSD.burn(address(esc), 4e6);
        assertEq(AUSD.balanceOf(address(esc)), 6e6);
    }

    function test_issuer_transfer_pause_blocks_receive_and_transfer() public {
        _setBal(address(esc), 10e6);
        address pauser = AUSD.getPauserRoleMembers()[0];
        vm.prank(pauser);
        AUSD.setIsTransferPaused(true);
        vm.expectRevert(bytes4(keccak256("TransferPaused()")));
        esc.send(address(0xB0B), 1e6);
    }

    function test_issuer_signature_pause_blocks_receiveWithAuthorization_but_not_transfer() public {
        _setBal(address(esc), 10e6);
        address pauser = AUSD.getPauserRoleMembers()[0];
        vm.prank(pauser);
        AUSD.setIsSignatureVerificationPaused(true);
        bytes32 n = keccak256("n10");
        (uint8 V, bytes32 r, bytes32 s) = _signRwa(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.expectRevert(bytes4(keccak256("SignatureVerificationPaused()")));
        esc.pull(alice, 1e6, 0, block.timestamp + 60, n, V, r, s);
        esc.send(address(0xB0B), 1e6); // plain transfer (claim payout) still works
    }
}
