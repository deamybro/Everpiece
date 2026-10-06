// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {EverpiecePay} from "../../src/EverpiecePay.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {IAUSD} from "../../src/interfaces/IAUSD.sol";
import {IAgoraStableSwapPair, IAgoraTestnetWhitelister} from "../../src/interfaces/IAgoraStableSwapPair.sol";

interface IAgoraFaucetG {
    function requestFunds(address to) external;
}

/// @notice The relayer's explicit gas limit for every action must cover the real worst case on Monad, which charges
///         the FULL limit (VERIFIED §1.5): too high wastes money, too low fails the payment. Testnet found both
///         payWithAusd (200k < 223k) and refundExpired (145k) too low. Each action runs here against REAL AUSD with
///         cold storage (`vm.cool`), paying a recipient who never held AUSD, and counts intrinsic + calldata gas.
///         Enable with RUN_FORK_TESTS=true (optional MONAD_RPC / MONAD_TESTNET_RPC).
abstract contract RelayerGasBase is Test {
    // Defaults of server/relayer/src/config.ts `gasLimits` (its test/gasLimits.test.ts fails if these drift).
    uint256 constant LIMIT_CREATE_PAYMENT = 350_000;
    uint256 constant LIMIT_CLAIM_USERNAME = 230_000;
    uint256 constant LIMIT_CLAIM_LINK = 270_000;
    uint256 constant LIMIT_CANCEL = 205_000;
    uint256 constant LIMIT_REFUND = 155_000;
    uint256 constant LIMIT_PAY_AUSD = 280_000;
    uint256 constant LIMIT_PAY_TOKEN = 550_000;
    /// Every limit must exceed the measured worst case by at least this much.
    uint256 constant HEADROOM_BPS = 500;

    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant SENDER_PK = 0x5E11D;
    uint256 constant APPROVER_PK = 0xA99;
    uint256 constant CLAIMKEY_PK = 0xC1A1;

    EverpieceEscrow escrow;
    EverpiecePay pay;
    address ausd;
    address sender;
    uint256 nextPk = 0x10000; // every recipient is a fresh account that never held AUSD
    uint256 saltN;

    function _selectFork() internal virtual;
    function _ausd() internal pure virtual returns (address);
    function _fund(address who) internal virtual;
    function _pairs() internal virtual returns (address[] memory);

    function setUp() public virtual {
        if (!vm.envOr("RUN_FORK_TESTS", false)) {
            vm.skip(true);
            return;
        }
        _selectFork();
        ausd = _ausd();
        sender = vm.addr(SENDER_PK);
        escrow = new EverpieceEscrow(IAUSD(ausd), address(this), vm.addr(APPROVER_PK));
        pay = new EverpiecePay(IAUSD(ausd), _pairs());
        _fund(sender);
    }

    // ------------------------------------------------------------------ measurement

    /// Gas a relayer transaction calling `target` with `data` needs, on cold state: execution (incl. the call's own
    /// overhead, a slight overestimate) + 21,000 + calldata, or the EIP-7623 calldata floor if higher.
    function _txGas(address target, bytes memory data, address[] memory accounts) internal returns (uint256) {
        vm.cool(ausd);
        vm.cool(target);
        for (uint256 i = 0; i < accounts.length; i++) vm.cool(accounts[i]);
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

    function _accounts(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        l[0] = a;
        l[1] = b;
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _rwa(address to, uint256 value, uint256 validBefore, bytes32 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(ausd).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RWA_TYPEHASH, sender, to, value, 0, validBefore, nonce))
            )
        );
    }

    function _fresh() internal returns (uint256 pk, address a) {
        pk = nextPk++;
        a = vm.addr(pk);
    }

    // ------------------------------------------------------------------ escrow actions

    /// Creates a payment (measured: the escrow's first ever, so its AUSD balance goes 0 → amount).
    function _create(uint8 mode, bytes32 rc, address approver) internal returns (bytes32 id, IEverpieceEscrow.PaymentIntent memory i) {
        i = IEverpieceEscrow.PaymentIntent({
            sender: sender,
            mode: mode,
            recipientCommitment: rc,
            metadataCommitment: keccak256("metadata"),
            approver: approver,
            amount: 5e6,
            expiresAt: block.timestamp + 29 days,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            salt: keccak256(abi.encode("salt", ++saltN))
        });
        id = escrow.paymentIdOf(i);
        bytes memory sig = _sign(SENDER_PK, _rwa(address(escrow), i.amount, i.validBefore, id));
        _check("createPayment", _txGas(address(escrow), abi.encodeCall(escrow.createPayment, (i, sig)), _accounts(sender, address(0))), LIMIT_CREATE_PAYMENT);
    }

    function test_gas_claimUsernamePayment() public {
        (uint256 rpk, address rcpt) = _fresh();
        bytes32 rsalt = bytes32("rsalt");
        (bytes32 id,) = _create(1, escrow.recipientCommitmentOf(1, rcpt, rsalt), address(0));
        bytes32 n = keccak256("claim");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sign(rpk, escrow.hashClaimIntent(id, rcpt, n, dl));
        bytes memory data = abi.encodeCall(escrow.claimUsernamePayment, (id, rcpt, rsalt, n, dl, sig));
        _check("claimUsernamePayment", _txGas(address(escrow), data, _accounts(sender, rcpt)), LIMIT_CLAIM_USERNAME);
        assertEq(IERC20(ausd).balanceOf(rcpt), 5e6);
    }

    function test_gas_claimLinkPayment() public {
        (, address rcpt) = _fresh();
        bytes32 rsalt = bytes32("lsalt");
        (bytes32 id,) = _create(2, escrow.recipientCommitmentOf(2, vm.addr(CLAIMKEY_PK), rsalt), vm.addr(APPROVER_PK));
        bytes32 n = keccak256("lclaim");
        bytes32 an = keccak256("approval");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory ckSig = _sign(CLAIMKEY_PK, escrow.hashLinkClaimIntent(id, rcpt, n, dl));
        bytes memory apSig = _sign(APPROVER_PK, escrow.hashClaimApproval(id, rcpt, an, dl));
        bytes memory data =
            abi.encodeCall(escrow.claimLinkPayment, (id, rcpt, vm.addr(CLAIMKEY_PK), rsalt, n, dl, ckSig, an, dl, apSig));
        _check("claimLinkPayment", _txGas(address(escrow), data, _accounts(sender, rcpt)), LIMIT_CLAIM_LINK);
        assertEq(IERC20(ausd).balanceOf(rcpt), 5e6);
    }

    function test_gas_cancel() public {
        (bytes32 id,) = _create(1, keccak256("rc"), address(0));
        bytes32 n = keccak256("cancel");
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sig = _sign(SENDER_PK, escrow.hashCancelIntent(id, sender, n, dl));
        _check("cancel", _txGas(address(escrow), abi.encodeCall(escrow.cancel, (id, n, dl, sig)), _accounts(sender, address(0))), LIMIT_CANCEL);
    }

    function test_gas_refundExpired() public {
        (bytes32 id, IEverpieceEscrow.PaymentIntent memory i) = _create(2, keccak256("rc"), vm.addr(APPROVER_PK));
        vm.warp(i.expiresAt);
        _check("refundExpired", _txGas(address(escrow), abi.encodeCall(escrow.refundExpired, (id)), _accounts(sender, address(0))), LIMIT_REFUND);
    }

    // ------------------------------------------------------------------ instant payments

    function _payment(address source, uint256 maxSource, address rcpt) internal view returns (EverpiecePay.Payment memory) {
        return EverpiecePay.Payment({
            ref: keccak256("ref"), sender: sender, recipient: rcpt, amount: 5e6, sourceToken: source, maxSourceAmount: maxSource,
            deadline: block.timestamp + 10 minutes
        });
    }

    function test_gas_payWithAusd() public {
        (, address rcpt) = _fresh();
        EverpiecePay.Payment memory p = _payment(ausd, 5e6, rcpt);
        bytes memory sig = _sign(SENDER_PK, _rwa(address(pay), p.amount, p.deadline, pay.paymentIdOf(p)));
        _check("payWithAusd", _txGas(address(pay), abi.encodeCall(pay.payWithAusd, (p, sig)), _accounts(sender, rcpt)), LIMIT_PAY_AUSD);
        assertEq(IERC20(ausd).balanceOf(rcpt), 5e6);
    }
}

