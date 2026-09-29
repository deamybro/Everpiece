// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EverpieceEscrow} from "../src/EverpieceEscrow.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";

interface IAUSDView {
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Deploys EverpieceEscrow to Monad mainnet after asserting every docs/VERIFIED.md fact it depends on.
/// @dev MAINNET BROADCAST REQUIRES MARIS'S EXPLICIT GO (master §48–49). Simulate first:
///      ESCROW_OWNER_ADDRESS=0x.. CLAIM_APPROVER_ADDRESS=0x.. \
///        forge script script/DeployEverpieceEscrow.s.sol --rpc-url $MONAD_RPC --sender <deployer>
///      Never pass private keys on the command line; use a hardware wallet / --account keystore.
contract DeployEverpieceEscrow is Script {
    uint256 internal constant MONAD_MAINNET = 143; // VERIFIED §1.1
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; // VERIFIED §2.1
    bytes32 internal constant AUSD_DOMAIN_SEPARATOR = 0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe; // §2.4

    function run() external returns (EverpieceEscrow escrow) {
        address owner = vm.envAddress("ESCROW_OWNER_ADDRESS");
        address approver = vm.envAddress("CLAIM_APPROVER_ADDRESS");
        address deployer = msg.sender;

        require(block.chainid == MONAD_MAINNET, "not Monad mainnet (143)");
        require(AUSD.code.length > 0, "AUSD has no code");
        require(IAUSDView(AUSD).decimals() == 6, "AUSD decimals != 6");
        require(IAUSDView(AUSD).DOMAIN_SEPARATOR() == AUSD_DOMAIN_SEPARATOR, "AUSD EIP-712 domain changed");
        require(!IAUSD(AUSD).isReceiveWithAuthorizationUpgraded(), "AUSD receiveWithAuthorization re-routed");
        require(owner != address(0) && approver != address(0), "zero owner/approver");
        require(owner != approver && approver != deployer, "owner, approver and deployer must be distinct keys (spec 2)");

        vm.startBroadcast();
        escrow = new EverpieceEscrow(IAUSD(AUSD), owner, approver);
        vm.stopBroadcast();

        require(address(escrow.AUSD()) == AUSD, "post: token");
        require(escrow.owner() == owner, "post: owner");
        require(escrow.claimApprover() == approver, "post: approver");
        require(escrow.maxPaymentAmount() == 500e6 && escrow.maxActiveLiability() == 5_000e6, "post: caps");
        require(!escrow.paused(), "post: paused");

        console.log("EverpieceEscrow", address(escrow));
        console.log("owner", owner, "approver", approver);
        console.logBytes32(escrow.DOMAIN_SEPARATOR());
    }
}
