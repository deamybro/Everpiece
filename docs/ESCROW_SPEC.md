# ESCROW_SPEC.md — EverpieceEscrow (v0.2, reconciled)

Status: **Reconciled with full MASTER PROMPT v3.2 and Maris decisions D1–D10 (2026-09-29). Maris GO given 2026-09-29. Implemented in `contracts/src/EverpieceEscrow.sol` (branch `feat/escrow-v1`). Implementation notes and deviations: §22. Codex adversarial review pending. Not deployed.**
External facts: `VERIFIED.md`. Attacks: `THREAT_MODEL.md`. Evidence: `evidence/milestone1/`.
Items still needing Maris confirmation are marked **[CONFIRM]**.

Changes from v0.1 are listed in §21.

---

## 1. Scope

One small, **non-upgradeable** contract, `EverpieceEscrow`, holding **AUSD only** (immutable token address) on Monad mainnet (chain 143).

Operations (master §6):
`createPayment` · `claimUsernamePayment` · `claimLinkPayment` · `cancel` · `refundExpired`

Not in the escrow (master §6.1): usernames, phones, emails, bank data, voice files/URLs, SMS, stock execution, payout, Ramp, Aurora, Unlink, CRE, AI, analytics.
Everything after claim (Keep / Cash out / Own a Piece / Split) is a separate recipient-signed action outside the escrow (master §1.6, D1).

---

## 2. Roles

| Role | Holder | Can | Cannot |
|---|---|---|---|
| Sender | Mera EOA | Sign funding authorization; sign cancel (before expiry) | Claim (unless they are the committed/verified recipient via the normal path); redirect a refund |
| Username recipient | Mera EOA committed at create | Sign claim | Change amount / expiry / destination (funds go only to itself) |
| Link claim key | Random secp256k1 key in the link fragment | Co-sign a link claim | Claim alone |
| Claim approver | Everpiece server identity (KMS target), **snapshotted per payment** | Co-sign a link claim after recipient verification | Claim alone; transfer; cancel; change amount; redirect a signed approval |
| Relayer | Everpiece MON-holding EOA(s) | Submit allow-listed signed actions; pay gas | Alter any signed field; move AUSD |
| Anyone | — | Submit signed actions; `refundExpired` | Choose any beneficiary |
| Owner | Address controlled by Maris for canaries (D8); multisig later | pause, unpause, lower/restore caps within V1 ceilings, set the approver for **new** LINK payments, 2-step ownership transfer | Move/withdraw AUSD; modify any payment; block cancel/refund; raise caps above ceilings; upgrade |
| AUSD issuer (Agora) | External | Freeze, burn-from, pause, upgrade AUSD | — outside our control (THREAT_MODEL §H) |

**Submission is permissionless**: every mutating function is safe regardless of `msg.sender`; the relayer is trusted only for liveness. The relayer's method allow-list is an off-chain abuse control, not a safety mechanism.

Approver, relayer, deployer and owner **must be different keys** (master §14).

---

## 3. Commitments

All tags are `keccak256` of an ASCII label; the label's `v1` suffix is the schema version.

### 3.1 Recipient commitment — versioned, salted (master §10.1)
```
TAG_RECIPIENT_V1   = keccak256("everpiece.recipient.v1")
recipientCommitment = keccak256(abi.encode(TAG_RECIPIENT_V1, uint8 mode, address account, bytes32 recipientSalt))
```
- USERNAME (`mode = 1`): `account` = recipient's Mera EVM account.
- LINK (`mode = 2`): `account` = address of the link **claim key**.
- `recipientSalt`: 32 random bytes chosen by the sender's client (`crypto.getRandomValues`). It is **not a security secret**. It hides the recipient from chain observers until claim.
  - USERNAME: the server stores it with the payment record and returns it to the recipient's client.
  - LINK: it travels in the link fragment package (§4).
- If the salt is lost, the payment cannot be claimed. The sender cancels, or it refunds at expiry.

### 3.2 Metadata commitment (master §25)
```
TAG_METADATA_V1    = keccak256("everpiece.metadata.v1")
metadataCommitment = keccak256(abi.encode(TAG_METADATA_V1, bytes32 envelopeHash, bytes32 metadataSalt))
                   | bytes32(0)  when there is no message/voice
envelopeHash       = keccak256(canonical metadata envelope bytes)
```
It never holds plaintext, usernames, phone numbers, emails, storage URLs or keys. The contract treats this value as opaque.

**Link-message envelope v1** (`packages/shared/src/voice.ts`; pinned vector and a node:crypto re-derivation in `test/voice.test.ts`). The envelope **is** the stored ciphertext object, so `envelopeHash` commits to the exact bytes the recipient downloads:
```
envelope   = 0x01 ‖ audioType u8 (0 none · 1 audio/webm · 2 audio/mp4 · 3 audio/ogg) ‖ durationMs u32 BE (≤ 30000; 0 iff none)
             ‖ iv (12 random bytes) ‖ AES-256-GCM(key, iv, aad = envelope[0..6), plaintext)        ≤ 1 MiB
plaintext  = noteLen u16 BE ‖ note (UTF-8, ≤ 200 chars / 800 bytes) ‖ audio bytes
key        = HKDF-SHA256(voiceRootSecret, salt ∅, info "everpiece.link.voice.v1.key", 32)
locator    = HKDF-SHA256(voiceRootSecret, salt ∅, info "everpiece.link.voice.v1.locator", 32)        store address
metadataSalt = HKDF-SHA256(voiceRootSecret, salt ∅, info "everpiece.link.voice.v1.metadata-salt", 32)
```
The sender uploads before signing, so the intent commits to it. The recipient refuses any envelope whose commitment differs from the on-chain value, then GCM authenticates every byte. Username-mode messages need a recipient encryption key (THREAT_MODEL §K) and are not in v1.

---

## 4. Link client package (master §11.1–11.3)

Carried **only** in the URL fragment. Never sent to the server.
```
clientClaimPackage v1 = { version: 1,
                          claimPrivateKey: 32 bytes,   // generated by @noble/curves secp256k1 random-key API (audited); validated scalar
                          voiceRootSecret: 32 bytes,   // independent crypto.getRandomValues — NOT derived from claimPrivateKey
                          recipientSalt:   32 bytes }  // §3.1
```
- `claimPrivateKey` is used only to sign `LinkClaimIntent`.
- The message key, store locator and metadata salt are derived from `voiceRootSecret` with HKDF-SHA256 under separate labels (§3.2). They are never used for signing, and the claim key is never used for AES/MAC/wrapping.
- Byte encoding (base64url layout) and the exact noble API name: TODO(VERIFY) at the claim-links milestone (Oct 4), against the installed `@noble/curves` version.
- Recipient phone numbers are **not** committed on-chain in any form (master §12.3). The server alone links a payment to the phone it will send the OTP to.

---

## 5. Storage

