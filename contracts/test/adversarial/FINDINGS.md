# Adversarial review: EverpieceEscrow (master §44)

- **Reviewer:** core team, 2026-10-02. The owner reassigned this phase from Codex ("don't wait for codex, do it urself"; "yes").
- **Scope:** `contracts/src/EverpieceEscrow.sol` as deployed on Monad testnet (`0x94A25e4c…BFD5`), attacked only through its external surface.
- **Suite:** `AttackMatrix.t.sol` (A01–A40, every row of master §44.2, plus two fuzz properties) and `Reentrancy.t.sol` (a hostile token that calls back into the escrow during funding and payout).
- **Result:** 44/44 pass. The fuzz properties ran 10,000 times each in the CI profile. The full contract suite passes 202/202 (fork tests skipped offline).

**No CRITICAL or HIGH findings. Nothing here blocks mainnet (master §44.3).** One MEDIUM needs an owner decision before real users rely on it.

| Matrix row (master §44.2) | Test | Outcome |
|---|---|---|
| double claim / cancel / refund | A01 / A02 / A03 | refused (`PaymentNotActive`) |
| claim after cancel, cancel after claim, refund after claim | A04 / A05 / A06 | refused |
| claim / cancel at or after expiry, exact boundary | A07 / A08 / A09 (fuzz) | no second where both claim and refund work, none where neither does |
| claim/cancel race, claim/refund race | A10 / A10b | first wins; balances exact either way |
| forged sender / recipient | A11 / A12 | refused, even for someone who knows the salt (the directory holds it) |
| malformed signature, malleability | A13 / A14 | empty, 64-byte compact, 66-byte, v∉{27,28}, r=0, s=0 and high-s all refused |
| stale deadline, used nonce | A15 / A16 | refused; a deadline equal to now is still valid |
| replay across payments / chains / contracts | A17 / A18 / A19 | refused |
| ERC-3009 reuse, authorization substitution | A20 / A21 | refused; a TransferWithAuthorization sig, a wrong payee or a wrong signer all fail; nobody but the escrow can redeem the receive authorization |
| changed amount / recipient / expiry / other terms | A22 | each of 8 tampered terms refused by AUSD |
| approver must match mode | A23 | refused |
| sender claims own username payment | A24 | refused |
| link key without approval, approval without link key | A25 / A26 | refused; the approver posing as the claim key is refused |
| approval for a different wallet, redirected claim | A27 / A28 | refused |
| approver rotation | A29 | snapshot honored (see F-03) |
| reentrancy | Reentrancy.t.sol (A30 ×3) | `ReentrancyGuardReentrantCall` every time; money moves exactly once |
| payment-cap bypass | A31 | refused, including by splitting payments |
| aggregate-cap griefing | A32 | **reproduced: F-01** |
| pause trapping funds | A33 | cancel and refund work while paused |
| admin seizure | A34 | no owner power moves funds; non-owners have none |
| liability mismatch | A35 | short funding or short payout reverts the whole action |
| unsolicited AUSD | A36 | accounting unaffected; see F-02 |
| zero amount, boundary values | A37 | refused / accepted exactly at the limits |
| token-transfer revert, frozen recipient | A38 | all-or-nothing; the sender can still cancel (F-05) |
| relayer manipulation of signed terms | A39 | any change to what was signed fails |
| mode confusion | A40 | refused; commitments are domain-separated by mode |
| fuzz: any other key | `testFuzz_strangerCanNeverClaimOrCancel` | never claims or cancels (10,000 runs) |

---

### F-01: one funded account can fill the global liability cap and block every new payment

```text
Severity: MEDIUM
Component: EverpieceEscrow.createPayment (maxActiveLiability, MAX_LIABILITY_CEILING = $5,000)
Finding: The aggregate cap is global. An attacker with $5,000 AUSD creates 10 × $500 payments to themselves,
  filling it. Every honest createPayment then reverts LiabilityCapExceeded. The attacker can cancel at any time
  and gets every cent back, so the attack costs only gas (and nothing via the gasless relayer, if it accepts them).
Impact: Availability only. No funds are lost or stuck, and existing payments can still be claimed, cancelled and
  refunded. New sends are blocked for as long as the attacker keeps the funds locked (≤ 30 days per payment,
  renewable).
Reproduction: test_A32_FINDING_globalLiabilityCap_griefing
Expected behavior: One sender shouldn't be able to deny service to all others.
Recommended fix (owner decision: the cap is a V1 money-safety rail, master §1.7/§19):
  (a) add a per-sender active-liability limit in the contract (a new deployment);
  (b) raise MAX_LIABILITY_CEILING for mainnet, which makes the attack more expensive but not impossible (also a
      new deployment, since the ceiling is immutable);
  (c) relayer-side per-sender limits: they stop it through our relayer only, not via direct contract calls;
  (d) accept it for the hackathon canary, with monitoring of totalActiveLiability against the cap.
Regression test: test_A32_FINDING_globalLiabilityCap_griefing (pins today's behavior; update it with the fix).
```

### F-02: unsolicited AUSD sent to the escrow is stranded

```text
Severity: INFO
Component: EverpieceEscrow (no sweep function, by design: no admin path moves funds)
Finding: AUSD transferred directly to the escrow is not attached to any payment, and nobody (including the owner)
  can withdraw it.
Impact: Only the person who sent it loses it. Accounting, claims and refunds are unaffected (payouts are exact).
Reproduction: test_A36_unsolicitedAusd_neitherBreaksAccountingNorCanBeTaken
Expected behavior: As implemented (ESCROW_SPEC §13: the owner has no power over funds).
Recommended fix: None. The UI never asks anyone to transfer to the escrow directly.
Regression test: test_A36_…
```

