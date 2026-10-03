// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EverpiecePay} from "../../src/EverpiecePay.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";
import {IAgoraStableSwapPair, IAgoraTestnetWhitelister} from "../../src/interfaces/IAgoraStableSwapPair.sol";

interface IAgoraFaucet {
    function requestFunds(address to) external;
}

/// @notice EverpiecePay and EverpieceEscrow against the REAL Monad testnet contracts (docs/INTEGRATION_VERIFICATION.md):
///         Agora AUSD, the CTK/AUSD Instant Settlement pair, the public testnet Whitelister and the AUSD faucet.
///         Nothing is mocked: test AUSD comes from Agora's faucet and test CTK from a real AUSD → CTK swap on the pair.
///         Enable with RUN_FORK_TESTS=true (optional MONAD_TESTNET_RPC).
contract EverpiecePayForkTest is Test {
    address constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address constant CTK = 0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D;
    address constant PAIR = 0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae;
    address constant WHITELISTER = 0x7c10F56d6f04a51376393a1C3670e966863F6BD5;
    address constant FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    EverpiecePay pay;
    uint256 constant PAYER_PK = 0xA11CE;
    address payer;
    address maris = makeAddr("maris");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        assertEq(block.chainid, 10143);
        payer = vm.addr(PAYER_PK);
        address[] memory pairs = new address[](1);
        pairs[0] = PAIR;
        pay = new EverpiecePay(IAUSD(AUSD), pairs);
        // the public testnet self-whitelisting flow, for our contract
        IAgoraTestnetWhitelister(WHITELISTER).setApprovedSwapper(address(pay));
        assertTrue(IAgoraStableSwapPair(PAIR).hasRole("APPROVED_SWAPPER", address(pay)));

        // test AUSD from Agora's faucet; test CTK by swapping some of it on the real pair
        IAgoraFaucet(FAUCET).requestFunds(payer);
        assertEq(IERC20(AUSD).balanceOf(payer), 10_000e6);
        vm.startPrank(payer);
        IAgoraTestnetWhitelister(WHITELISTER).setApprovedSwapper(payer);
        IERC20(AUSD).approve(PAIR, type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = AUSD;
        path[1] = CTK;
        IAgoraStableSwapPair(PAIR).swapTokensForExactTokens(500 ether, 600e6, path, payer, block.timestamp + 300);
        IERC20(AUSD).approve(PAIR, 0);
        vm.stopPrank();
        assertEq(IERC20(CTK).balanceOf(payer), 500 ether);
    }

    function _payment(address source, uint256 amount, uint256 maxSource) internal view returns (EverpiecePay.Payment memory) {
        return EverpiecePay.Payment({
            ref: keccak256("fork"),
            sender: payer,
            recipient: maris,
            amount: amount,
            sourceToken: source,
            maxSourceAmount: maxSource,
            deadline: block.timestamp + 10 minutes
        });
    }

    function _sign(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_payWithCtk_marisReceivesExactly25Ausd() public {
        uint256 quoted = pay.quote(CTK, 25e6);
        EverpiecePay.Payment memory p = _payment(CTK, 25e6, quoted);
        bytes32 permitDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(CTK).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, payer, address(pay), quoted, IERC20Permit(CTK).nonces(payer), p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, permitDigest);
        uint256 ctkBefore = IERC20(CTK).balanceOf(payer);
        pay.payWithToken(p, _sign(pay.paymentIdOf(p)), p.deadline, v, r, s);
        assertEq(IERC20(AUSD).balanceOf(maris), 25e6, "exactly 25.000000 AUSD");
        assertEq(ctkBefore - IERC20(CTK).balanceOf(payer), quoted, "charged the quote");
        assertEq(IERC20(CTK).balanceOf(address(pay)), 0);
    }

    function test_fork_payWithAusd_direct() public {
        EverpiecePay.Payment memory p = _payment(AUSD, 10e6, 10e6);
        bytes32 id = pay.paymentIdOf(p);
        bytes32 d = keccak256(
            abi.encodePacked(
                "\x19\x01", IERC20Permit(AUSD).DOMAIN_SEPARATOR(), keccak256(abi.encode(RWA_TYPEHASH, payer, address(pay), 10e6, 0, p.deadline, id))
            )
        );
        pay.payWithAusd(p, _sign(d));
        assertEq(IERC20(AUSD).balanceOf(maris), 10e6);
    }

    /// The unchanged escrow runs on real testnet AUSD: the reason TestDollar can be retired.
    function test_fork_escrowOnRealTestnetAusd_createAndCancel() public {
        EverpieceEscrow escrow = new EverpieceEscrow(IAUSD(AUSD), address(this), makeAddr("approver"));
        IEverpieceEscrow.PaymentIntent memory i = IEverpieceEscrow.PaymentIntent({
            sender: payer,
            mode: 1,
            recipientCommitment: escrow.recipientCommitmentOf(1, maris, bytes32("r")),
            metadataCommitment: bytes32(0),
            approver: address(0),
            amount: 5e6,
            expiresAt: block.timestamp + 30 days,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            salt: bytes32("s")
        });
        bytes32 pid = escrow.paymentIdOf(i);
        bytes32 d = keccak256(
            abi.encodePacked(
                "\x19\x01", IERC20Permit(AUSD).DOMAIN_SEPARATOR(), keccak256(abi.encode(RWA_TYPEHASH, payer, address(escrow), 5e6, 0, i.validBefore, pid))
            )
        );
        uint256 before = IERC20(AUSD).balanceOf(payer);
        escrow.createPayment(i, _sign(d));
        assertEq(IERC20(AUSD).balanceOf(address(escrow)), 5e6);
        uint256 dl = block.timestamp + 10 minutes;
        escrow.cancel(pid, bytes32("c"), dl, _sign(escrow.hashCancelIntent(pid, payer, bytes32("c"), dl)));
        assertEq(IERC20(AUSD).balanceOf(payer), before);
    }
}