```solidity
enum PaymentMode { NONE, USERNAME, LINK }                          // 0,1,2
enum Status      { NONE, ACTIVE, CLAIMED, CANCELLED, REFUNDED }    // 0..4 ; EXPIRED is derived (ACTIVE && now >= expiresAt)

struct Payment {
    address     sender;              // slot 0
    uint64      expiresAt;           // slot 0
    PaymentMode mode;                // slot 0
    Status      status;              // slot 0
    uint128     amount;              // slot 1   AUSD base units (6 dp)
    uint64      createdAt;           // slot 1
    address     approver;            // slot 2   LINK: snapshot of claimApprover at create; USERNAME: address(0)
    bytes32     recipientCommitment; // slot 3
    bytes32     metadataCommitment;  // slot 4
}

IERC20  public immutable AUSD;                    // constructor; mainnet must equal VERIFIED §2.1
uint256 public constant MAX_PAYMENT_CEILING   =   500_000000;   // $500   (D3)
uint256 public constant MAX_LIABILITY_CEILING = 5_000_000000;   // $5,000 (D3)
uint256 public constant MIN_EXPIRY = 1 days;                    // master §8 [CONFIRM]
uint256 public constant MAX_EXPIRY = 30 days;                   // master §8 [CONFIRM]

mapping(bytes32 paymentId => Payment) public payments;
mapping(address signer => mapping(bytes32 nonce => bool)) public usedNonces;  // master §15.2
uint256 public totalActiveLiability;
uint256 public maxPaymentAmount;       // initialised to MAX_PAYMENT_CEILING
uint256 public maxActiveLiability;     // initialised to MAX_LIABILITY_CEILING
address public claimApprover;          // approver applied to NEW link payments (D4)
bool    public paused;
// owner via OpenZeppelin Ownable2Step
```

---

## 6. EIP-712

### 6.1 Domain
```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name = "Everpiece Escrow"   version = "1"   chainId = block.chainid (143)   verifyingContract = address(this)
```
Use OpenZeppelin `EIP712`. It recomputes the domain if `block.chainid` changes.

### 6.2 Types
```
PaymentIntent(address sender,uint8 mode,bytes32 recipientCommitment,bytes32 metadataCommitment,address approver,uint256 amount,uint256 expiresAt,uint256 validAfter,uint256 validBefore,bytes32 salt)
ClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)          // signer: username recipient
LinkClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)      // signer: link claim key
ClaimApproval(bytes32 paymentId,address recipient,bytes32 approvalNonce,uint256 deadline)      // signer: snapshot approver
CancelIntent(bytes32 paymentId,address sender,bytes32 actionNonce,uint256 deadline)            // signer: sender
```
There are four distinct typehashes. A signature for one role can never verify as another (vector V_L6).

### 6.3 Payment ID
```
paymentId = keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(PaymentIntent))    // = EIP-712 digest
```
Payment IDs are public (master §6.3). Security never depends on their unpredictability.

**Required preimage coverage (D5):**

| D5 requirement | Where it is bound |
|---|---|
| schema/version identifier | `PAYMENT_INTENT_TYPEHASH` (type string) + domain `version = "1"` (V_N10 shows a version change → new ID) |
| Monad chain ID | domain `chainId` (V_N8) |
| EverpieceEscrow address | domain `verifyingContract` (V_N9) |
| sender | `sender` |
| AUSD amount | `amount` (V_N1) |
| payment mode | `mode` (V_N5) |
| recipient commitment | `recipientCommitment` (V_N3) |
| metadata commitment | `metadataCommitment` (V_N4) |
| expiresAt | `expiresAt` (V_N2) |
| ERC-3009 validity bounds | `validAfter`, `validBefore` (V_N11) |
| random sender salt | `salt` (32 bytes, `crypto.getRandomValues`) (V_N6) |
| approver snapshot (D4) | `approver` (V_N7) |

### 6.4 Signature rules (escrow-verified signatures)
- OpenZeppelin `ECDSA.recover` (65-byte `r‖s‖v`; rejects high-s and bad `v`; reverts on malformed). **EOA only** — Mera accounts are EOAs (VERIFIED §3.4). No ERC-1271 for claim/cancel/approval in V1.
- Recovered signer ≠ `address(0)` and equals the role address.
- `deadline`: valid iff `block.timestamp <= deadline`.

### 6.5 Nonce model (master §15.2)
- Every claim/cancel/approval carries a random `bytes32` nonce. After a successful action, `usedNonces[signer][nonce] = true` and `NonceUsed(signer, nonce)` is emitted. A nonce already used by that signer reverts `NonceAlreadyUsed`.
- `PaymentIntent.salt` is the payment's action nonce. It is consumed through AUSD's ERC-3009 nonce map (`authorizationState(sender, paymentId)`) and through `payments[paymentId].status != NONE`. The escrow does not also write `usedNonces[sender][salt]`.
- Nonces are defense in depth plus relayer idempotency keys. The one-shot payment state machine already makes every claim/cancel signature single-use.

---

## 7. Funding — single AUSD signature (D5 approved conditionally; conditions met)

### 7.1 What the sender signs
Exactly one EIP-712 message in the **AUSD** domain (`"Agora Dollar"`, `"1"`, 143, AUSD address — VERIFIED §2.4):
```
ReceiveWithAuthorization(from = intent.sender, to = EverpieceEscrow, value = intent.amount,
                         validAfter = intent.validAfter, validBefore = intent.validBefore, nonce = paymentId)
```
There is **no** separate Everpiece signature over the PaymentIntent (D5: no symmetry-only signature).

### 7.2 How the contract enforces D5's five equalities
The relayer supplies only `(PaymentIntent, signature bytes)`. **The contract computes every ERC-3009 argument from the intent; the caller does not supply them.**

| D5 requirement | Enforcement |
|---|---|
| `auth.from == payment sender` | contract passes `intent.sender` as `from`; the Payment stores the same `intent.sender` |
| `auth.to == EverpieceEscrow` | contract passes `address(this)`; AUSD additionally requires `to == msg.sender` (VERIFIED §2.5) |
| `auth.value == payment amount` | contract passes `intent.amount`; stores the same; then requires `balanceAfter - balanceBefore == amount` |
| `auth.nonce == expected payment id` | contract recomputes `paymentId` from the intent and passes it as `nonce` |
| validity / deadline | contract checks `validAfter < block.timestamp < validBefore` itself (own errors), then AUSD re-checks identically |

AUSD verifies the sender's signature over exactly those six values. Changing **any** intent field changes `paymentId` (and possibly `value`/validity), so the signature fails (`InvalidSignature`).
Evidence: vectors V_N1–V_N11, and the live-AUSD fork test of V_U3 under Monad rules (`evidence/milestone1`).

