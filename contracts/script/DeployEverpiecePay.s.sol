// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EverpiecePay} from "../src/EverpiecePay.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";

interface IAUSDView {
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IPairView {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Deploys EverpiecePay to Monad mainnet over real AUSD with the Agora AUSD/USDC pair, after asserting every
///         docs/VERIFIED.md fact it depends on. EverpiecePay has no owner: AUSD and the pair list are fixed here.
/// @dev MAINNET BROADCAST REQUIRES MARIS'S EXPLICIT GO (master §48–49). Simulate first:
///        forge script script/DeployEverpiecePay.s.sol --rpc-url $MONAD_RPC --sender <deployer>
///      Never pass private keys on the command line; use a hardware wallet / --account keystore.
///      USDC conversions only work once Agora grants EverpiecePay APPROVED_SWAPPER (VERIFIED §4.14); AUSD payments
///      work without it.
contract DeployEverpiecePay is Script {
    uint256 internal constant MONAD_MAINNET = 143; // VERIFIED §1.1
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; // VERIFIED §2.1
    bytes32 internal constant AUSD_DOMAIN_SEPARATOR = 0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe; // §2.4
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603; // VERIFIED §4.14
    address internal constant AUSD_USDC_PAIR = 0xf33286E3222D1c829dACeac48c0Ec651F6452470; // VERIFIED §4.14

    function run() external returns (EverpiecePay pay) {
        require(block.chainid == MONAD_MAINNET, "not Monad mainnet (143)");
        require(AUSD.code.length > 0, "AUSD has no code");
        require(IAUSDView(AUSD).decimals() == 6, "AUSD decimals != 6");
        require(IAUSDView(AUSD).DOMAIN_SEPARATOR() == AUSD_DOMAIN_SEPARATOR, "AUSD EIP-712 domain changed");
        require(!IAUSD(AUSD).isReceiveWithAuthorizationUpgraded(), "AUSD receiveWithAuthorization re-routed");
        require(AUSD_USDC_PAIR.code.length > 0, "pair has no code");
        require(IPairView(AUSD_USDC_PAIR).token0() == AUSD && IPairView(AUSD_USDC_PAIR).token1() == USDC, "pair tokens changed");

        address[] memory pairs = new address[](1);
        pairs[0] = AUSD_USDC_PAIR;

        vm.startBroadcast();
        pay = new EverpiecePay(IAUSD(AUSD), pairs);
        vm.stopBroadcast();

        require(address(pay.AUSD()) == AUSD, "post: token");
        require(pay.pairFor(USDC) == AUSD_USDC_PAIR, "post: USDC pair");

        console.log("EverpiecePay", address(pay));
        console.logBytes32(pay.DOMAIN_SEPARATOR());
    }
}
