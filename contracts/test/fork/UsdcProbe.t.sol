// SPDX-License-Identifier: MIT
// Monad mainnet USDC behavior probe (mainnet mandate §43.4): can USDC be a direct, first-class payment asset?
// Pins the ERC-3009 receive semantics an escrow/pay contract would rely on, and the one AUSD check USDC lacks.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function version() external view returns (string memory);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
    function paused() external view returns (bool);
    function isBlacklisted(address) external view returns (bool);
    function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external;
    function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes memory) external;
    function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external;
    function transfer(address,uint256) external returns (bool);
}

contract UsdcPullStandIn {
    IUSDC immutable t;
    constructor(IUSDC _t) { t = _t; }
    function pull(address from, uint256 v, uint256 va, uint256 vb, bytes32 n, uint8 V, bytes32 r, bytes32 s) external {
        t.receiveWithAuthorization(from, address(this), v, va, vb, n, V, r, s);
    }
    function pullBytes(address from, uint256 v, uint256 va, uint256 vb, bytes32 n, bytes memory sig) external {
        t.receiveWithAuthorization(from, address(this), v, va, vb, n, sig);
    }
}

contract UsdcProbe is Test {
    // docs/VERIFIED.md (Monad USDC, Circle FiatToken)
    IUSDC constant USDC = IUSDC(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    // Agora AUSD/USDC pair: a holder to fund the test signer from (no storage writes into FiatToken's packed slots).
    address constant USDC_HOLDER = 0xf33286E3222D1c829dACeac48c0Ec651F6452470;
    bytes32 constant RWA_TH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    uint256 pk = 0xA11CE;
    address alice;
    UsdcPullStandIn esc;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        alice = vm.addr(pk);
        esc = new UsdcPullStandIn(USDC);
        vm.prank(USDC_HOLDER);
        require(USDC.transfer(alice, 100e6));
    }

    function _sign(address to, uint256 v, uint256 va, uint256 vb, bytes32 n) internal view returns (uint8, bytes32, bytes32) {
        bytes32 h = keccak256(abi.encode(RWA_TH, alice, to, v, va, vb, n));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), h)));
    }

    function test_basics() public view {
        assertEq(USDC.decimals(), 6);
        assertEq(USDC.version(), "2");
        assertFalse(USDC.paused());
    }

    function test_receiveWithAuthorization_contractPayee_ok_and_replay_blocked() public {
        bytes32 n = keccak256("u1");
        (uint8 V, bytes32 r, bytes32 s) = _sign(address(esc), 25e6, 0, block.timestamp + 3600, n);
        esc.pull(alice, 25e6, 0, block.timestamp + 3600, n, V, r, s);
        assertEq(USDC.balanceOf(address(esc)), 25e6);
        assertEq(USDC.balanceOf(alice), 75e6);
        assertTrue(USDC.authorizationState(alice, n));
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        esc.pull(alice, 25e6, 0, block.timestamp + 3600, n, V, r, s);
    }

    /// The packed r||s||v overload (FiatToken v2.2): the same call shape EverpieceEscrow/Pay use on AUSD.
    function test_bytesSignatureOverload_ok() public {
        bytes32 n = keccak256("u6");
        (uint8 V, bytes32 r, bytes32 s) = _sign(address(esc), 3e6, 0, block.timestamp + 60, n);
        esc.pullBytes(alice, 3e6, 0, block.timestamp + 60, n, abi.encodePacked(r, s, V));
        assertEq(USDC.balanceOf(address(esc)), 3e6);
    }

    /// The front-running defence the escrow relies on: only the payee can redeem a receive authorization.
    function test_thirdPartyCaller_reverts() public {
        bytes32 n = keccak256("u2");
        (uint8 V, bytes32 r, bytes32 s) = _sign(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.prank(address(0xBEEF));
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        USDC.receiveWithAuthorization(alice, address(esc), 1e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_receive_sig_not_valid_as_transferWithAuthorization() public {
        bytes32 n = keccak256("u3");
        (uint8 V, bytes32 r, bytes32 s) = _sign(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(alice, address(esc), 1e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_changed_amount_reverts() public {
        bytes32 n = keccak256("u4");
        (uint8 V, bytes32 r, bytes32 s) = _sign(address(esc), 1e6, 0, block.timestamp + 60, n);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        esc.pull(alice, 2e6, 0, block.timestamp + 60, n, V, r, s);
    }

    function test_expired_reverts() public {
        bytes32 n = keccak256("u5");
        uint256 vb = block.timestamp + 60;
        (uint8 V, bytes32 r, bytes32 s) = _sign(address(esc), 1e6, 0, vb, n);
        vm.warp(vb + 1);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        esc.pull(alice, 1e6, 0, vb, n, V, r, s);
    }

    /// USDC has no AUSD-style `isReceiveWithAuthorizationUpgraded()`: the escrow/pay/earn guard reverts on it,
    /// which is why the current contracts cannot accept USDC as-is.
    function test_noAusdUpgradeFlag() public {
        (bool ok,) = address(USDC).call(abi.encodeWithSignature("isReceiveWithAuthorizationUpgraded()"));
        assertFalse(ok);
    }

    function test_blacklist_view_exists() public view {
        assertFalse(USDC.isBlacklisted(alice));
    }
}