### 7.3 Why only the escrow can use the authorization
- AUSD `receiveWithAuthorization` requires `to == msg.sender` → only `address(this)` can consume it.
- A `ReceiveWithAuthorization` signature is invalid as `TransferWithAuthorization` (distinct typehash; fork-tested).
- `cancelAuthorization` can be called only with the sender's own signature, and only hurts the sender's own pending funding.

### 7.4 Proposed AUSD-upgrade guard (engineering; Codex please review)
The proxy's inline `receiveWithAuthorization` changes behavior **only** if Agora sets the `isReceiveWithAuthorizationUpgraded` flag (VERIFIED §2.3). If that flag is set, the payee check might disappear. A griefer could then consume a sender's authorization directly on AUSD, sending funds to the escrow with **no payment record**. Those funds would be stranded, because there is no sweep (master §7.3).
Proposal: `createPayment` reverts `AusdSemanticsChanged` when `AUSD.isReceiveWithAuthorizationUpgraded()` returns true (or the call reverts). This is fail-safe: new payments halt until reviewed; existing payments are unaffected. The flag is observable on a fork (evidence test `test_receive_upgraded_flag_observable`).

### 7.5 ERC-2612 fallback
Verified to exist (VERIFIED §2.8) but **not implemented in V1**: it needs two signatures, the permit can be front-run, and it adds code. ERC-3009 behaves exactly as tested.

---

## 8. State machine

```
                    createPayment
   NONE ──────────────────────────────▶ ACTIVE
                                          │
        claimUsernamePayment / claimLinkPayment   (now < expiresAt, not paused)  ──▶ CLAIMED   → recipient
        cancel (sender sig)                        (now < expiresAt, pause-proof) ──▶ CANCELLED → sender
        refundExpired (anyone)                     (now >= expiresAt, pause-proof) ─▶ REFUNDED  → sender
```
Terminal states are final. `EXPIRED` = `ACTIVE && block.timestamp >= expiresAt` (derived; master §6.2).

### 8.1 Exact boundaries (master §8)
| Action | Allowed iff |
|---|---|
| claim (both modes) | `block.timestamp < expiresAt` |
| cancel | `block.timestamp < expiresAt` |
| refundExpired | `block.timestamp >= expiresAt` |
| create | `block.timestamp + MIN_EXPIRY <= expiresAt <= block.timestamp + MAX_EXPIRY` and `validBefore <= expiresAt` |

- At `expiresAt − 1`: claim ✔, cancel ✔, refund ✘. At `expiresAt`: claim ✘, cancel ✘, refund ✔. At `expiresAt + 1`: refund ✔.
- `MIN_EXPIRY = 1 day`, `MAX_EXPIRY = 30 days`, UX default 30 days — master §8 proposal. **[CONFIRM]** before contract freeze. v0.1's 1 h / 90 d and "cancel after expiry" are withdrawn.
- The UI must build `expiresAt` with a margin, because it is checked against the execution timestamp, not the signing time.

### 8.2 Claim/cancel race (master §9)
Whichever executes first wins. The other reverts `PaymentNotActive`. Backend timestamps have no authority.

### 8.3 Money after claim
The claim transfers AUSD to the recipient's own account. Any later movement (cash-out, Piece, split) is a separate recipient-signed action (D1).

---

## 9. External functions

```solidity
function createPayment(PaymentIntent calldata intent, bytes calldata ausdSignature) external returns (bytes32 paymentId);

function claimUsernamePayment(bytes32 paymentId, address recipient, bytes32 recipientSalt,
                              bytes32 actionNonce, uint256 deadline, bytes calldata recipientSig) external;

function claimLinkPayment(bytes32 paymentId, address recipient, address claimKey, bytes32 recipientSalt,
                          bytes32 actionNonce, uint256 deadline, bytes calldata claimKeySig,
                          bytes32 approvalNonce, uint256 approvalDeadline, bytes calldata approverSig) external;

function cancel(bytes32 paymentId, bytes32 actionNonce, uint256 deadline, bytes calldata senderSig) external;

function refundExpired(bytes32 paymentId) external;

// views for frontend / relayer / server hash parity
function paymentIdOf(PaymentIntent calldata intent) external view returns (bytes32);
function recipientCommitmentOf(uint8 mode, address account, bytes32 salt) external pure returns (bytes32);
function hashClaimIntent(bytes32, address, bytes32, uint256) external view returns (bytes32);
function hashLinkClaimIntent(bytes32, address, bytes32, uint256) external view returns (bytes32);
function hashClaimApproval(bytes32, address, bytes32, uint256) external view returns (bytes32);
function hashCancelIntent(bytes32, address, bytes32, uint256) external view returns (bytes32);
function getPayment(bytes32) external view returns (Payment memory);
function isExpired(bytes32) external view returns (bool);

// owner only
function pause() external;
function unpause() external;
function setCaps(uint256 newMaxPayment, uint256 newMaxActiveLiability) external;  // each ≤ its ceiling
function setClaimApprover(address newApprover) external;                           // ≠ 0; affects NEW link payments only
// Ownable2Step: transferOwnership / acceptOwnership  (renounceOwnership disabled — would freeze pause/caps forever)
```
All mutating functions are `nonReentrant`. They follow validate → effects (status, liability, nonces) → interaction (AUSD) → post-check (balance delta) → event. SafeERC20 `safeTransfer` for outflows (master §18). Any AUSD revert reverts the whole action (master §5.2).

### 9.1 `createPayment`
1. `!paused` → `EnforcedPause`
2. `mode ∈ {USERNAME, LINK}` → `InvalidMode`
3. `sender ∉ {0, address(this)}` → `InvalidSender`
4. `0 < amount <= maxPaymentAmount` → `ZeroAmount` / `AmountAboveCap`
5. `totalActiveLiability + amount <= maxActiveLiability` → `LiabilityCapExceeded`
6. expiry bounds and `validBefore <= expiresAt` (§8.1) → `ExpiryOutOfRange`
7. `validAfter < block.timestamp < validBefore` → `AuthorizationNotYetValid` / `AuthorizationExpired`
8. `recipientCommitment != 0` → `InvalidRecipientCommitment`
9. approver: USERNAME → `intent.approver == address(0)`; LINK → `intent.approver == claimApprover` → `ApproverMismatch`
10. `!AUSD.isReceiveWithAuthorizationUpgraded()` → `AusdSemanticsChanged` (§7.4, proposed)
11. `paymentId = paymentIdOf(intent)`; `payments[paymentId].status == NONE` → `PaymentExists`
12. Effects: store Payment (ACTIVE, `approver` snapshot, `createdAt = block.timestamp`); `totalActiveLiability += amount`
13. Interaction: `AUSD.receiveWithAuthorization(sender, address(this), amount, validAfter, validBefore, paymentId, ausdSignature)`
14. `balanceOf(this)` increased by exactly `amount` → `FundingMismatch`
15. emit `PaymentCreated`

