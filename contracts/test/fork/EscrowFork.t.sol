// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";

interface IAUSDAdmin {
    function getFreezerRoleMembers() external view returns (address[] memory);
    function getBurnerRoleMembers() external view returns (address[] memory);
    function batchFreeze(address[] memory) external;
    function batchUnfreeze(address[] memory) external;
    function burn(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice EverpieceEscrow against the REAL Monad mainnet AUSD (fork, Foundry `network = "monad"`).
///         Replays the published ESCROW_SPEC §18 signatures end to end (T74/T91) and the issuer-control
///         scenarios (T80–T83) on live AUSD code. Enable with RUN_FORK_TESTS=true (optional MONAD_RPC).
contract EscrowForkTest is Test {
    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address constant ESCROW = 0x1111111111111111111111111111111111111111;
    bytes32 constant CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700;
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 constant T0 = 1790700000;

    uint256 constant AMOUNT = 200000000;
    uint256 constant EXPIRES = 1793232000;
    uint256 constant VALID_BEFORE = 1790726400;
    uint256 constant DEADLINE = 1790812800;
    bytes32 constant META = 0x89a8b682af29eb54acbd46d23eb107721daa4a7c56c9388508ce63eb0bef6b71;
    bytes32 constant PID_U = 0x77d1bdd322d8c9e40a2d2d072d1aa2d5d978a5e431ffb534a7b96babe67b49d9;
    bytes32 constant PID_L = 0x0f42b0913d79c00aea97d6fee27a3d0cdd1a655f30fd4a765c746f60ab9b878b;
    bytes constant SIG_U3 = hex"966aa3f51f76bcb22c3262a6e7c75d9025716b33df6665cd4e2f82219c001ebd7d3cbb4ee78850f17d9674842c84749d7e7294057de9000a0a3575295b3954d81b";
    bytes constant SIG_U4 = hex"87b7136fed8919a13ee013929961c8fbad0fe29c9e9e0fc2eca61da7baf9f4cc27c8457a98638ecab7618088de62375a3cfeea1d78790679605c08068b7df5c91b";
    bytes constant SIG_U6 = hex"0ea398666bd0fdc411afbf5f10e24eb009d3937801d851539b668e554d56877b25a44552dc1175e2a7361c50b56380a7d981e4bdac53e317f5ee18e4b3b9b3461b";
    bytes constant SIG_L3 = hex"ad1189451460b27c072393e7948d6fcecaf843cec92ff9dfaf41c00c1921d88c33701eb1471e5fe24d176c8a0a0db5fb5b58d9ea160c86bda92e3e6706d1e6ee1b";
    bytes constant SIG_L4 = hex"7219a6b670e685585bdc25e96b5dcba7e1b9071f9216f5aa3cf4c44b90c39be957badb1dbce77f306931a6094265d5da387b9d96174fb99366a25f200b58f7fa1c";
    bytes constant SIG_L5 = hex"aaff9ed76e29b04b36cd3f2ceed233ed4899334b56d67cf822c58213f046ff1e1d74eae59224745a11bf3bebd83ccfaac850544706970adf20250566daae903b1c";

    EverpieceEscrow escrow;
    IAUSD ausd = IAUSD(AUSD);
    address sender = vm.addr(1);
    address recipient = vm.addr(2);
    address approver = vm.addr(3);
    address claimKey = vm.addr(4);
    address owner = makeAddr("owner");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);
        assertEq(IAUSDAdmin(AUSD).decimals(), 6);
        assertEq(IAUSDAdmin(AUSD).DOMAIN_SEPARATOR(), 0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe);
        assertFalse(ausd.isReceiveWithAuthorizationUpgraded());
        vm.warp(T0);
        deployCodeTo("EverpieceEscrow.sol:EverpieceEscrow", abi.encode(AUSD, owner, approver), ESCROW);
        escrow = EverpieceEscrow(ESCROW);
        _setBalance(sender, 1_000e6);
    }

    /// Erc20AccountData { bool isFrozen; uint248 balance } packed in one slot (VERIFIED §2.12 probe).
    function _setBalance(address a, uint256 b) internal {
        vm.store(AUSD, keccak256(abi.encode(a, CORE_SLOT)), bytes32(b << 8));
    }

