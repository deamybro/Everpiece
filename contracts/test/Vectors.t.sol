// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBase} from "./utils/EscrowBase.t.sol";
import {IEverpieceEscrow} from "../src/interfaces/IEverpieceEscrow.sol";

/// @notice docs/ESCROW_SPEC.md §18 vectors reproduced by the REAL contract (T90) and replayed end-to-end with the
///         exact published signatures (T91, mock AUSD at the real address with the real "Agora Dollar" domain).
contract VectorsTest is EscrowBase {
    uint256 constant AMOUNT = 200000000;
    uint256 constant EXPIRES = 1793232000;
    uint256 constant VALID_BEFORE = 1790726400;
    uint256 constant DEADLINE = 1790812800;
    bytes32 constant META = 0x89a8b682af29eb54acbd46d23eb107721daa4a7c56c9388508ce63eb0bef6b71;
    bytes32 constant RSALT_U = bytes32(uint256(0x5a170));
    bytes32 constant RSALT_L = bytes32(uint256(0x11c0e));
    bytes32 constant N_CLAIM = bytes32(uint256(0xc1));
    bytes32 constant N_CANCEL = bytes32(uint256(0xc2));
    bytes32 constant N_APPROVAL = bytes32(uint256(0xa1));

    bytes32 constant PID_U = 0x77d1bdd322d8c9e40a2d2d072d1aa2d5d978a5e431ffb534a7b96babe67b49d9;
    bytes32 constant PID_L = 0x0f42b0913d79c00aea97d6fee27a3d0cdd1a655f30fd4a765c746f60ab9b878b;

    bytes constant SIG_U3 = hex"966aa3f51f76bcb22c3262a6e7c75d9025716b33df6665cd4e2f82219c001ebd7d3cbb4ee78850f17d9674842c84749d7e7294057de9000a0a3575295b3954d81b";
    bytes constant SIG_U4 = hex"87b7136fed8919a13ee013929961c8fbad0fe29c9e9e0fc2eca61da7baf9f4cc27c8457a98638ecab7618088de62375a3cfeea1d78790679605c08068b7df5c91b";
    bytes constant SIG_U5 = hex"8d6732884815ad2e47d9848b8f471f91103ea27cae789b86a8d54423df6a1a014b32fc38eac8d359892af6b64f32b6c126a371750cc38c7c1f7e79f8a74a38661c";
    bytes constant SIG_U6 = hex"0ea398666bd0fdc411afbf5f10e24eb009d3937801d851539b668e554d56877b25a44552dc1175e2a7361c50b56380a7d981e4bdac53e317f5ee18e4b3b9b3461b";
    bytes constant SIG_L3 = hex"ad1189451460b27c072393e7948d6fcecaf843cec92ff9dfaf41c00c1921d88c33701eb1471e5fe24d176c8a0a0db5fb5b58d9ea160c86bda92e3e6706d1e6ee1b";
    bytes constant SIG_L4 = hex"7219a6b670e685585bdc25e96b5dcba7e1b9071f9216f5aa3cf4c44b90c39be957badb1dbce77f306931a6094265d5da387b9d96174fb99366a25f200b58f7fa1c";
    bytes constant SIG_L5 = hex"aaff9ed76e29b04b36cd3f2ceed233ed4899334b56d67cf822c58213f046ff1e1d74eae59224745a11bf3bebd83ccfaac850544706970adf20250566daae903b1c";

    function _vU() internal view returns (IEverpieceEscrow.PaymentIntent memory) {
        return IEverpieceEscrow.PaymentIntent({
            sender: sender,
            mode: USERNAME,
            recipientCommitment: 0x8d13a219c826c93cbdb57e22a207584269b2cb9cbef7dc134a52bb130eab3666,
            metadataCommitment: META,
            approver: address(0),
            amount: AMOUNT,
            expiresAt: EXPIRES,
            validAfter: 0,
            validBefore: VALID_BEFORE,
            salt: bytes32(uint256(0xa11c))
        });
    }

    function _vL() internal view returns (IEverpieceEscrow.PaymentIntent memory) {
        return IEverpieceEscrow.PaymentIntent({
            sender: sender,
            mode: LINK,
            recipientCommitment: 0x26ea19392d1d81ef455fe7887900a6ddbd6d59ad1ff87178dbe14363ab33f46c,
            metadataCommitment: META,
            approver: approver,
            amount: AMOUNT,
            expiresAt: EXPIRES,
            validAfter: 0,
            validBefore: VALID_BEFORE,
            salt: bytes32(uint256(0xb0b0))
        });
    }

    // ------------------------------------------------------------------ T90 contract views reproduce vectors

    function test_T90_fixtureAddresses() public view {
        assertEq(sender, 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf);
        assertEq(recipient, 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF);
        assertEq(approver, 0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69);
        assertEq(claimKey, 0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718);
        assertEq(approver2, 0xe1AB8145F7E55DC933d51a18c793F901A3A0b276);
        assertEq(ausd.DOMAIN_SEPARATOR(), 0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe);
    }

    function test_T90_metadataCommitment() public pure {
        bytes32 m = keccak256(
            abi.encode(keccak256("everpiece.metadata.v1"), keccak256("everpiece-test-ciphertext-envelope"), bytes32(uint256(0xe7a11)))
        );
        assertEq(m, META);
    }

    function test_T90_usernameVectors() public view {
        assertEq(escrow.recipientCommitmentOf(USERNAME, recipient, RSALT_U), _vU().recipientCommitment); // V_U1
        assertEq(escrow.paymentIdOf(_vU()), PID_U); // V_U2
        assertEq(escrow.hashClaimIntent(PID_U, recipient, N_CLAIM, DEADLINE), 0x07737606ac561f641901548b4be636e0e887c219ac7bb401c61adb68ab32758a); // V_U4
        assertEq(escrow.hashClaimIntent(PID_U, sender, N_CLAIM, DEADLINE), 0x2f09c192f041e3a18213e2cac306851d11782b48dcd68f0348fc6a2f7f86cc4b); // V_U5
        assertEq(escrow.hashCancelIntent(PID_U, sender, N_CANCEL, DEADLINE), 0x4e72444f81adbe458eccc2add891cb57a6090e8139358e3d2dd5d0b3ba6c0b79); // V_U6
        bytes32 ausdDigest = _ausdDigest(RWA_TYPEHASH, sender, address(escrow), AMOUNT, 0, VALID_BEFORE, PID_U);
        assertEq(ausdDigest, 0xb8348ee66967a948bdafc876cf0607b929745d0ecbfbf05b3550fecacf1d661d); // V_U3
    }

    function test_T90_negativeVectors() public view {
        IEverpieceEscrow.PaymentIntent memory i = _vU();
        i.amount = 200000001;
        assertEq(escrow.paymentIdOf(i), 0x6c29c7e2db086d5b35b3518737c4598fecb9fe90dc0943b672b70e35c5e18787); // V_N1
        i = _vU();
        i.expiresAt += 1;
        assertEq(escrow.paymentIdOf(i), 0x46341c5bc36b5ac813b823f978f3dfb75d076f6b695be55bb7ad87624c98c63b); // V_N2
        i = _vU();
        i.recipientCommitment = escrow.recipientCommitmentOf(USERNAME, 0x000000000000000000000000000000000000E7E0, RSALT_U);
        assertEq(escrow.paymentIdOf(i), 0x919e3c86c42a2dba9ac4e6e3cdf18fe7fffdd0f1f0caee4b5c0c666021cc0264); // V_N3
        i = _vU();
        i.metadataCommitment = bytes32(0);
        assertEq(escrow.paymentIdOf(i), 0x9519f9cc0ffe29ca99ba6608cae935a82fc1208e7429748f6209000febada2b7); // V_N4
        i = _vU();
        i.mode = LINK;
        assertEq(escrow.paymentIdOf(i), 0xfd3bfa3e4377949db71c50e46e253b24fb2bf469dbcbbd208aedffd6e2821f43); // V_N5
        i = _vU();
        i.salt = bytes32(uint256(0xa11d));
        assertEq(escrow.paymentIdOf(i), 0x142a610a7e8e354a524e48c409c4d0aa3cb35f76c1598cada7e844c9aaa58ef2); // V_N6
        i = _vU();
        i.approver = approver;
        assertEq(escrow.paymentIdOf(i), 0x275e52ff52b6fcd9aa48a71feaf4faa41534ee8b63382c34d7254c62ddccb155); // V_N7
    }

    function test_T90_crossChainVector() public {
        vm.chainId(10143);
        assertEq(escrow.paymentIdOf(_vU()), 0x009198e0e61685de06557de1e5a1e58aaa279db0f11e0dc30bbcf6839f3e0519); // V_N8
    }

    function test_T90_linkVectors() public view {
        assertEq(escrow.recipientCommitmentOf(LINK, claimKey, RSALT_L), _vL().recipientCommitment); // V_L1
        assertEq(escrow.paymentIdOf(_vL()), PID_L); // V_L2
        assertEq(_ausdDigest(RWA_TYPEHASH, sender, address(escrow), AMOUNT, 0, VALID_BEFORE, PID_L), 0xdee64e5754ec9dc3fd64c8482184a3259010a844996a38409409485eb6bf30da); // V_L3
        assertEq(escrow.hashLinkClaimIntent(PID_L, recipient, N_CLAIM, DEADLINE), 0x9079548e888e050ea959986e674977d1cec6701d063c6f3f5b27bc1e39dd15d6); // V_L4
        assertEq(escrow.hashClaimApproval(PID_L, recipient, N_APPROVAL, DEADLINE), 0xf155fd12a9b337ca2687bd4eb0a31b743ed9d65d84e320d5790f31d33c53406f); // V_L5
        assertEq(escrow.hashClaimApproval(PID_L, address(0x57e), N_APPROVAL, DEADLINE), 0xcb1ff58e34b4a70af55c3ac4e7f1c87e0646cb129882e0750962a3065c855ca2); // V_L7
    }

    // ------------------------------------------------------------------ T91 published signatures, end to end

    function test_T91_username_createAndClaim_withPublishedSigs() public {
        bytes32 id = escrow.createPayment(_vU(), SIG_U3);
        assertEq(id, PID_U);
        escrow.claimUsernamePayment(PID_U, recipient, RSALT_U, N_CLAIM, DEADLINE, SIG_U4);
        assertEq(ausd.balanceOf(recipient), AMOUNT);
    }

    function test_T91_username_V_U5_senderClaimRejected() public {
        escrow.createPayment(_vU(), SIG_U3);
        vm.expectRevert(IEverpieceEscrow.RecipientMismatch.selector);
        escrow.claimUsernamePayment(PID_U, sender, RSALT_U, N_CLAIM, DEADLINE, SIG_U5);
    }

    function test_T91_username_createAndCancel_withPublishedSigs() public {
        escrow.createPayment(_vU(), SIG_U3);
        escrow.cancel(PID_U, N_CANCEL, DEADLINE, SIG_U6);
        assertEq(ausd.balanceOf(sender), 10_000 * DOLLAR);
    }

    function test_T91_negative_V_N1_tamperedAmountRejected() public {
        IEverpieceEscrow.PaymentIntent memory i = _vU();
        i.amount = 200000001;
        vm.expectRevert();
        escrow.createPayment(i, SIG_U3);
    }

    function test_T91_link_createAndClaim_withPublishedSigs() public {
        bytes32 id = escrow.createPayment(_vL(), SIG_L3);
        assertEq(id, PID_L);
        escrow.claimLinkPayment(PID_L, recipient, claimKey, RSALT_L, N_CLAIM, DEADLINE, SIG_L4, N_APPROVAL, DEADLINE, SIG_L5);
        assertEq(ausd.balanceOf(recipient), AMOUNT);
    }

    function test_T91_link_V_L7_redirectToStellaRejected() public {
        escrow.createPayment(_vL(), SIG_L3);
        vm.expectRevert(IEverpieceEscrow.InvalidClaimKeySignature.selector);
        escrow.claimLinkPayment(PID_L, address(0x57e), claimKey, RSALT_L, N_CLAIM, DEADLINE, SIG_L4, N_APPROVAL, DEADLINE, SIG_L5);
    }

    function test_T91_link_V_L8_rotatedApproverRejected() public {
        escrow.createPayment(_vL(), SIG_L3);
        vm.prank(owner);
        escrow.setClaimApprover(approver2);
        bytes memory sig2 = _sig(APPROVER2_PK, 0xf155fd12a9b337ca2687bd4eb0a31b743ed9d65d84e320d5790f31d33c53406f);
        vm.expectRevert(IEverpieceEscrow.InvalidApproverSignature.selector);
        escrow.claimLinkPayment(PID_L, recipient, claimKey, RSALT_L, N_CLAIM, DEADLINE, SIG_L4, N_APPROVAL, DEADLINE, sig2);
        // the snapshotted approver's published signature still works after rotation
        escrow.claimLinkPayment(PID_L, recipient, claimKey, RSALT_L, N_CLAIM, DEADLINE, SIG_L4, N_APPROVAL, DEADLINE, SIG_L5);
    }
}
