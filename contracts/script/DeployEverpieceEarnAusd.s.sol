// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EverpieceEarn} from "../src/EverpieceEarn.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";

interface IVaultView {
    function asset() external view returns (address);
}

/// @notice Mainnet AUSD Earn over two verified vaults: Aave V3 "Wrapped Aave Monad AUSD" and Morpho's listed
///         "Grove x Steakhouse High Yield AUSD" MetaMorpho vault. Asserts both vaults' asset() is AUSD first.
/// @dev MAINNET BROADCAST REQUIRES THE OWNER'S EXPLICIT, SCOPED GO. Simulate only:
///        forge script script/DeployEverpieceEarnAusd.s.sol --rpc-url $MONAD_RPC --sender <deployer>
contract DeployEverpieceEarnAusd is Script {
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; // VERIFIED §2.1
    address internal constant WA_AUSD = 0x9e1AcC5BFbf34e2E579763cE14042d957719fE76; // VERIFIED §4.17
    address internal constant MORPHO_AUSD = 0x32841A8511D5c2c5b253f45668780B99139e476D; // VERIFIED §4.21

    function run() external returns (EverpieceEarn earn) {
        require(block.chainid == 143, "not Monad mainnet (143)");
        require(IVaultView(WA_AUSD).asset() == AUSD, "Aave vault asset != AUSD");
        require(IVaultView(MORPHO_AUSD).asset() == AUSD, "Morpho vault asset != AUSD");
        address[] memory vaults = new address[](2);
        vaults[0] = WA_AUSD;
        vaults[1] = MORPHO_AUSD;
        vm.startBroadcast();
        earn = new EverpieceEarn(IAUSD(AUSD), vaults);
        vm.stopBroadcast();
        console.log("EverpieceEarn (AUSD: Aave + Morpho)", address(earn));
    }
}
