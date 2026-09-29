// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {EverpieceEscrow} from "../../src/EverpieceEscrow.sol";
import {IEverpieceEscrow} from "../../src/interfaces/IEverpieceEscrow.sol";
import {MockAUSD} from "../utils/MockAUSD.sol";

/// @dev Stateful fuzzing handler. Ghost variables are updated only after successful calls (a revert rolls them back).
contract EscrowHandler is CommonBase, StdCheats, StdUtils {
    EverpieceEscrow public immutable escrow;
    MockAUSD public immutable ausd;
    address public immutable owner;

    bytes32 internal constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 internal constant ATTACKER_PK = 0xA77AC;

    uint256[3] public senderPks = [uint256(11), 12, 13];
    uint256[3] public recipientPks = [uint256(21), 22, 23];
    uint256[2] public claimKeyPks = [uint256(31), 32];
    uint256[2] public approverPks = [uint256(3), 5]; // index 0 is the constructor approver
    uint256 public currentApproverIdx;

    bytes32[] public ids;
    mapping(bytes32 => uint256) public ghostAmount;
    mapping(bytes32 => address) public ghostSender;
    mapping(bytes32 => address) public ghostApprover;
    mapping(bytes32 => uint256) public ghostApproverPk;
    mapping(bytes32 => uint256) public ghostRecipientPk; // username recipient or intended link recipient
    mapping(bytes32 => uint256) public ghostClaimKeyPk;
    mapping(bytes32 => uint8) public ghostMode;
    mapping(bytes32 => IEverpieceEscrow.Status) public ghostTerminal;

    uint256 public ghostMinted;
    uint256 public ghostDonated;
    uint256 public ghostClaimed;
    uint256 public ghostReturned;
    uint256 public ghostFunded;
    uint256 public attackerSuccesses;
    uint256 public cancelBlocked;
    uint256 public refundBlocked;
    uint256 private _nonce;

    mapping(string => uint256) public calls;

    constructor(EverpieceEscrow escrow_, MockAUSD ausd_, address owner_) {
        escrow = escrow_;
        ausd = ausd_;
        owner = owner_;
        for (uint256 k; k < 3; ++k) {
            ausd.mint(vm.addr(senderPks[k]), 100_000e6);
            ghostMinted += 100_000e6;
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pick(uint256 seed) internal view returns (bytes32 id, bool ok) {
        if (ids.length == 0) return (bytes32(0), false);
        return (ids[seed % ids.length], true);
    }

    function _next() internal returns (bytes32) {
        return keccak256(abi.encode("h", ++_nonce));
    }

    // ------------------------------------------------------------------ actions

    function create(uint256 actorSeed, uint256 recipSeed, uint256 amount, uint256 expOffset, bool link) external {
        calls["create"]++;
        uint256 spk = senderPks[actorSeed % 3];
        uint256 rpk = recipientPks[recipSeed % 3];
        amount = bound(amount, 1, 600e6); // above-cap values exercise the cap (and revert)
        expOffset = bound(expOffset, 1 days, 30 days);
        uint256 ckPk = claimKeyPks[recipSeed % 2];
        bytes32 rsalt = bytes32(uint256(rpk));
        IEverpieceEscrow.PaymentIntent memory i = IEverpieceEscrow.PaymentIntent({
            sender: vm.addr(spk),
            mode: link ? 2 : 1,
            recipientCommitment: link
                ? escrow.recipientCommitmentOf(2, vm.addr(ckPk), rsalt)
                : escrow.recipientCommitmentOf(1, vm.addr(rpk), rsalt),
            metadataCommitment: _next(),
            approver: link ? escrow.claimApprover() : address(0),
            amount: amount,
            expiresAt: block.timestamp + expOffset,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            salt: _next()
        });
        bytes32 pid = escrow.paymentIdOf(i);
        bytes32 d = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ausd.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RWA_TYPEHASH, i.sender, address(escrow), amount, 0, i.validBefore, pid))
            )
        );
        bytes32 id = escrow.createPayment(i, _sig(spk, d));
        ids.push(id);
        ghostAmount[id] = amount;
        ghostSender[id] = i.sender;
        ghostApprover[id] = i.approver;
        ghostApproverPk[id] = link ? approverPks[currentApproverIdx] : 0;
        ghostRecipientPk[id] = rpk;
        ghostClaimKeyPk[id] = link ? ckPk : 0;
        ghostMode[id] = i.mode;
        ghostFunded += amount;
    }

    function claimUsername(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok || ghostMode[id] != 1) return;
        calls["claimUsername"]++;
        uint256 rpk = ghostRecipientPk[id];
        address r = vm.addr(rpk);
        bytes32 n = _next();
        uint256 dl = block.timestamp + 1 hours;
        escrow.claimUsernamePayment(id, r, bytes32(rpk), n, dl, _sig(rpk, escrow.hashClaimIntent(id, r, n, dl)));
        ghostTerminal[id] = IEverpieceEscrow.Status.CLAIMED;
        ghostClaimed += ghostAmount[id];
    }

    function claimLink(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok || ghostMode[id] != 2) return;
        calls["claimLink"]++;
        uint256 rpk = ghostRecipientPk[id];
        uint256 ckPk = ghostClaimKeyPk[id];
        address r = vm.addr(rpk);
        bytes32 n = _next();
        bytes32 an = _next();
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory ckSig = _sig(ckPk, escrow.hashLinkClaimIntent(id, r, n, dl));
        bytes memory apSig = _sig(ghostApproverPk[id], escrow.hashClaimApproval(id, r, an, dl));
        escrow.claimLinkPayment(id, r, vm.addr(ckPk), bytes32(rpk), n, dl, ckSig, an, dl, apSig);
        ghostTerminal[id] = IEverpieceEscrow.Status.CLAIMED;
        ghostClaimed += ghostAmount[id];
    }

    /// Cancel must succeed for every ACTIVE, unexpired payment — paused or not (I24).
    function cancel(uint256 seed) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        IEverpieceEscrow.Payment memory p = escrow.getPayment(id);
        if (p.status != IEverpieceEscrow.Status.ACTIVE || block.timestamp >= p.expiresAt) return;
        calls["cancel"]++;
        uint256 spk;
        for (uint256 k; k < 3; ++k) {
            if (vm.addr(senderPks[k]) == p.sender) spk = senderPks[k];
        }
        bytes32 n = _next();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sig(spk, escrow.hashCancelIntent(id, p.sender, n, dl));
        try escrow.cancel(id, n, dl, s) {
            ghostTerminal[id] = IEverpieceEscrow.Status.CANCELLED;
            ghostReturned += ghostAmount[id];
        } catch {
            cancelBlocked++;
        }
    }

    /// Refund must succeed for every ACTIVE, expired payment — paused or not (I24).
    function refund(uint256 seed, address caller) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        IEverpieceEscrow.Payment memory p = escrow.getPayment(id);
        if (p.status != IEverpieceEscrow.Status.ACTIVE || block.timestamp < p.expiresAt) return;
        calls["refund"]++;
        vm.prank(caller);
        try escrow.refundExpired(id) {
            ghostTerminal[id] = IEverpieceEscrow.Status.REFUNDED;
            ghostReturned += ghostAmount[id];
        } catch {
            refundBlocked++;
        }
    }

    /// An attacker (own keys, arbitrary reveal) must never be able to claim anything.
    function attackerClaim(uint256 seed, bool link, uint256 approverChoice) external {
        (bytes32 id, bool ok) = _pick(seed);
        if (!ok) return;
        calls["attack"]++;
        address a = vm.addr(ATTACKER_PK);
        bytes32 n = _next();
        uint256 dl = block.timestamp + 1 hours;
        if (!link) {
            try escrow.claimUsernamePayment(id, a, bytes32(uint256(ATTACKER_PK)), n, dl, _sig(ATTACKER_PK, escrow.hashClaimIntent(id, a, n, dl))) {
                attackerSuccesses++;
            } catch {}
        } else {
            // attacker has a REAL approval (compromised approver) but not the link key
            uint256 apk = approverChoice % 2 == 0 ? ghostApproverPk[id] : ATTACKER_PK;
            if (apk == 0) apk = ATTACKER_PK;
            bytes memory ap = _sig(apk, escrow.hashClaimApproval(id, a, n, dl));
            bytes memory ck = _sig(ATTACKER_PK, escrow.hashLinkClaimIntent(id, a, n, dl));
            try escrow.claimLinkPayment(id, a, vm.addr(ATTACKER_PK), bytes32(0), n, dl, ck, n, dl, ap) {
                attackerSuccesses++;
            } catch {}
        }
    }

    function warp(uint256 dt) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(dt, 0, 10 days));
    }

    /// Unpauses whenever paused; pauses only 1 in 4 calls, so runs spend most time live but still hit pause.
    function togglePause(uint256 seed) external {
        bool isPaused = escrow.paused(); // read BEFORE prank: a view call would consume the prank
        if (!isPaused && seed % 4 != 0) return;
        calls["pause"]++;
        vm.prank(owner);
        if (isPaused) escrow.unpause();
        else escrow.pause();
    }

    function setCaps(uint256 a, uint256 b, uint256 seed) external {
        if (seed % 4 != 0) return;
        calls["caps"]++;
        vm.prank(owner);
        escrow.setCaps(bound(a, 0, 600e6), bound(b, 0, 6_000e6)); // above-ceiling values must revert
    }

    function rotateApprover() external {
        calls["rotate"]++;
        currentApproverIdx = 1 - currentApproverIdx;
        vm.prank(owner);
        escrow.setClaimApprover(vm.addr(approverPks[currentApproverIdx]));
    }

    function donate(uint256 amount) external {
        calls["donate"]++;
        amount = bound(amount, 1, 1_000e6);
        ausd.mint(address(escrow), amount);
        ghostDonated += amount;
        ghostMinted += amount;
    }
}
