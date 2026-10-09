// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EverpiecePayV2} from "../../src/EverpiecePayV2.sol";
import {IAgoraStableSwapPair} from "../../src/interfaces/IAgoraStableSwapPair.sol";

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice EverpiecePayV2 simulated against CURRENT Monad mainnet state (mandate §43.8), nothing mocked: real USDC,
///         real AUSD, the real Agora AUSD/USDC pair. Direct USDC and AUSD payments need nobody's permission.
///         Conversions need Agora's APPROVED_SWAPPER grant; the fork models that grant by impersonating the pair's
///         WHITELISTER_ROLE holder (docs/VERIFIED.md), which on mainnet only Agora can do.
///         Enable with RUN_FORK_TESTS=true (optional MONAD_RPC).
contract EverpiecePayV2ForkTest is Test {
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant PAIR = 0xf33286E3222D1c829dACeac48c0Ec651F6452470;
    address constant WHITELISTER = 0x4B95a6990ec8B7dE1fAB83dF36f4f63FDE464fFC;
    address constant AAVE_AUSDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    bytes32 constant AUSD_CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700;
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    EverpiecePayV2 pay;
    uint256 constant PK = 0xA11CE;
    address payer;
    address maris = makeAddr("maris");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);
        payer = vm.addr(PK);
        EverpiecePayV2.Asset[] memory assets = new EverpiecePayV2.Asset[](2);
        assets[0] = EverpiecePayV2.Asset({token: USDC, ausdSemantics: false});
        assets[1] = EverpiecePayV2.Asset({token: AUSD, ausdSemantics: true});
        address[] memory pairs = new address[](1);
        pairs[0] = PAIR;
        pay = new EverpiecePayV2(assets, pairs);
        // Fund the payer without touching the pair (its reserve accounting must stay intact): USDC from the Aave V3
        // aUSDC reserve, AUSD by the verified balance-slot write AusdProbe uses (Erc20AccountData, isFrozen low byte).
        vm.prank(AAVE_AUSDC);
        IERC20(USDC).transfer(payer, 500e6);
        vm.store(AUSD, keccak256(abi.encode(payer, AUSD_CORE_SLOT)), bytes32(uint256(500e6) << 8));
        assertEq(IERC20(AUSD).balanceOf(payer), 500e6);
    }

    function _p(address asset, uint256 amount, address source, uint256 maxSource)
        internal
        view
        returns (EverpiecePayV2.Payment memory)
    {
        return EverpiecePayV2.Payment({
            ref: keccak256("mainnet-fork"),
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IDomain(p.sourceToken).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Agora's grant, simulated. Tries the documented role-membership setter shapes; asserts the role took effect.
    function _approveByAgora() internal {
        vm.startPrank(WHITELISTER);
        (bool ok,) = PAIR.call(abi.encodeWithSignature("setApprovedSwapper(address,bool)", address(pay), true));
        if (!ok) (ok,) = PAIR.call(abi.encodeWithSignature("setApprovedSwappers(address[],bool)", _one(address(pay)), true));
        if (!ok) (ok,) = PAIR.call(abi.encodeWithSignature("setRoleMembership(string,address,bool)", "APPROVED_SWAPPER", address(pay), true));
        vm.stopPrank();
        assertTrue(IAgoraStableSwapPair(PAIR).hasRole("APPROVED_SWAPPER", address(pay)), "simulated Agora grant failed");
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function test_direct_usdc_mainnet() public {
        EverpiecePayV2.Payment memory p = _p(USDC, 25e6, USDC, 25e6);
        uint256 g = gasleft();
        pay.pay(p, _sig(p));
        console.log("gas pay direct USDC (warm-ish fork):", g - gasleft());
        assertEq(IERC20(USDC).balanceOf(maris), 25e6);
        assertEq(IERC20(USDC).balanceOf(address(pay)), 0);
    }

    function test_direct_ausd_mainnet() public {
        EverpiecePayV2.Payment memory p = _p(AUSD, 25e6, AUSD, 25e6);
        uint256 g = gasleft();
        pay.pay(p, _sig(p));
        console.log("gas pay direct AUSD:", g - gasleft());
        assertEq(IERC20(AUSD).balanceOf(maris), 25e6);
    }

    function test_conversion_unavailable_without_agora_approval() public {
        (bool ok,, address via) = pay.quote(USDC, AUSD, 10e6);
        assertFalse(ok);
        assertEq(via, PAIR);
        EverpiecePayV2.Payment memory p = _p(AUSD, 10e6, USDC, 10e6);
        bytes memory sig = _sig(p);
        vm.expectRevert();
        pay.pay(p, sig);
        assertEq(IERC20(USDC).balanceOf(payer), 500e6); // nothing moved
    }

    function test_usdc_to_ausd_after_agora_approval() public {
        _approveByAgora();
        (bool ok, uint256 need,) = pay.quote(USDC, AUSD, 100e6);
        assertTrue(ok);
        console.log("USDC needed for 100 AUSD:", need);
        EverpiecePayV2.Payment memory p = _p(AUSD, 100e6, USDC, need + need / 1000);
        uint256 g = gasleft();
        pay.pay(p, _sig(p));
        console.log("gas pay USDC->AUSD:", g - gasleft());
        assertEq(IERC20(AUSD).balanceOf(maris), 100e6);
        assertEq(IERC20(USDC).balanceOf(payer), 500e6 - need);
        assertEq(IERC20(USDC).balanceOf(address(pay)), 0);
    }

    function test_ausd_to_usdc_after_agora_approval() public {
        _approveByAgora();
        (bool ok, uint256 need,) = pay.quote(AUSD, USDC, 100e6);
        assertTrue(ok);
        console.log("AUSD needed for 100 USDC:", need);
        EverpiecePayV2.Payment memory p = _p(USDC, 100e6, AUSD, need);
        pay.pay(p, _sig(p));
        assertEq(IERC20(USDC).balanceOf(maris), 100e6);
        assertEq(IERC20(AUSD).balanceOf(address(pay)), 0);
    }
}