### F-03: rotating the approver doesn't help existing link payments

```text
Severity: INFO
Component: claimLinkPayment (approver snapshot, D4)
Finding: Each link payment keeps the approver it was created with. If that key is lost, its payments can't be
  claimed and simply return to the sender at expiry. If it is stolen, the thief still needs each link's claim key.
Impact: Delay, not loss.
Reproduction: test_A29_approverRotation_existingPaymentsKeepTheirSnapshot
Expected behavior: As specified (snapshot prevents an owner-chosen approver from taking existing payments, A34).
Recommended fix: None. Keep the approver key in KMS before mainnet (INTEGRATION_LEDGER).
Regression test: test_A29_…
```

### F-04: a long pause can make payments expire unclaimed

```text
Severity: INFO
Component: pause() (blocks createPayment and both claims; never cancel or refund)
Finding: While paused, recipients can't claim. A payment whose expiry passes during the pause goes back to the sender.
Impact: The money is never trapped; the recipient may have to be paid again.
Reproduction: test_A33_pauseNeverTrapsFunds
Expected behavior: As specified (ESCROW_SPEC §13).
Recommended fix: Operational. Keep pauses short and tell senders that affected payments come back to them.
Regression test: test_A33_…
```

### F-05: a claim signed in time can still lose to the refund at the boundary; a frozen recipient can't claim

```text
Severity: INFO
Component: claim paths vs refundExpired; AUSD issuer freeze
Finding: Validity is judged at execution time. A claim that lands at expiresAt fails, and the refund succeeds.
  A recipient frozen by the AUSD issuer can't receive, but the sender can cancel.
Impact: None on funds. The UI should stop offering a claim close to expiry.
Reproduction: test_A10b_claimRefundRace_atBoundary, test_A38_tokenTransferRevert_isAllOrNothing
Expected behavior: As implemented.
Recommended fix: Web: hide or warn on claims within a few minutes of expiry (follow-up).
Regression test: test_A10b_…, test_A38_…
```

---

# Adversarial review: EverpiecePay (audit 2026-10-06, finding O2)

Suite: `test/adversarial/PayAttack.t.sol`. **12/12 passed**, both fuzz properties at 10,000 runs (CI profile). **No CRITICAL, HIGH or MEDIUM findings.** The contract was not changed.

| # | Attack | Result |
|---|---|---|
| P01 | Send an AUSD payment through the token path, or a token payment through the AUSD path | Refused (`UnsupportedToken` / `WrongSourceToken`) |
| P02 | Fund an instant payment with an escrow ERC-3009 authorization | Refused; the escrow authorization stays usable for the escrow |
| P03 | Replay a signature on another EverpiecePay deployment | Refused (domain separator; `InvalidPayerSignature`) |
| P04 | Change any signed field: ref, recipient, amount up/down, ceiling, deadline (fuzzed) | Always refused; nothing moves |
| P05 | Tokens/AUSD already in the contract | Never paid out; the payer is charged and refunded exactly their own amounts |
| P06 | A pair that takes more input than it reports | `SettlementMismatch`; nothing charged |
| P07 | A hostile source token re-entering with a second signed payment to an attacker | Blocked by the reentrancy guard; the attacker gets nothing; the outer payment completes correctly |
| P08 | Recipient = the contract itself / the pair | Refused (`InvalidRecipient` / `SettlementMismatch`) |
| P09 | Allowances left behind | None (payer → contract and contract → pair both 0) |
| P10 | Deadline boundary | Exclusive: at `deadline` it's refused, one second earlier it settles |
| P11 | Front-running with a bad permit to burn the payment | Reverts without settling; the real submission still works |
| P12 | The contract keeps value (fuzzed amount × fee) | Never: its balances are unchanged; the recipient gets exactly `amount`, the payer pays exactly the quote |

### F-06: value sent to EverpiecePay directly is unrecoverable

```text
Severity: INFO
Component: EverpiecePay (no owner/admin by design)
Finding: Tokens or AUSD transferred straight to the contract (not through a payment) can never be moved.
Impact: Only someone who sends funds outside the app loses them; payments are unaffected (P05).
Reproduction: test_P05_strandedTokensStayPut_payerGetsOnlyTheirOwnLeftover
Expected behavior: As designed (no admin can touch funds); same trade-off as F-02 for the escrow.
Recommended fix: None in the contract. The app never sends to the contract address.
Regression test: test_P05_…
```

### F-07: trust boundaries that the contract can't enforce

```text
Severity: INFO
Component: EverpiecePay deployment and pairs
Finding: (1) Pairs are fixed at deploy and trusted for price; the payer's signed ceiling (maxSourceAmount) bounds the
  cost, and the exact-delivery and input-accounting checks catch a dishonest pair (P06). (2) Payers must be EOAs
  (ECDSA only; no ERC-1271), which holds for Everpiece accounts. (3) On the AUSD path, maxSourceAmount is signed but
  unused (always charged exactly `amount`).
Impact: None for Everpiece accounts.
Reproduction: P06; review.
Expected behavior: As designed.
Recommended fix: Deploy only with Agora's verified pairs (VERIFIED §4.14/§4.15) and record the pair list.
Regression test: test_P06_…
```