/// Mainnet: the AUSD the product will use (the escrow's create/claims cost more here than on testnet AUSD).
contract RelayerGasMainnetForkTest is RelayerGasBase {
    bytes32 constant CORE_SLOT = 0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700; // VERIFIED §2.12

    function _selectFork() internal override {
        vm.createSelectFork(vm.envOr("MONAD_RPC", string("https://rpc.monad.xyz")));
        assertEq(block.chainid, 143);
    }

    function _ausd() internal pure override returns (address) {
        return 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    }

    function _fund(address who) internal override {
        vm.store(ausd, keccak256(abi.encode(who, CORE_SLOT)), bytes32(uint256(1_000e6) << 8));
    }

    function _pairs() internal pure override returns (address[] memory) {
        return new address[](0);
    }

    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AUSD_USDC_PAIR = 0xf33286E3222D1c829dACeac48c0Ec651F6452470;
    /// A wallet Agora already holds as APPROVED_SWAPPER on the pair (no code). EverpiecePay is placed there so the real
    /// pair's role check passes unmodified; on mainnet, Agora must approve our deployed EverpiecePay the same way.
    address constant APPROVED_EOA = 0xF28E1B06E00e8774C612e31aB3Ac35d5a720085f;

    /// "Add Dollars from another chain": USDC that Aurora delivered becomes EXACTLY that many Dollars through the real
    /// Agora AUSD/USDC pair, authorized by a USDC permit (name "USDC", version "2") — and its gas fits the limit.
    function test_gas_payWithToken_usdcToAusd_exact() public {
        assertTrue(IAgoraStableSwapPair(AUSD_USDC_PAIR).hasRole("APPROVED_SWAPPER", APPROVED_EOA));
        assertEq(APPROVED_EOA.code.length, 0);
        address[] memory pairs = new address[](1);
        pairs[0] = AUSD_USDC_PAIR;
        deployCodeTo("EverpiecePay.sol:EverpiecePay", abi.encode(IAUSD(ausd), pairs), APPROVED_EOA);
        EverpiecePay usdcPay = EverpiecePay(APPROVED_EOA);

        deal(USDC, sender, 100e6); // the USDC Aurora would have delivered (the pair's reserves stay untouched)
        uint256 quoted = usdcPay.quote(USDC, 25e6);
        (, address rcpt) = _fresh();
        EverpiecePay.Payment memory p = EverpiecePay.Payment({
            ref: keccak256("aurora"), sender: sender, recipient: rcpt, amount: 25e6, sourceToken: USDC,
            maxSourceAmount: quoted + quoted / 200, deadline: block.timestamp + 10 minutes
        });
        bytes32 permitDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(USDC).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, sender, address(usdcPay), p.maxSourceAmount, IERC20Permit(USDC).nonces(sender), p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SENDER_PK, permitDigest);
        bytes memory data = abi.encodeCall(usdcPay.payWithToken, (p, _sign(SENDER_PK, usdcPay.paymentIdOf(p)), p.deadline, v, r, s));
        uint256 usdcBefore = IERC20(USDC).balanceOf(sender);
        address[] memory accts = new address[](4);
        accts[0] = sender;
        accts[1] = rcpt;
        accts[2] = USDC;
        accts[3] = AUSD_USDC_PAIR;
        _check("payWithToken(USDC, mainnet)", _txGas(address(usdcPay), data, accts), LIMIT_PAY_TOKEN);
        assertEq(IERC20(ausd).balanceOf(rcpt), 25e6, "exactly 25.000000 AUSD");
        assertEq(usdcBefore - IERC20(USDC).balanceOf(sender), quoted, "charged exactly the quote; headroom returned");
        assertEq(IERC20(USDC).balanceOf(address(usdcPay)), 0);
    }
}

