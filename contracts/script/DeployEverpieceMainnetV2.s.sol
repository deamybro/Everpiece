// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EverpiecePayV2, IStableConverter} from "../src/EverpiecePayV2.sol";
import {EverpieceStableConverter, IV4PoolManager} from "../src/EverpieceStableConverter.sol";
import {EverpieceAutomate} from "../src/EverpieceAutomate.sol";
import {EverpieceEscrowUsdc, EverpieceEarnUsdc} from "../src/EverpieceUsdc.sol";
import {IAUSD} from "../src/interfaces/IAUSD.sol";

interface ITokenView {
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function paused() external view returns (bool);
}

interface IPairView {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IVaultView {
    function asset() external view returns (address);
}

/// @notice USDC-first mainnet set (mainnet mandate): EverpieceStableConverter (fixed Uniswap v4 AUSD/USDC pool),
///         EverpiecePayV2 (USDC + AUSD; conversions via Agora when approved, else the converter),
///         EverpieceEscrowUsdc (protected USDC payments) and EverpieceEarnUsdc (Aave V3 USDC). Asserts every
///         on-chain fact first. The AUSD escrow / AUSD Earn keep their own scripts.
/// @dev MAINNET BROADCAST REQUIRES THE OWNER'S EXPLICIT, SCOPED GO. Simulate only:
///        ESCROW_OWNER=0x… CLAIM_APPROVER=0x… forge script script/DeployEverpieceMainnetV2.s.sol --rpc-url $MONAD_RPC --sender <deployer>
///      Never pass private keys on the command line; use a hardware wallet / --account keystore.
contract DeployEverpieceMainnetV2 is Script {
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a; // VERIFIED §2.1
    bytes32 internal constant AUSD_DOMAIN_SEPARATOR = 0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe; // §2.4
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603; // VERIFIED §4.14, §4.18
    bytes32 internal constant USDC_DOMAIN_SEPARATOR = 0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6; // §4.18
    address internal constant AUSD_USDC_PAIR = 0xf33286E3222D1c829dACeac48c0Ec651F6452470; // VERIFIED §4.14
    address internal constant V4_POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e; // VERIFIED §4.19
    uint24 internal constant V4_FEE = 9; // VERIFIED §4.19 (pool id 0xd112fde9…27e8)
    int24 internal constant V4_TICK_SPACING = 1;
    address internal constant WA_AUSD = 0x9e1AcC5BFbf34e2E579763cE14042d957719fE76; // VERIFIED §4.17 (Aave AUSD_STATA_TOKEN)
    address internal constant WA_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2; // VERIFIED §4.18 (Aave USDC_STATA_TOKEN)

    function run() external returns (EverpieceStableConverter conv, EverpiecePayV2 pay, EverpieceEscrowUsdc escrow, EverpieceEarnUsdc earn, EverpieceAutomate automate) {
        address owner = vm.envAddress("ESCROW_OWNER");
        address approver = vm.envAddress("CLAIM_APPROVER");
        require(owner != address(0) && approver != address(0), "owner/approver unset");

        require(block.chainid == MONAD_MAINNET, "not Monad mainnet (143)");
        require(ITokenView(AUSD).decimals() == 6, "AUSD decimals != 6");
        require(ITokenView(AUSD).DOMAIN_SEPARATOR() == AUSD_DOMAIN_SEPARATOR, "AUSD EIP-712 domain changed");
        require(!IAUSD(AUSD).isReceiveWithAuthorizationUpgraded(), "AUSD receiveWithAuthorization re-routed");
        require(ITokenView(USDC).decimals() == 6, "USDC decimals != 6");
        require(ITokenView(USDC).DOMAIN_SEPARATOR() == USDC_DOMAIN_SEPARATOR, "USDC EIP-712 domain changed");
        require(!ITokenView(USDC).paused(), "USDC paused");
        require(IPairView(AUSD_USDC_PAIR).token0() == AUSD && IPairView(AUSD_USDC_PAIR).token1() == USDC, "pair tokens changed");
        require(IVaultView(WA_USDC).asset() == USDC, "vault asset != USDC");
        require(IVaultView(WA_AUSD).asset() == AUSD, "vault asset != AUSD");
        require(V4_POOL_MANAGER.code.length > 0, "v4 PoolManager has no code");

        EverpiecePayV2.Asset[] memory assets = new EverpiecePayV2.Asset[](2);
        assets[0] = EverpiecePayV2.Asset({token: USDC, ausdSemantics: false});
        assets[1] = EverpiecePayV2.Asset({token: AUSD, ausdSemantics: true});
        address[] memory pairs = new address[](1);
        pairs[0] = AUSD_USDC_PAIR;
        address[] memory vaults = new address[](1);
        vaults[0] = WA_USDC;

        vm.startBroadcast();
        conv = new EverpieceStableConverter(IV4PoolManager(V4_POOL_MANAGER), AUSD, USDC, V4_FEE, V4_TICK_SPACING);
        pay = new EverpiecePayV2(assets, pairs, IStableConverter(address(conv)));
        escrow = new EverpieceEscrowUsdc(USDC, owner, approver);
        earn = new EverpieceEarnUsdc(USDC, vaults);
        address[] memory autoVaults = new address[](2);
        autoVaults[0] = WA_USDC;
        autoVaults[1] = WA_AUSD;
        automate = new EverpieceAutomate(autoVaults);
        vm.stopBroadcast();

        require(pay.assetKind(USDC) == 1 && pay.assetKind(AUSD) == 2, "post: assets");
        require(pay.pairFor(USDC, AUSD) == AUSD_USDC_PAIR && pay.pairFor(AUSD, USDC) == AUSD_USDC_PAIR, "post: pair");
        require(address(escrow.AUSD()) == USDC, "post: escrow token");

        require(address(pay.CONVERTER()) == address(conv), "post: converter");
        console.log("EverpieceStableConverter", address(conv));
        console.log("EverpiecePayV2", address(pay));
        console.log("EverpieceEscrowUsdc", address(escrow));
        console.log("EverpieceEarnUsdc", address(earn));
        require(automate.vaultAsset(WA_USDC) == USDC && automate.vaultAsset(WA_AUSD) == AUSD, "post: automate vaults");
        console.log("EverpieceAutomate", address(automate));
    }
}