    function _vU() internal view returns (IEverpieceEscrow.PaymentIntent memory) {
        return IEverpieceEscrow.PaymentIntent(
            sender, 1, 0x8d13a219c826c93cbdb57e22a207584269b2cb9cbef7dc134a52bb130eab3666, META, address(0), AMOUNT,
            EXPIRES, 0, VALID_BEFORE, bytes32(uint256(0xa11c))
        );
    }

    function _vL() internal view returns (IEverpieceEscrow.PaymentIntent memory) {
        return IEverpieceEscrow.PaymentIntent(
            sender, 2, 0x26ea19392d1d81ef455fe7887900a6ddbd6d59ad1ff87178dbe14363ab33f46c, META, approver, AMOUNT,
            EXPIRES, 0, VALID_BEFORE, bytes32(uint256(0xb0b0))
        );
    }

    function _freeze(address a, bool on) internal {
        address freezer = IAUSDAdmin(AUSD).getFreezerRoleMembers()[0];
        address[] memory list = new address[](1);
        list[0] = a;
        vm.prank(freezer);
        if (on) IAUSDAdmin(AUSD).batchFreeze(list);
        else IAUSDAdmin(AUSD).batchUnfreeze(list);
    }

    // ------------------------------------------------------------------ T74 / T91 on real AUSD

    function test_fork_username_createClaim_publishedVectors() public {
        bytes32 id = escrow.createPayment(_vU(), SIG_U3);
        assertEq(id, PID_U);
        assertTrue(IAUSDAdmin(AUSD).authorizationState(sender, PID_U));
        assertEq(ausd.balanceOf(ESCROW), AMOUNT);
        escrow.claimUsernamePayment(PID_U, recipient, bytes32(uint256(0x5a170)), bytes32(uint256(0xc1)), DEADLINE, SIG_U4);
        assertEq(ausd.balanceOf(recipient), AMOUNT);
        assertEq(ausd.balanceOf(ESCROW), 0);
        assertEq(escrow.totalActiveLiability(), 0);
    }

    function test_fork_username_createCancel_publishedVectors() public {
        escrow.createPayment(_vU(), SIG_U3);
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
        assertEq(ausd.balanceOf(sender), 1_000e6);
    }

    function test_fork_link_createClaim_publishedVectors() public {
        escrow.createPayment(_vL(), SIG_L3);
        escrow.claimLinkPayment(
            PID_L, recipient, claimKey, bytes32(uint256(0x11c0e)), bytes32(uint256(0xc1)), DEADLINE, SIG_L4,
            bytes32(uint256(0xa1)), DEADLINE, SIG_L5
        );
        assertEq(ausd.balanceOf(recipient), AMOUNT);
    }

    function test_fork_refundExpired() public {
        escrow.createPayment(_vU(), SIG_U3);
        vm.warp(EXPIRES);
        vm.prank(makeAddr("keeper"));
        escrow.refundExpired(PID_U);
        assertEq(ausd.balanceOf(sender), 1_000e6);
    }

    function test_fork_tamperedAmount_rejectedByRealAusd() public {
        IEverpieceEscrow.PaymentIntent memory i = _vU();
        i.amount = AMOUNT + 1;
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        escrow.createPayment(i, SIG_U3);
    }

    function test_fork_thirdPartyCannotConsumeAuthorizationDirectly() public {
        vm.prank(makeAddr("griefer"));
        vm.expectRevert();
        IAUSDFull(AUSD).receiveWithAuthorization(sender, ESCROW, AMOUNT, 0, VALID_BEFORE, PID_U, SIG_U3);
        escrow.createPayment(_vU(), SIG_U3); // still usable by the escrow
    }

    // ------------------------------------------------------------------ gas profile (execution gas, Monad rules)

