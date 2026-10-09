// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EverpiecePayV2, IStableConverter} from "../../src/EverpiecePayV2.sol";
import {EverpieceStableConverter, IV4PoolManager} from "../../src/EverpieceStableConverter.sol";
import {IAgoraStableSwapPair} from "../../src/interfaces/IAgoraStableSwapPair.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EverpieceEarn} from "../../src/EverpieceEarn.sol";
import {EverpieceEarnUsdc} from "../../src/EverpieceUsdc.sol";
import {EverpieceAutomate} from "../../src/EverpieceAutomate.sol";

/// @notice Relayer gas limits for EverpiecePayV2 on CURRENT Monad mainnet, measured like RelayerGas.t.sol: cold
///         state, fresh recipients, intrinsic + calldata included, ≥5% headroom. server/relayer/test/gasLimits.test.ts
///         keeps the relayer defaults equal to the constants below. Enable with RUN_FORK_TESTS=true.
contract RelayerGasV2Test is Test {
    uint256 constant LIMIT_PAY_V2_DIRECT = 340_000;
    uint256 constant LIMIT_PAY_V2_CONVERT = 800_000;
    uint256 constant LIMIT_EARN_USDC_DEPOSIT = 820_000;
    uint256 constant LIMIT_EARN_USDC_WITHDRAW = 700_000;
    address constant WA_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2;
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant HEADROOM_BPS = 500;

    address constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant PAIR = 0xf33286E3222D1c829dACeac48c0Ec651F6452470;
    address constant WHITELISTER = 0x4B95a6990ec8B7dE1fAB83dF36f4f63FDE464fFC;
    address constant PM = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant AAVE_AUSDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    bytes32 constant AUSD_CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700;
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 constant PK = 0x5E11D;

    EverpiecePayV2 pay;
    EverpieceStableConverter conv;
    address sender;
    uint256 nextRcpt = 0x20000;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        sender = vm.addr(PK);
        conv = new EverpieceStableConverter(IV4PoolManager(PM), AUSD, USDC, 9, 1);
        EverpiecePayV2.Asset[] memory a = new EverpiecePayV2.Asset[](2);
        a[0] = EverpiecePayV2.Asset(USDC, false);
        a[1] = EverpiecePayV2.Asset(AUSD, true);
        address[] memory pairs = new address[](1);
        pairs[0] = PAIR;
        pay = new EverpiecePayV2(a, pairs, IStableConverter(address(conv)));
        vm.prank(AAVE_AUSDC);
        IERC20(USDC).transfer(sender, 1_000e6);
        vm.store(AUSD, keccak256(abi.encode(sender, AUSD_CORE_SLOT)), bytes32(uint256(1_000e6) << 8));
    }

    function _p(address asset, address source, uint256 maxSource, bool fb) internal returns (EverpiecePayV2.Payment memory) {
        return EverpiecePayV2.Payment({
            ref: keccak256(abi.encode(nextRcpt)),
            sender: sender,
            recipient: vm.addr(nextRcpt++),
            asset: asset,
            amount: 5e6,
            sourceToken: source,
            maxSourceAmount: maxSource,
            deadline: block.timestamp + 10 minutes,
            fallbackToSource: fb
        });
    }

    function _data(EverpiecePayV2.Payment memory p) internal view returns (bytes memory) {
        bytes32 id = pay.paymentIdOf(p);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(p.sourceToken).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RWA_TYPEHASH, sender, address(pay), p.maxSourceAmount, 0, p.deadline, id))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        return abi.encodeCall(EverpiecePayV2.pay, (p, abi.encodePacked(r, s, v)));
    }

    function _txGas(bytes memory data, address rcpt) internal returns (uint256) {
        vm.cool(AUSD);
        vm.cool(USDC);
        vm.cool(PAIR);
        vm.cool(PM);
        vm.cool(address(conv));
        vm.cool(address(pay));
        vm.cool(sender);
        vm.cool(rcpt);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = address(pay).call(data);
        uint256 used = g - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        uint256 zeros;
        for (uint256 i = 0; i < data.length; i++) if (data[i] == 0) zeros++;
        uint256 tokens = zeros + (data.length - zeros) * 4;
        uint256 standard = 21_000 + tokens * 4 + used;
        uint256 floor = 21_000 + tokens * 10;
        return standard > floor ? standard : floor;
    }

    function _check(string memory name, uint256 gas, uint256 limit) internal {
        emit log_named_uint(string.concat("gas.", name), gas);
        assertLe(gas * (10_000 + HEADROOM_BPS) / 10_000, limit, string.concat(name, ": limit leaves < 5% headroom"));
    }

    function _run(string memory name, EverpiecePayV2.Payment memory p, uint256 limit) internal {
        _check(name, _txGas(_data(p), p.recipient), limit);
    }

    function test_gas_direct_usdc() public {
        _run("payV2.direct(USDC)", _p(USDC, USDC, 5e6, false), LIMIT_PAY_V2_DIRECT);
    }

    function test_gas_direct_ausd() public {
        _run("payV2.direct(AUSD)", _p(AUSD, AUSD, 5e6, false), LIMIT_PAY_V2_DIRECT);
    }

    function test_gas_convert_v4_usdc_to_ausd() public {
        _run("payV2.convert(v4 USDC->AUSD)", _p(AUSD, USDC, 5_025_000, true), LIMIT_PAY_V2_CONVERT);
    }

    function test_gas_convert_v4_ausd_to_usdc() public {
        _run("payV2.convert(v4 AUSD->USDC)", _p(USDC, AUSD, 5_025_000, true), LIMIT_PAY_V2_CONVERT);
    }

    function _grantAgora() internal {
        vm.startPrank(WHITELISTER);
        (bool ok,) = PAIR.call(abi.encodeWithSignature("setApprovedSwapper(address,bool)", address(pay), true));
        if (!ok) (ok,) = PAIR.call(abi.encodeWithSignature("setApprovedSwappers(address[],bool)", _one(address(pay)), true));
        if (!ok) (ok,) = PAIR.call(abi.encodeWithSignature("setRoleMembership(string,address,bool)", "APPROVED_SWAPPER", address(pay), true));
        vm.stopPrank();
        assertTrue(IAgoraStableSwapPair(PAIR).hasRole("APPROVED_SWAPPER", address(pay)));
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function test_gas_convert_agora() public {
        _grantAgora();
        _run("payV2.convert(Agora USDC->AUSD)", _p(AUSD, USDC, 5_025_000, true), LIMIT_PAY_V2_CONVERT);
    }

    /// Worst case: Agora approved but failing (forced), then the v4 converter delivers.
    function test_gas_convert_agora_fails_then_v4() public {
        _grantAgora();
        vm.mockCallRevert(PAIR, abi.encodeWithSelector(IAgoraStableSwapPair.swapTokensForExactTokens.selector), "x");
        _run("payV2.convert(Agora fail -> v4)", _p(AUSD, USDC, 5_025_000, true), LIMIT_PAY_V2_CONVERT);
    }

    /// The relayer's limit must also leave the contract's per-attempt gas floors satisfiable: the worst path, run with
    /// EXACTLY the gas a transaction at the limit has for execution, still converts (no InsufficientGas, no fallback).
    function test_worst_case_completes_within_limit() public {
        _grantAgora();
        vm.mockCallRevert(PAIR, abi.encodeWithSelector(IAgoraStableSwapPair.swapTokensForExactTokens.selector), "x");
        EverpiecePayV2.Payment memory p = _p(AUSD, USDC, 5_025_000, true);
        bytes memory data = _data(p);
        uint256 zeros;
        for (uint256 i = 0; i < data.length; i++) if (data[i] == 0) zeros++;
        uint256 execGas = LIMIT_PAY_V2_CONVERT - 21_000 - (zeros + (data.length - zeros) * 4) * 4;
        vm.cool(AUSD);
        vm.cool(USDC);
        vm.cool(PM);
        vm.cool(address(conv));
        vm.cool(address(pay));
        (bool ok,) = address(pay).call{gas: execGas}(data);
        assertTrue(ok, "worst case fails at the relayer limit");
        assertEq(IERC20(AUSD).balanceOf(p.recipient), 5e6); // converted, not fallen back
    }

    // ------------------------------------------------------------------ USDC Earn (EverpieceEarnUsdc, real Aave waMonUSDC)

    function _earnUsdc() internal returns (EverpieceEarnUsdc earn) {
        address[] memory vs = new address[](1);
        vs[0] = WA_USDC;
        earn = new EverpieceEarnUsdc(USDC, vs);
    }

    function _earnTxGas(address target, bytes memory data) internal returns (uint256) {
        vm.cool(USDC);
        vm.cool(WA_USDC);
        vm.cool(0x35a73BAcb179d3740395A3ceCc87FF2e581d6042); // aUSDC
        vm.cool(0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef); // Aave pool
        vm.cool(target);
        vm.cool(sender);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        uint256 used = g - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        uint256 zeros;
        for (uint256 i = 0; i < data.length; i++) if (data[i] == 0) zeros++;
        uint256 tokens = zeros + (data.length - zeros) * 4;
        uint256 standard = 21_000 + tokens * 4 + used;
        uint256 floor = 21_000 + tokens * 10;
        return standard > floor ? standard : floor;
    }

    function _earnDepositData(EverpieceEarnUsdc earn, uint256 assets) internal view returns (bytes memory) {
        EverpieceEarn.Deposit memory d =
            EverpieceEarn.Deposit(bytes32("leg"), sender, WA_USDC, assets, IERC4626(WA_USDC).previewDeposit(assets), block.timestamp + 600);
        bytes32 id = earn.depositIdOf(d);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IERC20Permit(USDC).DOMAIN_SEPARATOR(), keccak256(abi.encode(RWA_TYPEHASH, sender, address(earn), assets, 0, d.deadline, id)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        return abi.encodeCall(EverpieceEarn.deposit, (d, abi.encodePacked(r, s, v)));
    }

    function test_gas_earnUsdc_deposit_and_withdraw() public {
        EverpieceEarnUsdc earn = _earnUsdc();
        _check("earnUsdc.deposit", _earnTxGas(address(earn), _earnDepositData(earn, 100e6)), LIMIT_EARN_USDC_DEPOSIT);
        assertGt(IERC20(WA_USDC).balanceOf(sender), 0);

        uint256 assets = 50e6;
        EverpieceEarn.Withdrawal memory w =
            EverpieceEarn.Withdrawal(bytes32("out"), sender, WA_USDC, assets, IERC4626(WA_USDC).previewWithdraw(assets), block.timestamp + 600);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK, earn.withdrawalIdOf(w));
        bytes32 pd = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(WA_USDC).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, sender, address(earn), w.maxShares, IERC20Permit(WA_USDC).nonces(sender), w.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, pd);
        bytes memory data = abi.encodeCall(EverpieceEarn.withdraw, (w, abi.encodePacked(r0, s0, v0), v, r, s));
        uint256 before = IERC20(USDC).balanceOf(sender);
        _check("earnUsdc.withdraw", _earnTxGas(address(earn), data), LIMIT_EARN_USDC_WITHDRAW);
        assertEq(IERC20(USDC).balanceOf(sender), before + assets);
    }

    /// Everything fails, fallback delivers USDC.
    function test_gas_convert_all_fail_fallback() public {
        _grantAgora();
        vm.mockCallRevert(PAIR, abi.encodeWithSelector(IAgoraStableSwapPair.swapTokensForExactTokens.selector), "x");
        vm.mockCallRevert(address(conv), abi.encodeWithSelector(EverpieceStableConverter.convertExactOut.selector), "x");
        _run("payV2.convert(all fail -> fallback)", _p(AUSD, USDC, 5_025_000, true), LIMIT_PAY_V2_CONVERT);
    }
}