### 9.2 `claimUsernamePayment`
`!paused` · status ACTIVE (`PaymentNotActive`) · mode USERNAME (`WrongMode`) · `now < expiresAt` (`PaymentExpired`) · `now <= deadline` (`SignatureExpired`) · `recipientCommitmentOf(1, recipient, recipientSalt) == p.recipientCommitment` (`RecipientMismatch`) · `recover(ClaimIntent(paymentId, recipient, actionNonce, deadline)) == recipient` (`InvalidRecipientSignature`) · nonce unused → consume · status CLAIMED · `totalActiveLiability -= amount` · `safeTransfer(recipient, amount)` · balance decreased by exactly `amount` (`PayoutMismatch`) · emit.
The sender has no special path. A sender claim fails `RecipientMismatch` or `InvalidRecipientSignature` unless the sender *is* the committed recipient (master §10.4, D1; vector V_U5).

### 9.3 `claimLinkPayment`
`!paused` · ACTIVE · mode LINK · `now < expiresAt` · `recipient ∉ {0, address(this)}` (`InvalidRecipient`) · `recipientCommitmentOf(2, claimKey, recipientSalt) == p.recipientCommitment` (`LinkRevealMismatch`) ·
**factor A:** `now <= deadline` and `recover(LinkClaimIntent(paymentId, recipient, actionNonce, deadline)) == claimKey` (`InvalidClaimKeySignature`) ·
**factor B:** `now <= approvalDeadline` and `recover(ClaimApproval(paymentId, recipient, approvalNonce, approvalDeadline)) == p.approver` (`InvalidApproverSignature`) — **the snapshot, not the current `claimApprover`** (D4) ·
consume both nonces (`usedNonces[claimKey][actionNonce]`, `usedNonces[p.approver][approvalNonce]`) · CLAIMED · transfer to `recipient` · emit.
Both factors bind the same `recipient`, so an approval for Mama cannot be redirected to Stella (V_L7). A sender who designated and verified themselves passes the same path legitimately (master §11.5).

### 9.4 `cancel`
ACTIVE · `now < expiresAt` (`PaymentExpired`) · `now <= deadline` · `recover(CancelIntent(paymentId, p.sender, actionNonce, deadline)) == p.sender` (`InvalidSenderSignature`) · consume nonce · CANCELLED · transfer to `p.sender` · emit. **Works while paused.**

### 9.5 `refundExpired`
ACTIVE · `now >= expiresAt` (`PaymentNotExpired`) · REFUNDED · transfer to `p.sender` · emit. Permissionless; the caller chooses nothing. **Works while paused.**

---

## 10. Pause (D2, master §19.1)

| While paused | |
|---|---|
| createPayment | BLOCKED |
| claimUsernamePayment / claimLinkPayment | BLOCKED |
| cancel | **ALLOWED** |
| refundExpired | **ALLOWED** |

- Pause never extends expiry. A payment that expires while paused refunds to its sender.
- There is no mechanism, pause or otherwise, that can keep sender funds from going back to the sender (issuer controls excepted, THREAT_MODEL §H).
- Owner only. No separate pauser role in V1 (minimal owner surface, D8).

## 11. Caps (D3)

- Ceilings are constants: `MAX_PAYMENT_CEILING = 500e6` ($500), `MAX_LIABILITY_CEILING = 5,000e6` ($5,000).
- Both caps start at the ceilings. `setCaps` accepts any values `≤` their ceilings (it can lower, then restore up to the ceiling, never above). Otherwise it reverts `CapAboveCeiling`.
- Caps are checked only at create. Changing them never affects existing payments.
- Canary payments are about $10. The relayer may enforce an application-level minimum and daily limits (master §21, §26.3). On-chain minimum is `amount > 0`.

## 12. Claim approver rotation (D4)

- `claimApprover` is configured by the owner. `createPayment` for LINK requires `intent.approver == claimApprover`, and stores it in `Payment.approver`.
- `setClaimApprover` affects **only payments created afterwards**. Existing ACTIVE link payments keep requiring their snapshotted approver.
- If an old approver key is retired or lost, its payments can still be cancelled or refunded. They are claimable only if that key can still sign. **Operational rule:** keep retired approver keys usable until every payment snapshotted to them is terminal (≤ 30 days).
- Because the sender's funding signature covers `approver`, a surprise rotation between signing and submission makes creation revert (`ApproverMismatch`) instead of silently changing who guards the funds.

## 13. Admin limitations

The owner **cannot**: withdraw/rescue/sweep AUSD (no `withdrawAUSD`, `emergencyWithdrawAUSD`, `rescueAUSD` — master §7.3); rewrite recipient, amount, expiry, sender, mode, approver or status of any payment; change the token; raise caps above V1 ceilings; block cancel or refund; upgrade (no proxy).
AUSD sent to the escrow by mistake stays stranded in V1. This is documented, not rescuable.
**Owner-key compromise impact:** pause/unpause griefing, lowering caps, and pointing *new* link payments at a malicious approver. That still cannot claim without the link claim key, and the client should pin the expected approver address. Pending funds cannot be taken.

---

## 14. Events

```solidity
event PaymentCreated(bytes32 indexed paymentId, address indexed sender, bytes32 indexed recipientCommitment,
                     uint8 mode, bytes32 metadataCommitment, address approver, uint256 amount, uint64 expiresAt);
event PaymentClaimed(bytes32 indexed paymentId, address indexed recipient, uint256 amount);
event PaymentCancelled(bytes32 indexed paymentId, address indexed sender, uint256 amount);
event PaymentRefunded(bytes32 indexed paymentId, address indexed sender, uint256 amount, address caller);
event NonceUsed(address indexed signer, bytes32 indexed nonce);
event CapsUpdated(uint256 maxPaymentAmount, uint256 maxActiveLiability);
event ClaimApproverUpdated(address indexed previousApprover, address indexed newApprover);
// OZ Pausable: Paused(address), Unpaused(address); OZ Ownable2Step events
```
Envio indexes `PaymentCreated/Claimed/Cancelled/Refunded` (master §29).

## 15. Custom errors

```
EnforcedPause, InvalidMode, InvalidSender, ZeroAmount, AmountAboveCap, LiabilityCapExceeded, ExpiryOutOfRange,
AuthorizationNotYetValid, AuthorizationExpired, InvalidRecipientCommitment, ApproverMismatch, AusdSemanticsChanged,
PaymentExists, PaymentNotActive, WrongMode, PaymentExpired, PaymentNotExpired, SignatureExpired, NonceAlreadyUsed,
InvalidRecipient, RecipientMismatch, LinkRevealMismatch, InvalidRecipientSignature, InvalidClaimKeySignature,
InvalidApproverSignature, InvalidSenderSignature, FundingMismatch, PayoutMismatch, CapAboveCeiling, ZeroAddress,
RenounceDisabled
```

---

## 16. Invariants