/// Testnet: real Agora AUSD, plus paying in CTK through the real Instant Settlement pair.
contract RelayerGasTestnetForkTest is RelayerGasBase {
    address constant CTK = 0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D;
    address constant PAIR = 0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae;
    address constant WHITELISTER = 0x7c10F56d6f04a51376393a1C3670e966863F6BD5;
    address constant FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;

    function _selectFork() internal override {
        vm.createSelectFork(vm.envOr("MONAD_TESTNET_RPC", string("https://testnet-rpc.monad.xyz")));
        assertEq(block.chainid, 10143);
    }

    function _ausd() internal pure override returns (address) {
        return 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    }

    function _fund(address who) internal override {
        IAgoraFaucetG(FAUCET).requestFunds(who);
    }

    function _pairs() internal pure override returns (address[] memory p) {
        p = new address[](1);
        p[0] = PAIR;
    }

    function test_gas_payWithToken() public {
        IAgoraTestnetWhitelister(WHITELISTER).setApprovedSwapper(address(pay));
        vm.startPrank(sender);
        IAgoraTestnetWhitelister(WHITELISTER).setApprovedSwapper(sender);
        IERC20(ausd).approve(PAIR, type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = ausd;
        path[1] = CTK;
        IAgoraStableSwapPair(PAIR).swapTokensForExactTokens(100 ether, 200e6, path, sender, block.timestamp + 300);
        IERC20(ausd).approve(PAIR, 0);
        vm.stopPrank();

        (, address rcpt) = _fresh();
        uint256 quoted = pay.quote(CTK, 5e6);
        EverpiecePay.Payment memory p = _payment(CTK, quoted + quoted / 200, rcpt); // the relayer's 0.5% headroom
        bytes32 permitDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(CTK).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, sender, address(pay), p.maxSourceAmount, IERC20Permit(CTK).nonces(sender), p.deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SENDER_PK, permitDigest);
        bytes memory data = abi.encodeCall(pay.payWithToken, (p, _sign(SENDER_PK, pay.paymentIdOf(p)), p.deadline, v, r, s));
        address[] memory accts = new address[](4);
        accts[0] = sender;
        accts[1] = rcpt;
        accts[2] = CTK;
        accts[3] = PAIR;
        _check("payWithToken", _txGas(address(pay), data, accts), LIMIT_PAY_TOKEN);
        assertEq(IERC20(ausd).balanceOf(rcpt), 5e6);
    }
}