/// @notice EverpieceAutomate on CURRENT mainnet: real USDC (FiatToken ERC-2612 permit) into real Aave waMonUSDC,
///         measured cold for the relayer's activate / execute limits.
contract AutomateForkTest is Test {
    uint256 constant LIMIT_AUTOMATE_ACTIVATE = 400_000;
    uint256 constant LIMIT_AUTOMATE_EXECUTE = 830_000;
    uint256 constant LIMIT_AUTOMATE_REVOKE = 120_000;
    uint256 constant HEADROOM_BPS = 500;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WA_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2;
    address constant AAVE_AUSDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant PK = 0xA0705;
    address owner;
    address executor = makeAddr("relayer");
    EverpieceAutomate auto_;

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        owner = vm.addr(PK);
        address[] memory vs = new address[](1);
        vs[0] = WA_USDC;
        auto_ = new EverpieceAutomate(vs);
        vm.prank(AAVE_AUSDC);
        IERC20(USDC).transfer(owner, 500e6);
    }

    function _gas(address target, bytes memory data, address caller) internal returns (uint256) {
        vm.cool(USDC);
        vm.cool(WA_USDC);
        vm.cool(AAVE_AUSDC);
        vm.cool(0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef);
        vm.cool(target);
        vm.cool(owner);
        vm.prank(caller);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = target.call(data);
        uint256 used = g - gasleft();
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        uint256 zeros;
        for (uint256 i = 0; i < data.length; i++) if (data[i] == 0) zeros++;
        uint256 tokens = zeros + (data.length - zeros) * 4;
        uint256 standard = 21_000 + tokens * 4 + used;
        uint256 floor = 21_000 + tokens * 10;
        return standard > floor ? standard : floor;
    }

    function _check(string memory name, uint256 gas, uint256 limit) internal {
        emit log_named_uint(string.concat("gas.", name), gas);
        assertLe(gas * (10_000 + HEADROOM_BPS) / 10_000, limit, string.concat(name, ": limit leaves < 5% headroom"));
    }

    function test_automate_real_usdc_into_real_aave() public {
        EverpieceAutomate.Grant memory g = EverpieceAutomate.Grant({
            ruleId: keccak256("keep-50-earn-rest"), owner: owner, executor: executor, vault: WA_USDC,
            maxPerExecution: 100e6, maxPerDay: 100e6, total: 300e6, expiresAt: block.timestamp + 30 days
        });
        bytes32 id = auto_.grantIdOf(g);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(PK, id);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 pd = keccak256(
            abi.encodePacked("\x19\x01", IERC20Permit(USDC).DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, address(auto_), g.total, IERC20Permit(USDC).nonces(owner), dl)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, pd);
        bytes memory act = abi.encodeCall(EverpieceAutomate.activate, (g, abi.encodePacked(r0, s0, v0), dl, v, r, s));
        _check("automate.activate", _gas(address(auto_), act, executor), LIMIT_AUTOMATE_ACTIVATE);
        assertEq(IERC20(USDC).allowance(owner, address(auto_)), 300e6);

        uint256 minShares = IERC4626(WA_USDC).previewDeposit(100e6);
        bytes memory ex = abi.encodeCall(EverpieceAutomate.execute, (id, keccak256("exec-1"), 100e6, minShares));
        _check("automate.execute", _gas(address(auto_), ex, executor), LIMIT_AUTOMATE_EXECUTE);
        assertEq(IERC20(USDC).balanceOf(owner), 400e6);
        assertApproxEqAbs(IERC4626(WA_USDC).convertToAssets(IERC20(WA_USDC).balanceOf(owner)), 100e6, 1);
        assertEq(auto_.principalOf(owner, WA_USDC), 100e6);
        assertEq(IERC20(USDC).balanceOf(address(auto_)), 0);

        // gasless revocation (the owner's signature, relayed): afterwards nothing more can run
        bytes32 rd = keccak256(abi.encodePacked("\x19\x01", auto_.DOMAIN_SEPARATOR(), keccak256(abi.encode(auto_.REVOKE_TYPEHASH(), id))));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(PK, rd);
        bytes memory rv = abi.encodeCall(EverpieceAutomate.revokeBySig, (id, abi.encodePacked(r2, s2, v2)));
        _check("automate.revoke", _gas(address(auto_), rv, executor), LIMIT_AUTOMATE_REVOKE);
        assertEq(auto_.remaining(id), 0);
        vm.prank(executor);
        vm.expectRevert(EverpieceAutomate.Revoked.selector);
        auto_.execute(id, keccak256("exec-2"), 1e6, 0);
    }
}
