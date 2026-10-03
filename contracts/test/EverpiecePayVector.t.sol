// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EverpiecePay} from "../src/EverpiecePay.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";

/// @notice The instant-payment id computed by packages/shared (pay.test.ts VECTOR_PAYMENT_ID) equals the contract's,
///         so a payer's signature made in the app is exactly what EverpiecePay verifies.
contract EverpiecePayVectorTest is Test {
    function test_paymentId_matchesSharedTypeScript() public {
        vm.chainId(10143);
        address[] memory none = new address[](0);
        deployCodeTo("EverpiecePay.sol:EverpiecePay", abi.encode(address(0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC), none), address(0x2222222222222222222222222222222222222222));
        EverpiecePay pay = EverpiecePay(address(0x2222222222222222222222222222222222222222));
        EverpiecePay.Payment memory p = EverpiecePay.Payment({
            ref: bytes32(0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e),
            sender: vm.addr(1),
            recipient: vm.addr(2),
            amount: 25_000_000,
            sourceToken: 0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D,
            maxSourceAmount: 25_000_000_000_000_000_000,
            deadline: 1_790_700_600
        });
        assertEq(pay.paymentIdOf(p), 0x8b97fcbd53e09821270e0d522fb3bde7a8b51204a4a78375c3036f0cc11649d0);
    }
}
