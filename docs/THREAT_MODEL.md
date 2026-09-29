# THREAT_MODEL.md — Everpiece (v0.2)

Status: reconciled with full MASTER PROMPT v3.2 and Maris decisions D1–D10 (2026-09-29). Pairs with `ESCROW_SPEC.md` v0.2.
Test IDs (T..) refer to ESCROW_SPEC §19; Codex's permanent attack tests live in `contracts/test/adversarial/`.

## A. Assets and trust boundaries

| Asset | Where | Protected by |
|---|---|---|
| Active escrowed AUSD | EverpieceEscrow | Signatures + deterministic contract rules |
| Claimed AUSD | Recipient's Mera EOA | Recipient's passkey |
| PRF output / derived EVM key | Browser memory only, never persisted (master §22.2) | Passkey user verification + frontend integrity |
| Link client package (claim key, voice root, recipient salt) | URL fragment → ephemeral app state | Never sent to server; two-factor claim |
| Recipient phone | Everpiece DB (encrypted at rest, redacted logs) | Access control; never on-chain |
| OTP challenge state | Server | Slow/salted verifier storage, throttles |
| Approver key | Server (KMS/HSM target) | Cannot claim alone |
| Relayer key + MON | Server (KMS target) | Can only submit allow-listed methods; never holds AUSD |
| Owner key | Maris-controlled account (canary phase, D8) | Minimal powers; cannot move funds |
| Voice/message ciphertext | Private object storage | Client-side encryption |

**Trusted for money safety:** escrow code, AUSD (issuer), the user's authenticator, and **the web origin's JavaScript**, which builds what the user signs.
**Trusted only for liveness:** relayer, RPC, Envio, SMS provider, object storage, and the server (except its approver role in link mode).

## B. Username directory, recipient pinning (master §10.2–10.3)

- B1 **Directory returns the wrong account** (`@mama → attacker`). Mitigations:
  - The first payment shows username, display name, avatar and joined date; the sender explicitly confirms.
  - After the first successful interaction the browser **pins** `@username → account → encryption public key`.
  - If a later lookup returns a different account or key, automatic send is blocked: "This recipient's security details changed. Verify them before sending."
  - The payment commits to the account, not the username. The sender can cancel until claim.
- B2 **Lookalike usernames**: confusable-character normalization at registration; "new recipient" warning.
- B3 **TOFU limitation.** Pinning is Trust On First Use:
  - It does not protect the first-ever interaction against a malicious directory.
  - It does not survive a new device or cleared storage.
  - It **cannot** protect against a compromised Everpiece origin serving malicious JS.
  - The username system is **not trustless** and must never be described as such.

## C. Claim-link threats (master §2.4–2.5, §11)

- C1 **Link intercepted / forwarded / backed up.** The attacker holds factor A only. Claim fails without the approval (T52).
- C2 **Approver compromised.** The attacker holds factor B only; that also fails (T53). Response:
  - pause claims;
  - rotate `claimApprover` for new payments;
  - existing payments keep requiring the old snapshotted key (D4), which still cannot claim alone.
