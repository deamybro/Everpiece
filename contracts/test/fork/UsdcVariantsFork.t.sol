// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EverpieceEscrowUsdc, EverpieceEarnUsdc} from "../../src/EverpieceUsdc.sol";
import {EverpieceEarn} from "../../src/EverpieceEarn.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";

/// @notice The USDC variants of the escrow and Earn on CURRENT Monad mainnet state (mandate §43.6/§43.8): real USDC,
///         real Aave V3 static-aToken USDC vault. Enable with RUN_FORK_TESTS=true (optional MONAD_RPC).
contract UsdcVariantsForkTest is Test {
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AAVE_AUSDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042; // aToken: holds USDC reserve
    address constant WA_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2; // Aave address book USDC_STATA_TOKEN
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 constant SENDER_PK = 0x5E4D;
    uint256 constant RECIPIENT_PK = 0x4EC1;
    address sender;
    address recipient;
    address approver = makeAddr("approver");
    address owner = makeAddr("owner");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);
        sender = vm.addr(SENDER_PK);
        recipient = vm.addr(RECIPIENT_PK);
        vm.prank(AAVE_AUSDC);
        IERC20(USDC).transfer(sender, 1_000e6);
    }

    function _rwa(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(USDC).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RWA_TYPEHASH, sender, to, value, validAfter, validBefore, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SENDER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _escrowCreate(EverpieceEscrowUsdc escrow, bytes32 salt) internal returns (bytes32 id, IEverpieceEscrow.PaymentIntent memory i) {
        i = IEverpieceEscrow.PaymentIntent(
            sender,
            1, // USERNAME
            escrow.recipientCommitmentOf(1, recipient, bytes32(uint256(0x5a17))),
            keccak256("meta"),
            address(0),
            200e6,
            block.timestamp + 29 days,
            0,
            block.timestamp + 1 hours,
            salt
        );
        id = escrow.paymentIdOf(i);
        escrow.createPayment(i, _rwa(address(escrow), i.amount, 0, i.validBefore, id));
    }

    function test_escrowUsdc_create_claim() public {
        EverpieceEscrowUsdc escrow = new EverpieceEscrowUsdc(USDC, owner, approver);
        assertEq(address(escrow.AUSD()), USDC);
        uint256 g = gasleft();
        (bytes32 id,) = _escrowCreate(escrow, bytes32(uint256(1)));
        console2.log("gas escrowUsdc.createPayment:", g - gasleft());
        assertEq(IERC20(USDC).balanceOf(address(escrow)), 200e6);
        assertEq(escrow.totalActiveLiability(), 200e6);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 nonce = bytes32(uint256(0xc1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RECIPIENT_PK, escrow.hashClaimIntent(id, recipient, nonce, deadline));
        escrow.claimUsernamePayment(id, recipient, bytes32(uint256(0x5a17)), nonce, deadline, abi.encodePacked(r, s, v));
        assertEq(IERC20(USDC).balanceOf(recipient), 200e6);
        assertEq(IERC20(USDC).balanceOf(address(escrow)), 0);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_escrowUsdc_refundExpired() public {
        EverpieceEscrowUsdc escrow = new EverpieceEscrowUsdc(USDC, owner, approver);
        (bytes32 id, IEverpieceEscrow.PaymentIntent memory i) = _escrowCreate(escrow, bytes32(uint256(2)));
        vm.warp(i.expiresAt);
        vm.prank(makeAddr("keeper"));
        escrow.refundExpired(id);
        assertEq(IERC20(USDC).balanceOf(sender), 1_000e6);
    }

    function test_escrowUsdc_tamperedAmount_rejectedByRealUsdc() public {
        EverpieceEscrowUsdc escrow = new EverpieceEscrowUsdc(USDC, owner, approver);
        IEverpieceEscrow.PaymentIntent memory i = IEverpieceEscrow.PaymentIntent(
            sender, 1, escrow.recipientCommitmentOf(1, recipient, bytes32(uint256(7))), keccak256("meta"), address(0),
            100e6, block.timestamp + 29 days, 0, block.timestamp + 1 hours, bytes32(uint256(3))
        );
        bytes memory sig = _rwa(address(escrow), i.amount, 0, i.validBefore, escrow.paymentIdOf(i));
        i.amount = 101e6;
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        escrow.createPayment(i, sig);
    }

    function test_earnUsdc_realAave_deposit_accrue() public {
        assertEq(IERC4626(WA_USDC).asset(), USDC);
        address[] memory vs = new address[](1);
        vs[0] = WA_USDC;
        EverpieceEarnUsdc earn = new EverpieceEarnUsdc(USDC, vs);
        EverpieceEarn.Deposit memory d = EverpieceEarn.Deposit(
            bytes32("leg"), sender, WA_USDC, 100e6, IERC4626(WA_USDC).previewDeposit(100e6), block.timestamp + 600
        );
        bytes32 id = earn.depositIdOf(d);
        uint256 g = gasleft();
        (, uint256 shares) = earn.deposit(d, _rwa(address(earn), 100e6, 0, d.deadline, id));
        console2.log("gas earnUsdc.deposit:", g - gasleft());
        assertEq(IERC20(WA_USDC).balanceOf(sender), shares);
        assertEq(IERC20(USDC).balanceOf(address(earn)), 0);
        assertEq(earn.principalOf(sender, WA_USDC), 100e6);
        uint256 v0 = IERC4626(WA_USDC).convertToAssets(shares);
        vm.warp(block.timestamp + 30 days);
        uint256 v1 = IERC4626(WA_USDC).convertToAssets(shares);
        assertGt(v1, v0);
        console2.log("30-day USDC yield on $100 (base units):", v1 - v0);
    }
}