Master §20 (all mandatory), mapped to mechanisms:

| # | Invariant | Mechanism |
|---|---|---|
| 1–3 | claims / cancels / refunds at most once | status must be ACTIVE; terminal is final |
| 4 | terminal state cannot transition | same |
| 5–7 | claim/cancel/refund mutually exclusive | same |
| 8 | username claimant = authorized recipient | commitment opening + recipient signature |
| 9 | link claimant needs both factors | claim-key sig AND snapshot-approver sig |
| 10 | expired payment cannot claim | `now < expiresAt` |
| 11 | expired payment cannot cancel | `now < expiresAt` |
| 12 | refund beneficiary = original sender | hard-coded `p.sender` |
| 13–15 | relayer cannot alter recipient / amount / expiry | all bound in signatures / paymentId |
| 16 | used action nonce cannot replay | `usedNonces` + one-shot status |
| 17 | expired signed intent fails | `deadline`, `validBefore` |
| 18–19 | cross-chain / cross-contract replay fails | EIP-712 domain in paymentId and all intents |
| 20 | liability decreases exactly once per terminal transition | single decrement in each terminal path |
| 21 | `AUSD.balanceOf(escrow) >= totalActiveLiability` | delta checks; no admin outflow (can be broken only by issuer burn, THREAT_MODEL §H2) |
| 22 | `totalActiveLiability == Σ amount(ACTIVE)` | ± at create / terminal |
| 23 | admin cannot seize liability | no admin transfer path |
| 24 | pause cannot block cancel/refund | `whenNotPaused` only on create + claims |
| 25 | payment cap cannot be bypassed | checked in the only create path |
| 26 | unsupported token cannot fund V1 | immutable AUSD; only AUSD calls |
| 27 | malformed signature fails | OZ ECDSA reverts |
| 28 | failed AUSD transfer cannot create false state | whole-tx revert + delta checks |
| 29 | link key alone cannot claim | factor B required |
| 30 | approval alone cannot claim | factor A required |

Additional:

| # | Invariant |
|---|---|
| 31 | Every ERC-3009 argument is derived from the stored intent (§7.2) |
| 32 | `Payment.approver` never changes after create |
| 33 | `maxPaymentAmount ≤ 500e6` and `maxActiveLiability ≤ 5,000e6` always |

---

## 17. Application / relayer confirmation rule (D9)

> **TRANSACTION INCLUSION IS NOT APPLICATION SUCCESS.**

Monad reaches consensus on a block before executing it (VERIFIED §1.10). An included transaction can still revert, and it still pays its full gas limit.

Off-chain request states (relayer DB + UI):

| State | Meaning | UI copy (examples) |
|---|---|---|
| `SUBMITTED` | signed request accepted, validated, simulated, broadcast | "Sending…" |
| `PROCESSING` | tx hash known / included; execution result not yet confirmed | "Protecting your payment…" |
| `CONFIRMED_*` → display **Sent / Claimed / Cancelled / Money returned** | see rule below | final copy |
| `FAILED` | receipt status 0, dropped, or expected event absent | "Your money is still protected. Try again." / "Funding didn't complete. No payment was created." |

**Success requires all of:**
1. The receipt exists with `status == 1`.
2. The receipt contains the expected escrow event: `PaymentCreated`, `PaymentClaimed`, `PaymentCancelled` or `PaymentRefunded`, emitted by the escrow address, with the expected `paymentId` (and `recipient`/`sender`/`amount`).
3. `getPayment(paymentId).status` read at or after the receipt's block equals the expected state.
4. The block has reached Monad finality (`receipt.blockNumber <= "finalized"` height, ≈ 2 blocks / 600 ms; VERIFIED §1.8, §1.14) before the terminal UI state and before any off-chain side effect (notifications, payout hand-off).

On failure or revert, show failure and **reconcile to the canonical chain state** (`getPayment`). The backend never overrides chain truth (master §30, §38).
Envio / history show only **executed** events from finalized blocks. Events are execution outputs and never appear for included-but-reverted transactions. The indexer must still follow finality.
Resolved (VERIFIED §1.14): Monad `"latest"` = Proposed (speculative), `"safe"` = Voted, `"finalized"` = Finalized. Rule 4 means `receipt.blockNumber <= eth_getBlockByNumber("finalized").number`, and the step-3 `getPayment` read uses `"finalized"`. A receipt returned by `eth_sendRawTransactionSync` is only PROCESSING until that holds.

---

## 18. Test vectors (v0.2)

Generated by `evidence/milestone1/vectors/vectors.sh` (cast, manual ABI encoding). **Independently re-derived** in Solidity (`evidence/.../Vectors.t.sol`, Foundry 1.8.3, `network = "monad"`). PaymentIntent digest **cross-checked** with cast's EIP-712 typed-data encoder. **V_U3 accepted by live AUSD** on a mainnet fork. Signatures are RFC 6979 deterministic, 65-byte `r‖s‖v`, low-s.
Test keys (never fund): sender = 1, recipient (Mama) = 2, approver = 3, claim key = 4, approver₂ = 5.

### 18.1 Fixed inputs
```
chainId 143 · escrow (vector address) 0x1111111111111111111111111111111111111111 · AUSD 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a
sender     0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf      recipient 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF
approver   0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69      claimKey  0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718
approver₂  0xe1AB8145F7E55DC933d51a18c793F901A3A0b276      Stella    0x000000000000000000000000000000000000057e
amount 200000000 ($200) · expiresAt 1793232000 (2026-10-29T00:00Z) · validAfter 0 · validBefore 1790726400 (2026-09-30T00:00Z)
deadline 1790812800 (2026-10-01T00:00Z) · actionNonces 0x…c1 (claim), 0x…c2 (cancel) · approvalNonce 0x…a1
envelope bytes "everpiece-test-ciphertext-envelope" (UTF-8) · metadataSalt 0x…0e7a11
```

### 18.2 Constants
```
TAG_RECIPIENT_V1            0x5392229aa2860a528ed83e7c508b93742c57496d8e98cc54442e51343b7c388c
TAG_METADATA_V1             0x42b8b2464acba27edf88b3b393a1a339eb078fe1002c27baa713b4bae7eb84bc
PAYMENT_INTENT_TYPEHASH     0xfe47d1ba0797dff165ffeb9757cb00f65209173109c218ae84dad516ea052126
CLAIM_INTENT_TYPEHASH       0x0a793245693c7d0b0e7cdef9d078cfa33a1db9e793f6f9e74ae60f8c30f90c56
LINK_CLAIM_INTENT_TYPEHASH  0x260181d054f3216afe276036306927af04bd2f74dc0dc63a589539f06bc4a39e
CLAIM_APPROVAL_TYPEHASH     0xd3e61339735cbf9f76131a9f5b4a49ea6c85e74741f2689fedb433f4f00a3a70
CANCEL_INTENT_TYPEHASH      0x91d2228050f5adf675ffe5c70058bbe89db877688aa727562c63a00a36d4f557
AUSD RWA TYPEHASH           0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
ESCROW_DOMAIN_SEPARATOR     0xe608be5ba2e4bf6fd034b6ddc6b1fd4528e68bc8fb00dca5a2a5a71d41ab8ef1   (0x1111…, 143, v1)
AUSD_DOMAIN_SEPARATOR       0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe
```