- C3 **Both factors** (the attacker controls the recipient's phone: WhatsApp link + SMS OTP). **Known limitation: attacker wins.** Mitigations: caps ($500), sender cancel before expiry, short expiry options.
- C4 **Recipient substitution by relayer/server.** Both factors bind the same `recipient` (T51, T54, vector V_L7).
- C5 **Sender knows the link secret.** It is insufficient: the SMS goes to the recipient's phone, and the sender never sees the code (master §12.1). A sender who designates and verifies themselves passes the normal path; that is not a bypass (T59).
- C6 **Fragment leakage.** Fragments are not sent in HTTP requests or Referer headers. They can still leak via history, sync, screenshots, scripts reading `location.href`, and error reporters. Mitigations:
  - parse → validate version → copy to ephemeral state → `history.replaceState`, only after any browser handoff completes;
  - never log, send, cache, or include in telemetry or error reports;
  - no third-party scripts on claim routes;
  - `Referrer-Policy: no-referrer`.
- C7 **Fragment lost in WebView → browser handoff.** Silent loss would make the payment unclaimable. It must be tested on real devices (WhatsApp → Chrome, embedded → Safari). If handoff is unreliable, redesign before shipping. Never lose the secret silently.
- C8 **Phishing clone** of the claim page. The passkey is rpId-bound, so a clone cannot derive the victim's account, but it can phish the OTP plus the link. Mitigations: OTP SMS names the real domain; approvals bind the exact recipient wallet and have short deadlines.
- C9 **Key separation (master §11.1–11.3):**
  - `claimPrivateKey` comes from an audited secp256k1 random-key API.
  - `voiceRootSecret` is independently random.
  - The voice key is HKDF(voiceRootSecret, `"everpiece.link.voice.v1"`).
  - No key is used for more than one purpose. Voice-decryption capability never authorizes a claim.

## D. Recipient verification / SMS / OTP (master §12–13)

- D1 SIM-swap / SS7 interception + link → C3. Disclose; caps.
- D2 **OTP brute force.** Short expiry, per-session and IP/device throttles, progressive cooldowns, challenge rotation, abuse detection.
- D3 **No permanent bad-guess lockout** (master §13.1). Repeated failures lead to a temporary throttle, then challenge reissue, then stronger verification. A permanent lockout would let an attacker DoS a payment. The sender always keeps cancel-before-expiry and expiry refund.
- D4 **OTP storage.** Never on-chain, never logged. It is not protected by a fast unsalted hash (a 6-digit code is trivially brute-forced offline). Use short-lived server-side verifier storage with a keyed HMAC or slow hash, deleted on use or expiry.
- D5 **SMS pumping / toll fraud.** Per-payment and per-IP limits, block premium ranges, provider fraud controls. TODO(VERIFY): provider, Nigeria/UK/international delivery, pricing, rate limits, sender-ID rules, auth, webhooks (master §12.2).
- D6 **Approver misuse.** Approvals bind `paymentId + recipient + approvalNonce + deadline`. Before signing, the server checks that the payment is ACTIVE, the phone verified is the one stored for that payment, and the deadline is short (minutes).
- D7 **Sender-assisted fallback** (master §12.4). Only with Maris approval, and it is weaker: the sender relays a second secret over a different channel. It must never be described as equivalent to independent phone verification.
- D8 **Phone data** is sensitive: encryption at rest, strict access, redacted logs, minimal retention, deletion policy, never on-chain in any form (ESCROW_SPEC v0.2 removed the contact commitment).
- D9 The service worker never caches OTP responses, approvals or secret-bearing requests (master §2.6).

## E. Relayer threats (master §26)

- E1 **Alters signed fields.** Impossible; every field is bound (ESCROW_SPEC §6–7).
- E2 **Censors / withholds.**
  - The funding authorization expires at `validBefore`; funds never moved.
  - Claims wait.
  - `refundExpired` is permissionless, and anyone can submit any signed action.
- E3 **Key theft.** The attacker gets MON only. Rotate; keep only the needed balance.
- E4 **Gas-limit charging** (Monad charges the full limit, VERIFIED §1.5). Use tight, explicit, reviewed limits and simulate. Filter known reverts so attackers cannot drain MON with failing calls. Apply per-user sponsorship limits, a daily gas budget and a minimum payment size.
- E5 **Reserve balance.** In-flight gas per EOA is ≤ min(10 MON, balance) (VERIFIED §1.9). Monitor; shard deliberately if needed.
- E6 **Inclusion ≠ success** (D9). A transaction can be included and still revert, paying full gas. The UI and DB never mark CREATED, CLAIMED, CANCELLED or REFUNDED from inclusion alone. They require a successful receipt, the expected escrow event, a matching `getPayment` state, and finality (ESCROW_SPEC §17). On revert, show failure and reconcile to chain state.
- E7 **Nonce races.** Serialized submission per relayer EOA; workers never race for a nonce.
- E8 **Arbitrary calldata relay.** Never; method allow-list only.
- E9 **Idempotency.** Every financial request has an idempotency key (the action nonce / paymentId). Retries never duplicate value movement.
- E10 **Implemented (server/relayer v0):** E1/E4/E6–E9 are enforced in code and fork-tested (`evidence/relayer-v0/`). Remaining: the relayer key is still an env var (move it to KMS before mainnet), and the rate limiter is per-process (run a single instance).

## F. Frontend / Mera threat boundary (master §22–23)

- F1 **XSS or a malicious dependency reads PRF output or a live signing session** (VERIFIED §3.8). Mitigations: strict CSP, no third-party scripts on app routes, pinned dependencies + lockfile, SRI, XSS testing.
  - **Prompt per financial action** (master §22.4): run the ceremony → derive → sign one intent → `end()` the session and drop references.
  - Never persist PRF output or the derived key.
- F2 **PRF output = portable wallet.** Under `EVERPIECE_ACCOUNT_V1` the PRF output is the BIP-39 entropy of a standard 24-word phrase (VERIFIED §3.4). Anyone who exfiltrates it once owns the account forever, on any wallet. This raises the stakes of F1.
- F3 **Compromised deploy** shows "$20 to @mama" but asks the user to sign "$500 to attacker". The single AUSD signature is the only funding authorization, and the passkey prompt cannot display terms. Mitigations: deploy-pipeline protection, contract caps, pause, monitoring. **Known limitation of every in-app-signing wallet.**
- F4 **rpId / domain change** makes every account unreproducible (VERIFIED §3.5). Choose the production domain once, before meaningful balances, and record it in VERIFIED.md. Production builds refuse to run on other origins.
- F5 **Password manager intercepts WebAuthn** and creates a non-PRF passkey → `PRF_UNAVAILABLE`. The UX explains the problem and retries with the platform authenticator. Raw SDK errors are never shown to users (master §22.5).
- F6 **PWA cache persisting secrets.** No caching of claim routes, OTP, approvals, secret-bearing bodies or sensitive claim responses.

### F7. Passkey loss and recovery (D7) — known limitation

- Everpiece V1 **does not provide custodial, social or server-side recovery** and must not claim to.
- Account continuity relies only on what the passkey provider actually does: passkey **sync** across a user's devices via iCloud Keychain, Google Password Manager, 1Password, etc. (VERIFIED §3.7), plus Mera's deterministic re-derivation from the same passkey + rpId.
- The account is **lost** if:
  - the passkey is deleted or not synced;
  - the provider account is lost;
  - the rpId changes;
  - the passkey is overwritten.
- A *second* passkey yields a *different* PRF and therefore a *different* account; it is not a backup.
- **Unclaimed payments:** if the intended recipient cannot access their account, the financial recovery path is the sender's **cancel** (before expiry) or the permissionless **expiry refund**.
- **Already-claimed funds:** Everpiece cannot recover them. A mnemonic export (possible because the recipe is standard BIP-39) is **not** in V1. Adding one later needs its own threat review, because it also creates a new exfiltration path.
- Consumer copy must say this plainly, e.g. "Your account lives in your passkey. If you lose access to your passkey, Everpiece can't restore it."

## G. Admin threats (master §19)

- G1 **Owner key theft.** The attacker can pause/unpause, lower caps (not above the V1 ceilings), and set the approver for **new** link payments. They **cannot** move AUSD, edit payments, block cancel/refund, or change existing payments' approvers.
  - A malicious new approver still cannot claim without the link claim key.
  - Clients should pin the expected approver address and refuse to build intents for an unexpected one.
- G2 **Pause griefing.** Cancel and refund remain available (D2).
- G3 **No upgrade path.** No upgrade-based theft. Bugs require a redeploy; the old contract still refunds.
- G4 **Temporary single-key owner** (D8) is acceptable only for small canaries. Before broader exposure, verify a Monad-compatible multisig and transfer ownership. No extra owner powers compensate for this.
- G5 **Key separation.** Owner, approver, relayer and deployer are distinct keys (deploy-script assertion).

## H. AUSD issuer threats — outside Everpiece's control (VERIFIED §2.10–2.11, fork-tested)

- H1 Agora **freezes the escrow**: every active payment is stuck (claim, cancel and refund all revert) until unfreeze.
- H2 Agora **burns from the escrow** (BURNER_ROLE, no allowance): the solvency invariant breaks; later payouts revert when balance < amount. There is no pro-rata logic.
- H3 Agora **freezes a recipient**: the claim reverts, and the sender can cancel before expiry. Freezes a sender: the refund reverts.
- H4 Agora **pauses transfers**: everything stops. **Pauses signatures**: new payments stop; payouts continue.
- H5 Agora **upgrades AUSD.**
  - Outflow semantics are covered by balance-delta checks.
  - **Inflow risk:** if `isReceiveWithAuthorizationUpgraded` is set, the payee check may vanish. A griefer could then consume a sender's authorization directly and strand funds in the escrow with no payment, which is unrecoverable because there is no sweep.
  - Mitigation (proposed): `createPayment` reverts `AusdSemanticsChanged` while that flag is set (ESCROW_SPEC §7.4). Monitor all AUSD flag bits.
- Consumer copy must not claim funds are immune to issuer action.
- **Everpiece guarantees contract-level accounting, not immunity from external AUSD issuer/admin intervention.** Agora can, per the verified token permissions: pause transfers and signatures, freeze any account (including the escrow), upgrade AUSD (the implementation, and per-function proxy flags), and burn from any account via BURNER_ROLE. Implemented defenses:
  - Every AUSD failure reverts the whole Everpiece action, so there is never a false CLAIMED/CANCELLED/REFUNDED.
  - Exact balance-delta checks on every inflow and outflow.
  - The fail-closed creation guard on the receive-upgrade flag.
  - All of these are fork-tested against live AUSD (`contracts/test/fork/`).

## I. Provider threats (post-claim, optional)

- Payout, Piece, Ramp and Aurora failures affect only funds the recipient chose to move after claiming. A claim is never contingent on a provider (master §1.6).
- No fake LIVE labels, receipts, transactions or metrics (master §0.5, §42).
- Webhooks must be authenticated, deduplicated and reconciled. A redirect saying "success" is not proof (master §41).

## J. Privacy limitations

- **On-chain:** sender, amount, timing and (at claim) recipient and recipient salt are public. Before claim, the salted commitment hides the recipient.
- **Server:** sees usernames, phones, the social graph, amounts and timing. It does not see messages or voice (client-encrypted).
- No private-send in core. Unlink stays DISABLED until its gate passes (master §28).

## K. Voice / message privacy and cryptographic domains (master §23–24)

- Every voice note is encrypted on-device before upload:
  - a fresh 256-bit content key;
  - AES-256-GCM via Web Crypto (never hand-rolled);
  - the server stores ciphertext, IV, hashes, MIME, duration and a wrapped key only.
- **Link mode:** the content key is wrapped under HKDF(voiceRootSecret, `"everpiece.link.voice.v1"`).
- **Username mode:** the content key is wrapped to the recipient's **encryption public key**.
  - That identity is a **separate cryptographic domain** and must never reuse the EVM private key (D6, master §23).
  - Candidate schemes (not frozen; TODO, messages milestone): an established audited scheme such as HPKE (RFC 9180) with X25519, with the X25519 key derived through a domain-separated KDF, or a second PRF salt used as a namespace.
  - Evaluate browser/Android support, deterministic recovery and audited implementations first. Do not invent crypto.
- `metadataCommitment` binds `envelopeHash` plus a random salt, so tampering is detectable.
- Private bucket; short-lived signed reads; size/MIME limits; lifecycle deletion.
- **Media failure never blocks claim, cancel or refund** (master §24.8).
- Honest claim wording: master §24.7. No claim of immunity to XSS, a compromised device or a supply-chain attack.

## L. Known limitations (summary)

1. An attacker with the recipient's phone plus the link can claim (C3).
2. A compromised web origin can make users sign harmful authorizations; recipient pinning cannot help (B3, F3).
3. Leaked PRF output is a portable, permanent wallet compromise (F2).
4. Passkey loss means account loss; there is no Everpiece recovery. Unclaimed funds return via cancel/expiry (F7).
5. The issuer can freeze or burn escrowed funds and change AUSD behavior (H).
6. Username directory trust is TOFU (B3).
7. A single-key owner during canaries (G4).
8. Excess AUSD sent directly to the escrow is stranded (master §7.3).