    /// Execution gas of each money action against real AUSD. Excludes intrinsic 21,000 + calldata; the relayer's
    /// explicit gas limit must cover execution + intrinsic + calldata (Monad charges the full limit, VERIFIED §1.5).
    function test_fork_gasProfile() public {
        uint256 g = gasleft();
        escrow.createPayment(_vU(), SIG_U3);
        emit log_named_uint("gas.createPayment(username)", g - gasleft());
        g = gasleft();
        escrow.claimUsernamePayment(PID_U, recipient, bytes32(uint256(0x5a170)), bytes32(uint256(0xc1)), DEADLINE, SIG_U4);
        emit log_named_uint("gas.claimUsernamePayment", g - gasleft());

        g = gasleft();
        escrow.createPayment(_vL(), SIG_L3);
        emit log_named_uint("gas.createPayment(link)", g - gasleft());
        g = gasleft();
        escrow.claimLinkPayment(
            PID_L, recipient, claimKey, bytes32(uint256(0x11c0e)), bytes32(uint256(0xc1)), DEADLINE, SIG_L4,
            bytes32(uint256(0xa1)), DEADLINE, SIG_L5
        );
        emit log_named_uint("gas.claimLinkPayment", g - gasleft());
    }

    function test_fork_gasProfile_cancelRefund() public {
        escrow.createPayment(_vU(), SIG_U3);
        uint256 g = gasleft();
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
        emit log_named_uint("gas.cancel", g - gasleft());

        escrow.createPayment(_vL(), SIG_L3);
        vm.warp(EXPIRES);
        g = gasleft();
        escrow.refundExpired(PID_L);
        emit log_named_uint("gas.refundExpired", g - gasleft());
    }

    // ------------------------------------------------------------------ T47 guard on real AUSD

    function test_fork_guard_receiveUpgradedFlag_blocksCreateOnly() public {
        escrow.createPayment(_vU(), SIG_U3);
        uint256 data = uint256(vm.load(AUSD, IMPL_SLOT));
        vm.store(AUSD, IMPL_SLOT, bytes32(data | (uint256(1) << (255 - 86)))); // Agora flips the switch
        assertTrue(ausd.isReceiveWithAuthorizationUpgraded());
        vm.expectRevert(IEverpieceEscrow.AusdSemanticsChanged.selector);
        escrow.createPayment(_vL(), SIG_L3);
        // Existing liability unaffected. (The flag re-routes only receiveWithAuthorization; transfer stays inline.)
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
        assertEq(ausd.balanceOf(sender), 1_000e6);
    }

    // ------------------------------------------------------------------ T80–T82 issuer controls on real AUSD

    function test_fork_escrowFrozen_outflowsRevert_stateUnchanged() public {
        escrow.createPayment(_vU(), SIG_U3);
        _freeze(ESCROW, true);
        vm.expectRevert(abi.encodeWithSignature("AccountIsFrozen(address)", ESCROW));
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
        assertEq(uint8(escrow.getPayment(PID_U).status), uint8(IEverpieceEscrow.Status.ACTIVE));
        _freeze(ESCROW, false);
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
    }

    function test_fork_recipientFrozen_claimReverts_cancelWorks() public {
        escrow.createPayment(_vU(), SIG_U3);
        _freeze(recipient, true);
        vm.expectRevert(abi.encodeWithSignature("AccountIsFrozen(address)", recipient));
        escrow.claimUsernamePayment(PID_U, recipient, bytes32(uint256(0x5a170)), bytes32(uint256(0xc1)), DEADLINE, SIG_U4);
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
    }

    function test_fork_issuerBurnFromEscrow_payoutReverts() public {
        escrow.createPayment(_vU(), SIG_U3);
        address burner = IAUSDAdmin(AUSD).getBurnerRoleMembers()[0];
        vm.prank(burner);
        IAUSDAdmin(AUSD).burn(ESCROW, 1);
        assertLt(ausd.balanceOf(ESCROW), escrow.totalActiveLiability()); // documented issuer risk
        vm.expectRevert();
        escrow.cancel(PID_U, bytes32(uint256(0xc2)), DEADLINE, SIG_U6);
        assertEq(uint8(escrow.getPayment(PID_U).status), uint8(IEverpieceEscrow.Status.ACTIVE));
    }
}

interface IAUSDFull {
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes memory) external;
}