### 18.3 Metadata
```
V_META  envelopeHash       0x805dd477e1a58dbaec4375226839ebb08009817129be9bf16f3126850225b7ee
        metadataCommitment 0x89a8b682af29eb54acbd46d23eb107721daa4a7c56c9388508ce63eb0bef6b71
```

### 18.4 Username payment (recipientSalt 0x…05a170, salt 0x…a11c, approver 0x0)
```
V_U1 recipientCommitment = 0x8d13a219c826c93cbdb57e22a207584269b2cb9cbef7dc134a52bb130eab3666
V_U2 abi.encode(PAYMENT_INTENT_TYPEHASH, sender, 1, rc, meta, 0x0, amount, expiresAt, 0, validBefore, salt) =
     fe47d1ba0797dff165ffeb9757cb00f65209173109c218ae84dad516ea052126
     0000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf
     0000000000000000000000000000000000000000000000000000000000000001
     8d13a219c826c93cbdb57e22a207584269b2cb9cbef7dc134a52bb130eab3666
     89a8b682af29eb54acbd46d23eb107721daa4a7c56c9388508ce63eb0bef6b71
     0000000000000000000000000000000000000000000000000000000000000000
     000000000000000000000000000000000000000000000000000000000bebc200
     000000000000000000000000000000000000000000000000000000006ae28c80
     0000000000000000000000000000000000000000000000000000000000000000
     000000000000000000000000000000000000000000000000000000006abc5100
     000000000000000000000000000000000000000000000000000000000000a11c
     structHash = 0x8a564f5ab758c8033ecff93053c81ea864c7474687921923be28a558d3a93bf2
     paymentId  = 0x77d1bdd322d8c9e40a2d2d072d1aa2d5d978a5e431ffb534a7b96babe67b49d9
V_U3 AUSD ReceiveWithAuthorization(sender, escrow, amount, 0, validBefore, nonce = paymentId)
     digest = 0xb8348ee66967a948bdafc876cf0607b929745d0ecbfbf05b3550fecacf1d661d
     sender sig = 0x966aa3f51f76bcb22c3262a6e7c75d9025716b33df6665cd4e2f82219c001ebd7d3cbb4ee78850f17d9674842c84749d7e7294057de9000a0a3575295b3954d81b
     signer = sender ✔ · LIVE AUSD (fork, network=monad): ACCEPTED ✔
V_U4 ClaimIntent(paymentId, recipient, 0x…c1, deadline)
     digest = 0x07737606ac561f641901548b4be636e0e887c219ac7bb401c61adb68ab32758a
     recipient sig = 0x87b7136fed8919a13ee013929961c8fbad0fe29c9e9e0fc2eca61da7baf9f4cc27c8457a98638ecab7618088de62375a3cfeea1d78790679605c08068b7df5c91b
     signer = recipient ✔ · as sender ✘
V_U5 Unauthorized sender claim: sender signs ClaimIntent(paymentId, sender, 0x…c1, deadline)
     digest = 0x2f09c192f041e3a18213e2cac306851d11782b48dcd68f0348fc6a2f7f86cc4b
     sig = 0x8d6732884815ad2e47d9848b8f471f91103ea27cae789b86a8d54423df6a1a014b32fc38eac8d359892af6b64f32b6c126a371750cc38c7c1f7e79f8a74a38661c
     recipientCommitmentOf(1, sender, recipientSalt) == V_U1 ? ✘  → expected revert RecipientMismatch
V_U6 CancelIntent(paymentId, sender, 0x…c2, deadline)
     digest = 0x4e72444f81adbe458eccc2add891cb57a6090e8139358e3d2dd5d0b3ba6c0b79
     sender sig = 0x0ea398666bd0fdc411afbf5f10e24eb009d3937801d851539b668e554d56877b25a44552dc1175e2a7361c50b56380a7d981e4bdac53e317f5ee18e4b3b9b3461b
     signer = sender ✔
```
Negative vectors. One field changed each; the V_U3 signature must **not** verify against the resulting AUSD digest:
```
V_N1  amount 200000001      paymentId 0x6c29c7e2db086d5b35b3518737c4598fecb9fe90dc0943b672b70e35c5e18787  V_U3 sig ✘
V_N2  expiresAt +1          paymentId 0x46341c5bc36b5ac813b823f978f3dfb75d076f6b695be55bb7ad87624c98c63b  V_U3 sig ✘
V_N3  recipient → 0x…E7E0   paymentId 0x919e3c86c42a2dba9ac4e6e3cdf18fe7fffdd0f1f0caee4b5c0c666021cc0264  V_U3 sig ✘
V_N4  metadata → 0          paymentId 0x9519f9cc0ffe29ca99ba6608cae935a82fc1208e7429748f6209000febada2b7  V_U3 sig ✘
V_N5  mode → LINK           paymentId 0xfd3bfa3e4377949db71c50e46e253b24fb2bf469dbcbbd208aedffd6e2821f43  V_U3 sig ✘
V_N6  salt +1               paymentId 0x142a610a7e8e354a524e48c409c4d0aa3cb35f76c1598cada7e844c9aaa58ef2  V_U3 sig ✘
V_N7  approver → approver   paymentId 0x275e52ff52b6fcd9aa48a71feaf4faa41534ee8b63382c34d7254c62ddccb155  V_U3 sig ✘
V_N8  chainId 10143         paymentId 0x009198e0e61685de06557de1e5a1e58aaa279db0f11e0dc30bbcf6839f3e0519
V_N9  escrow 0x2222…        paymentId 0x828446145824bf5e5c68a916839f00634f1f0a3f119e1de94448c1c7202effaf
V_N10 domain version "2"    paymentId 0xcdf128253160f4e6cb62a908f3029e4f3f8912db4f498b21bf75583063a37fb5
V_N11 validBefore changed only in the AUSD call (intent unchanged)                                        V_U3 sig ✘
```

