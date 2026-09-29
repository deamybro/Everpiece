// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface IAUSD {
    function balanceOf(address) external view returns (uint256);
    function isReceiveWithAuthorizationUpgraded() external view returns (bool);
    function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes memory) external;
}

contract Puller {
    function pull(address t, address from, uint256 v, uint256 va, uint256 vb, bytes32 n, bytes memory sig) external {
        IAUSD(t).receiveWithAuthorization(from, address(this), v, va, vb, n, sig);
    }
}

/// Independent Solidity re-derivation of docs/ESCROW_SPEC.md v0.2 §16 vectors (generated with cast in scripts/vectors.sh).
contract Vectors is Test {
    address constant ESCROW = 0x1111111111111111111111111111111111111111;
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    uint256 constant CHAIN = 143;

    bytes32 constant DTH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant PI_TH = keccak256("PaymentIntent(address sender,uint8 mode,bytes32 recipientCommitment,bytes32 metadataCommitment,address approver,uint256 amount,uint256 expiresAt,uint256 validAfter,uint256 validBefore,bytes32 salt)");
    bytes32 constant CI_TH = keccak256("ClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)");
    bytes32 constant LCI_TH = keccak256("LinkClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)");
    bytes32 constant CA_TH = keccak256("ClaimApproval(bytes32 paymentId,address recipient,bytes32 approvalNonce,uint256 deadline)");
    bytes32 constant XI_TH = keccak256("CancelIntent(bytes32 paymentId,address sender,bytes32 actionNonce,uint256 deadline)");
    bytes32 constant RWA_TH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 constant T_RECIP = keccak256("everpiece.recipient.v1");
    bytes32 constant T_META = keccak256("everpiece.metadata.v1");

    uint256 constant AMOUNT = 200000000;
    uint256 constant EXPIRES = 1793232000;
    uint256 constant VALID_BEFORE = 1790726400;
    uint256 constant DEADLINE = 1790812800;

    function ds(string memory ver, uint256 chainId, address vc) internal pure returns (bytes32) {
        return keccak256(abi.encode(DTH, keccak256("Everpiece Escrow"), keccak256(bytes(ver)), chainId, vc));
    }
    function dig(bytes32 d, bytes32 s) internal pure returns (bytes32) { return keccak256(abi.encodePacked("\x19\x01", d, s)); }
    function sigOf(uint256 pk, bytes32 d) internal pure returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d); return abi.encodePacked(r, s, v); }
    function ausdDs() internal pure returns (bytes32) { return keccak256(abi.encode(DTH, keccak256("Agora Dollar"), keccak256("1"), CHAIN, AUSD)); }
    function meta() internal pure returns (bytes32) { return keccak256(abi.encode(T_META, keccak256("everpiece-test-ciphertext-envelope"), bytes32(uint256(0xe7a11)))); }
    function piHash(address sender, uint8 mode, bytes32 rc, address approver, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(PI_TH, sender, mode, rc, meta(), approver, AMOUNT, EXPIRES, uint256(0), VALID_BEFORE, salt));
    }

    function test_constants() public pure {
        assertEq(ds("1", CHAIN, ESCROW), 0xe608be5ba2e4bf6fd034b6ddc6b1fd4528e68bc8fb00dca5a2a5a71d41ab8ef1);
        assertEq(ausdDs(), 0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe);
        assertEq(PI_TH, 0xfe47d1ba0797dff165ffeb9757cb00f65209173109c218ae84dad516ea052126);
        assertEq(CI_TH, 0x0a793245693c7d0b0e7cdef9d078cfa33a1db9e793f6f9e74ae60f8c30f90c56);
        assertEq(LCI_TH, 0x260181d054f3216afe276036306927af04bd2f74dc0dc63a589539f06bc4a39e);
        assertEq(CA_TH, 0xd3e61339735cbf9f76131a9f5b4a49ea6c85e74741f2689fedb433f4f00a3a70);
        assertEq(XI_TH, 0x91d2228050f5adf675ffe5c70058bbe89db877688aa727562c63a00a36d4f557);
        assertEq(meta(), 0x89a8b682af29eb54acbd46d23eb107721daa4a7c56c9388508ce63eb0bef6b71);
    }

    function test_username_vectors() public pure {
        address sender = vm.addr(1); address recip = vm.addr(2);
        bytes32 rc = keccak256(abi.encode(T_RECIP, uint8(1), recip, bytes32(uint256(0x5a170))));
        assertEq(rc, 0x8d13a219c826c93cbdb57e22a207584269b2cb9cbef7dc134a52bb130eab3666);
        bytes32 pi = piHash(sender, 1, rc, address(0), bytes32(uint256(0xa11c)));
        assertEq(pi, 0x8a564f5ab758c8033ecff93053c81ea864c7474687921923be28a558d3a93bf2);
        bytes32 pid = dig(ds("1", CHAIN, ESCROW), pi);
        assertEq(pid, 0x77d1bdd322d8c9e40a2d2d072d1aa2d5d978a5e431ffb534a7b96babe67b49d9);
        bytes32 rwaD = dig(ausdDs(), keccak256(abi.encode(RWA_TH, sender, ESCROW, AMOUNT, uint256(0), VALID_BEFORE, pid)));
        assertEq(rwaD, 0xb8348ee66967a948bdafc876cf0607b929745d0ecbfbf05b3550fecacf1d661d);
        assertEq(sigOf(1, rwaD), hex"966aa3f51f76bcb22c3262a6e7c75d9025716b33df6665cd4e2f82219c001ebd7d3cbb4ee78850f17d9674842c84749d7e7294057de9000a0a3575295b3954d81b");
        bytes32 ciD = dig(ds("1", CHAIN, ESCROW), keccak256(abi.encode(CI_TH, pid, recip, bytes32(uint256(0xc1)), DEADLINE)));
        assertEq(ciD, 0x07737606ac561f641901548b4be636e0e887c219ac7bb401c61adb68ab32758a);
        bytes32 xiD = dig(ds("1", CHAIN, ESCROW), keccak256(abi.encode(XI_TH, pid, sender, bytes32(uint256(0xc2)), DEADLINE)));
        assertEq(xiD, 0x4e72444f81adbe458eccc2add891cb57a6090e8139358e3d2dd5d0b3ba6c0b79);
        assertEq(dig(ds("1", 10143, ESCROW), pi), 0x009198e0e61685de06557de1e5a1e58aaa279db0f11e0dc30bbcf6839f3e0519);
        assertEq(dig(ds("1", CHAIN, 0x2222222222222222222222222222222222222222), pi), 0x828446145824bf5e5c68a916839f00634f1f0a3f119e1de94448c1c7202effaf);
        assertEq(dig(ds("2", CHAIN, ESCROW), pi), 0xcdf128253160f4e6cb62a908f3029e4f3f8912db4f498b21bf75583063a37fb5);
    }

    function test_link_vectors() public pure {
        address sender = vm.addr(1); address recip = vm.addr(2); address approver = vm.addr(3); address ck = vm.addr(4);
        assertEq(ck, 0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718);
        bytes32 rc = keccak256(abi.encode(T_RECIP, uint8(2), ck, bytes32(uint256(0x11c0e))));
        assertEq(rc, 0x26ea19392d1d81ef455fe7887900a6ddbd6d59ad1ff87178dbe14363ab33f46c);
        bytes32 pid = dig(ds("1", CHAIN, ESCROW), piHash(sender, 2, rc, approver, bytes32(uint256(0xb0b0))));
        assertEq(pid, 0x0f42b0913d79c00aea97d6fee27a3d0cdd1a655f30fd4a765c746f60ab9b878b);
        bytes32 lciD = dig(ds("1", CHAIN, ESCROW), keccak256(abi.encode(LCI_TH, pid, recip, bytes32(uint256(0xc1)), DEADLINE)));
        bytes32 caD = dig(ds("1", CHAIN, ESCROW), keccak256(abi.encode(CA_TH, pid, recip, bytes32(uint256(0xa1)), DEADLINE)));
        assertEq(lciD, 0x9079548e888e050ea959986e674977d1cec6701d063c6f3f5b27bc1e39dd15d6);
        assertEq(caD, 0xf155fd12a9b337ca2687bd4eb0a31b743ed9d65d84e320d5790f31d33c53406f);
        assertEq(sigOf(4, lciD), hex"7219a6b670e685585bdc25e96b5dcba7e1b9071f9216f5aa3cf4c44b90c39be957badb1dbce77f306931a6094265d5da387b9d96174fb99366a25f200b58f7fa1c");
        assertEq(sigOf(3, caD), hex"aaff9ed76e29b04b36cd3f2ceed233ed4899334b56d67cf822c58213f046ff1e1d74eae59224745a11bf3bebd83ccfaac850544706970adf20250566daae903b1c");
    }

    /// V_U3 (nonce = paymentId, validAfter = 0) is accepted by LIVE AUSD when the escrow address calls it.
    function test_vector_U3_accepted_by_live_AUSD() public {
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        assertFalse(IAUSD(AUSD).isReceiveWithAuthorizationUpgraded());
        vm.warp(VALID_BEFORE - 3600);
        vm.etch(ESCROW, address(new Puller()).code);
        address sender = vm.addr(1);
        vm.store(AUSD, keccak256(abi.encode(sender, bytes32(0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700))), bytes32(uint256(AMOUNT) << 8));
        Puller(ESCROW).pull(AUSD, sender, AMOUNT, 0, VALID_BEFORE, 0x77d1bdd322d8c9e40a2d2d072d1aa2d5d978a5e431ffb534a7b96babe67b49d9,
            hex"966aa3f51f76bcb22c3262a6e7c75d9025716b33df6665cd4e2f82219c001ebd7d3cbb4ee78850f17d9674842c84749d7e7294057de9000a0a3575295b3954d81b");
        assertEq(IAUSD(AUSD).balanceOf(ESCROW), AMOUNT);
    }

    /// Setting AUSD's "receiveWithAuthorization upgraded" flag bit (1 << 169) is observable — basis for the proposed create guard.
    function test_receive_upgraded_flag_observable() public {
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        uint256 data = uint256(vm.load(AUSD, slot));
        vm.store(AUSD, slot, bytes32(data | (uint256(1) << (255 - 86))));
        assertTrue(IAUSD(AUSD).isReceiveWithAuthorizationUpgraded());
    }
}