### 18.5 Link payment (claimKey = pk 4, recipientSalt 0x…011c0e, salt 0x…b0b0, approver = pk 3)
```
V_L1 recipientCommitment = 0x26ea19392d1d81ef455fe7887900a6ddbd6d59ad1ff87178dbe14363ab33f46c
V_L2 structHash = 0xb68c61833816e63573d511a6631a3459193ae29602421c1aa21e6a7a6431c20e
     paymentId  = 0x0f42b0913d79c00aea97d6fee27a3d0cdd1a655f30fd4a765c746f60ab9b878b
V_L3 AUSD digest = 0xdee64e5754ec9dc3fd64c8482184a3259010a844996a38409409485eb6bf30da
     sender sig  = 0xad1189451460b27c072393e7948d6fcecaf843cec92ff9dfaf41c00c1921d88c33701eb1471e5fe24d176c8a0a0db5fb5b58d9ea160c86bda92e3e6706d1e6ee1b
V_L4 LinkClaimIntent(paymentId, Mama, 0x…c1, deadline)  digest 0x9079548e888e050ea959986e674977d1cec6701d063c6f3f5b27bc1e39dd15d6
     claimKey sig = 0x7219a6b670e685585bdc25e96b5dcba7e1b9071f9216f5aa3cf4c44b90c39be957badb1dbce77f306931a6094265d5da387b9d96174fb99366a25f200b58f7fa1c  ✔
V_L5 ClaimApproval(paymentId, Mama, 0x…a1, deadline)    digest 0xf155fd12a9b337ca2687bd4eb0a31b743ed9d65d84e320d5790f31d33c53406f
     approver sig = 0xaaff9ed76e29b04b36cd3f2ceed233ed4899334b56d67cf822c58213f046ff1e1d74eae59224745a11bf3bebd83ccfaac850544706970adf20250566daae903b1c  ✔
V_L6 role separation: approver sig on LinkClaim digest ✘ · claimKey sig on Approval digest ✘
V_L7 redirect: Mama's approval checked as ClaimApproval(paymentId, Stella, 0x…a1, deadline) digest 0xcb1ff58e34b4a70af55c3ac4e7f1c87e0646cb129882e0750962a3065c855ca2 ✘
V_L8 rotation: approver₂ signing V_L5 digest does not verify as snapshot approver ✘
```

### 18.6 Account derivation — `EVERPIECE_ACCOUNT_V1` (D6)
Frozen recipe = Mera's documented "Create passkey accounts" recipe, byte-identical at tag `v0.2.0` and `main` (VERIFIED §3.4):
```
prfOutput (32 B, getPasskeyPrfOutput, default salt, rpId = production domain)
→ mnemonic = entropyToMnemonic(prfOutput, english)       (@scure/bip39; 24 words)
→ seed     = mnemonicToSeedSync(mnemonic)                 (no passphrase)
→ key      = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0").privateKey   (@scure/bip32; account index 0)
→ address  = getEvmAddress(createSecp256k1SigningSession({privateKey: key}).publicKey)
```
Fixtures are **synthetic**, never real PRF output. Three implementations agree: @scure 2.4.0, `cast wallet address --mnemonic` (Rust), and `@category-labs/mera@0.2.0 getEvmAddress`.
```
D1 prfOutput 0x00…00 (32 zero bytes)
   mnemonic  "abandon ×23 art"
   address   0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb
D2 prfOutput sha256("everpiece.test.prf-fixture.v1") = 0x8e820f75e2a9ae67d9f0d77e4ff045a362f944ae28c3a229ab8d8894e34d80d6
   mnemonic  "model away talent shed online crop guitar brain layer legend badge egg convince pelican reward blur peasant essence toddler bachelor evolve plug addict stairs"
   address   0xf7F59911972E5F1F4E25c812f6a3B7F3cAb3A461
```
Full seeds and derived keys are in `evidence/milestone1/account-derivation/derive.out` (fixtures only).
Changing any step (salt, wordlist, passphrase, path, index, rpId) changes every user's address. The recipe is versioned `EVERPIECE_ACCOUNT_V1` and must not change after real-user onboarding.
The voice/encryption identity is a **separate** cryptographic domain and never uses this EVM private key (THREAT_MODEL §K).

---

## 19. Contract test plan

Locations: `contracts/test/` (core team: unit, fuzz, invariant, fork) · `contracts/test/adversarial/` (Codex, permanent).
Unit tests use a mock AUSD that mirrors the verified semantics: payee check, strict window, nonce map, freeze, burn, pause bits, upgrade flag. Fork tests use real AUSD under `network = "monad"`. `test/Vectors.t.sol` asserts every §18 value against the real contract's view functions.

**Happy paths:** T01 create USERNAME · T02 username claim · T03 create LINK + claim · T04 cancel · T05 refundExpired by a stranger.
**Boundaries (master §8):** T10 claim at expiry−1 ✔ / expiry ✘ · T11 cancel at expiry−1 ✔ / expiry ✘ · T12 refund at expiry−1 ✘ / expiry ✔ / expiry+1 ✔ · T13 create expiry at now+1d ✔ / −1 ✘ / now+30d ✔ / +1 ✘ · T14 `validBefore > expiresAt` ✘ · T15 signature deadline = now ✔ / now−1 ✘ · T16 validAfter = now ✘ / validBefore = now ✘.
**Accounting / solvency:** T20 liability over mixed sequences · T21 invariant fuzz (I1–I7, 20–22, 33) with multiple actors and time warps · T22 per-payment and aggregate caps; setCaps ≤ ceilings ✔, > ceiling ✘; lowering caps does not affect existing claims · T23 unsolicited AUSD sent to escrow does not break accounting (balance > liability OK) · T24 AUSD transfer revert → whole action reverts, state unchanged · T25 short delivery on funding → `FundingMismatch`; short payout → `PayoutMismatch`.
**Binding / replay:** T30 duplicate create → `PaymentExists` · T31 cross-chain (`vm.chainId`) · T32 cross-contract (two escrows) · T33–T39 intent field changes (amount, expiry, recipient, metadata, mode, salt, approver, validity) each → AUSD `InvalidSignature` · T40 authorization for payment A submitted with intent B · T41 AUSD auth pre-cancelled via `cancelAuthorization` · T42 TransferWithAuthorization-typed sig as funding ✘ · T43 claim/cancel sig replay after terminal · T44 used nonce on another payment ✘ · T45 high-s / malformed / wrong-length sigs ✘ · T46 ClaimIntent sig used in link path and vice versa ✘ · T47 `AusdSemanticsChanged` when upgrade flag set (fork).
**Authorization attacks:** T50 unauthorized username sender claim (V_U5) · T51 relayer substitutes recipient · T52 link key only · T53 approval only · T54 approval for Mama redirected to Stella (V_L7) · T55 wrong claimKey/salt reveal → `LinkRevealMismatch` · T56 cancel signed by recipient/approver/stranger ✘ · T57 claim/cancel race, both orders · T58 wrong-mode claims → `WrongMode` · T59 sender self-designated link recipient who passes both factors ✔.
**Approver rotation (D4):** T60 rotate; the old payment still requires the old approver (new approver ✘) · T61 the new payment requires the new approver · T62 intent approver ≠ current → `ApproverMismatch` · T63 USERNAME intent with non-zero approver ✘.
**Pause / admin:** T70 paused: create ✘, claims ✘, cancel ✔, refund ✔ · T71 non-owner cannot pause/unpause/setCaps/setClaimApprover · T72 admin seizure: enumerate ABI; no owner path moves AUSD or edits a Payment · T73 Ownable2Step; `renounceOwnership` reverts.
**Issuer controls (fork):** T80 escrow frozen → all outflows revert, no state change; unfreeze → works · T81 recipient frozen → claim ✘, sender cancel ✔ · T82 burn from escrow → I21 broken, documented; payouts revert when balance < amount · T83 transfer pause → everything reverts; signature pause → create ✘, payouts ✔.
**Vectors:** T90 every §18 value reproduced by the contract's view functions (escrow deployed at the vector address or vectors regenerated for the deployed address) · T91 V_U3 end-to-end on fork.

---

## 20. Deployment configuration

- Constructor `(address ausd, address owner, address initialClaimApprover)`. The caps start at the ceilings.
- The deploy script asserts `ausd == 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` on chain 143, `decimals() == 6`, `DOMAIN_SEPARATOR() == 0x9950…cafe`, `!isReceiveWithAuthorizationUpgraded()`, and owner ≠ approver ≠ deployer.
- Toolchain: Foundry **1.8.3** with `network = "monad"`; solc 0.8.28; `evm_version = "cancun"`; optimizer on (VERIFIED §1.11). OpenZeppelin Contracts: current release, TODO(VERIFY) version at implementation time.
- Owner: a dedicated Maris-controlled account for canaries (D8). A Monad-compatible multisig is to be investigated before broader exposure (TODO(VERIFY)), then `transferOwnership`. No extra owner powers.
- Verification: Sourcify + Monadscan.
- **Mainnet deploy, relayer funding and canaries only on Maris's explicit GO** (master §48–49).

---

## 21. Changes from v0.1

| Area | v0.1 | v0.2 | Source |
|---|---|---|---|
| Status names | PENDING | ACTIVE (+ derived EXPIRED) | master §6.2 |
| Liability | totalLiability | totalActiveLiability | master §7 |
| Expiry bounds | 1 h – 90 d | 1 d – 30 d [CONFIRM] | master §8 |
| Cancel after expiry | allowed | **forbidden** (`now < expiresAt`) | master §8, inv. 11 |
| Recipient commitment | unsalted, per-mode tags | one versioned tag + mode + account + random salt | master §10.1 |
| Link claim key | keccak-derived from link secret | independent random key from audited lib; separate voice root secret | master §11.1–11.3 |
| Contact commitment | on-chain (salted) | removed; phone never on-chain in any form | master §12.3 |
| Approver | sender-pinned | owner-configured, snapshotted per payment, bound in intent | D4 |
| Action nonces | none | `usedNonces[signer][nonce]` on claim/cancel/approval | master §15.2 |
| Intent fields | no validAfter/approver | adds `approver`, `validAfter`; claim/cancel add nonce and sender | D4, D5, master §15 |
| Caps | owner-settable | constant ceilings $500 / $5,000; owner may only set ≤ ceiling | D3 |
| Pauser role | separate | owner only | D8 (minimal powers) |
| Function names | claim / claimLink | claimUsernamePayment / claimLinkPayment | master §6 |
| AUSD upgrade guard | — | `AusdSemanticsChanged` (proposed) | new finding |
| Confirmation rule | — | §17 | D9 |
| Account derivation | open | frozen `EVERPIECE_ACCOUNT_V1` + vectors | D6 |
| Toolchain | Foundry 1.6 | Foundry 1.8.3, `network = "monad"`, evidence re-run | D10 |

---

## 22. Implementation notes (v1 code, 2026-09-29)

Code: `contracts/src/EverpieceEscrow.sol`, `contracts/src/interfaces/{IEverpieceEscrow,IAUSD}.sol`. Shared ABI/types/vectors: `packages/shared`.

Deviations from, or tightenings of, §1–§21. None changes who can receive funds, how much, or when:

| # | Spec | Code | Why |
|---|---|---|---|
| 1 | §5 `payments` public mapping | `_payments` private; read via `getPayment(id)` returning the full struct | A single typed getter; the ABI stays clean for viem |
| 2 | §9.3 claimKey `!= 0` | claimKey `∉ {0, p.approver}` → new error `InvalidClaimKey` | Guarantees the approver key can never satisfy both factors, even if a sender commits to the approver's address (test T53) |
| 3 | §9.1 step 15 emit after transfer | `PaymentCreated` emitted after effects, **before** the AUSD call; the balance-delta check follows | Checks-effects-events-interactions (Slither); the transaction is still atomic |
| 4 | §15 `EnforcedPause` custom | OZ `Pausable.EnforcedPause`; OZ `OwnableUnauthorizedAccount` / `OwnableInvalidOwner` | Reuse audited OZ errors |
| 5 | §6.4 65-byte ECDSA | OZ `ECDSA.tryRecoverCalldata`: 65-byte, low-s only; 64-byte EIP-2098 compact rejected | Matches spec "EOA 65-byte"; test T45 |
| 6 | §7.4 guard "proposed" | Implemented: `createPayment` reverts `AusdSemanticsChanged` if `isReceiveWithAuthorizationUpgraded()` returns true **or the read reverts** | Owner item 8: the switch is present on the deployed system, readable on-chain, and in VERIFIED §2.3/§2.10. Safe/unsafe/unreadable modes tested (T47, fork) |
| 7 | — | Views `isExpired(id)`, `DOMAIN_SEPARATOR()`, public constants (typehashes, tags, ceilings, expiry bounds) | Frontend/relayer parity |
| 8 | §18 constructor | `(IAUSD ausd, address owner, address initialClaimApprover)`; caps start at the ceilings; emits `CapsUpdated` + `ClaimApproverUpdated` | As §20 |

Toolchain: solc 0.8.28, `evm_version = cancun`, via-IR, optimizer 10,000 runs, `bytecode_hash = none`, Foundry 1.8.3 `network = "monad"`, OpenZeppelin Contracts **v5.7.0** (commit cab19933c33c2ad1d4c7a84864a3601dddfd16f3), forge-std v1.16.2.
Runtime size 11,827 B (Monad limit 128 KB).

Execution gas against **real AUSD** (mainnet fork, Monad rules; excludes intrinsic 21,000 + calldata ≈ 3.9k for create):

| Action | Execution gas |
|---|---|
| createPayment (username / link) | 284,545 / 284,035 |
| claimUsernamePayment | 174,438 |
| claimLinkPayment | 197,223 |
| cancel | 156,170 |
| refundExpired | 117,089 |
| deploy (script simulation) | ≈ 3.55M total |

Relayer note: Monad charges the full gas limit (VERIFIED §1.5). Suggested starting limits are observed value × ~1.2, e.g. create 350k, username claim 215k, link claim 240k, cancel 195k, refund 145k. Re-measure on the deployed contract before fixing them.
