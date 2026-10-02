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
- B1 **As built (V1, `server/directory` + `web/lib/username.ts`):**
  - Every directory record carries the account's own EIP-712 `UsernameRegistration` signature (domain "Everpiece Directory" v1, bound to chain + escrow). The **browser re-verifies it** on every lookup, so a malicious directory can map @name only to an account that signed for that exact name. It still cannot be stopped from serving an attacker's *own* validly signed record on first contact (B3).
  - The first-payment screen shows display name, @username and a shortened account; the sender must tick "This is the person I mean" (no avatar or joined date yet).
  - The pin is `@username → account` only; there is no recipient encryption key yet. It is set only after the payment is CONFIRMED. A later mismatch blocks sending with the §10.2 message. Covered by `web/e2e/username.spec.ts`.
  - **One username = one account**, enforced by the database, not just by code: `username` PRIMARY KEY with CHECK lowercase, `account` UNIQUE, and the lookalike key UNIQUE (B2). A simultaneous sign-up race has exactly one winner (tested).
  - Names are first-come, one per account, immutable in V1 (no migration flow; "legitimate migration requires explicit re-verification" is not built).
- B2 **Lookalike usernames**: V1 avoids confusables by construction: usernames are lowercase ASCII `^[a-z][a-z0-9_]{2,19}# THREAT_MODEL.md — Everpiece (v0.2)

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
, staff-like names are reserved, and display names reject control and bidi-override characters. Plus the "new recipient" confirmation. Common ASCII lookalikes are treated as the **same** name: `usernameSkeleton` drops "_" and folds 0→o, 1/i→l, rn→m, vv→w. The key is stored UNIQUE, so `mama`, `marna`, `mama_` and `m_a_m_a` can have only one holder. Reserved names are checked on the folded key (`adm1n`, `supp0rt`). Other lookalikes (e.g. `mamma`) are still possible; the confirmation and pinning remain the defence.
- B4 **Inbox privacy.** A USERNAME payment's recipient salt links the payment to its recipient. It is not a theft secret (only the recipient's signature can claim, ESCROW_SPEC §3.1), but it is personal data.
  - The directory stores an entry only if `(recipient, salt)` opens the on-chain commitment of an ACTIVE USERNAME payment read at "finalized", so nobody can spam or forge inbox entries.
  - Reading an inbox needs the account's inbox key (EVERPIECE_INBOX_V1 = HKDF-SHA256 of the passkey PRF output, info "everpiece.inbox.v1"). The directory stores only its keccak hash.
  - The browser keeps the inbox key in `localStorage`. Anyone with access to that browser profile can see which username payments were sent to the account; they cannot move money.
  - The directory operator sees the full sender → recipient graph for username payments. TODO(REVIEW): with the voice-key derivation (master §23).
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
- C10 **Email as factor B (owner-approved 2026-09-30, as an alternative to SMS).** The code can go to an email address instead of a phone (`EmailInviteRegistration`, a separate EIP-712 type, so a phone invite signature can't be replayed as an email one).
  - **Same-inbox risk.** If the sender emails the claim link to the same address, one inbox holds both factors, and whoever controls it (or anyone who breaks into it) can claim. This is C3 with a larger attack surface: email accounts are phished and reused more than SIMs are swapped.
  - **Mitigations:**
    - The share step says not to email the link and offers WhatsApp without a number, the share sheet, and copy. The app itself never offers email sharing.
    - The code email says "Everpiece never emails claim links".
    - Caps, sender cancel and expiry (C3).
  - **Not enforceable:** Everpiece can't see how the sender shares the link, and the share sheet can still pick email.
  - **Weaker than SMS for Nigeria?** Unknown in practice. It does avoid SMS pumping, sender-ID registration and DND filtering.
  - **Delivery:** email is **SIMULATED only**; no live provider is chosen. A live one needs SPF, DKIM and DMARC on the sending domain, or codes land in spam.
  - **Privacy:** addresses are encrypted at rest, masked (`m•••@domain`) in responses, never logged and never on-chain, the same as phones.

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
- D10 **Implemented (server/claims v0):**
  - Only a holder of the link claim key can trigger an SMS: a `ClaimStart` signature plus the commitment opening. This blocks SMS pumping by outsiders.
  - The provider generates and checks the code (Twilio Verify / Termii), so Everpiece stores no OTP. The simulated provider keeps only an HMAC, with a 10-minute expiry.
  - Progressive resend cooldowns (30/60/120/300/600 s), a per-phone daily cap, and 5 wrong attempts per session. After that, a new code can be requested after the cooldown; the payment is never locked (§13.1).
  - The approval is bound to the wallet that started the session, with a 300 s deadline.
  - Phones are AES-256-GCM at rest with HKDF subkeys and HMAC lookup keys; they are masked in responses and never logged.
  - The invite is sender-signed and immutable (a wrong phone means cancel and resend).
  - The service refuses to start unless its key is the escrow's current `claimApprover` and is not the owner.
  - **Nigeria delivery is unproven** (VERIFIED §4.4): until live-tested, link claims to NG numbers may fail. The funds stay safe (cancel/refund), but the UX breaks.

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
- **Link mode (built, v1, ESCROW_SPEC §3.2):** the AES-256-GCM key is HKDF(voiceRootSecret, `"everpiece.link.voice.v1.key"`).
  - Deviation from "fresh content key + wrap": voiceRootSecret is itself 256 fresh random bits per payment and is used for nothing else, so a derived key gives the same one-key-per-message property without a wrap layer. The IV is random, and a key encrypts one message only. Reviewed: K.1 item 2.
  - The store locator and the commitment salt come from the same secret under different labels: knowing the locator (the store does) reveals nothing about the key.
  - The store keeps ciphertext plus the header (version, audio type, duration). It never receives plaintext, the key or the link.
  - **Binding:** the sender uploads before signing, and the intent's `metadataCommitment` binds the exact envelope. The recipient refuses a mismatch, so neither the store nor anyone else can attach a message to someone's payment (E2E: a swapped envelope shows "couldn't be verified").
  - Upload capture in E2E: the uploaded bytes start 0x01 and don't contain the note's plaintext.
- **Username mode (built, `packages/shared/src/messageKey.ts`):** the message is sealed exactly as for a link (envelope v1), under a **fresh random** 32-byte message secret. That secret is then wrapped to the recipient's **message key** with HPKE.
  - **Message key (EVERPIECE_MESSAGE_KEY_V1):** HKDF-SHA256(PRF output, info `"everpiece.message-key.v1"`), turned into an X25519 key pair by RFC 9180 DeriveKeyPair.
    - It is a separate domain from the EVM key and from the inbox key (the directory sees the inbox key). Deterministic from the passkey, so it is recovered on any device.
  - **Publication:** an EIP-712 `MessageKeyRegistration(account, messageKey, deadline)`, signed by the account. One per account, immutable.
    - Senders verify the signature themselves, so the directory can't substitute its own key. It can only lie about who @name is, which TOFU pinning covers.
  - **Wrap:** HPKE base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM, info `"everpiece.username.voice.v1"`, **aad = paymentId**. An 80-byte opaque wrap travels with the inbox entry.
    - A wrap can't be moved to another payment. A forged wrap or envelope fails the on-chain commitment check.
  - **Library:** `@hpke/core` 1.9.0 + `@hpke/dhkem-x25519` 1.8.0, pinned exactly. It is **not formally audited** (no audited JS HPKE exists, VERIFIED §4.13).
    - Its X25519 is vendored from noble-curves (audited by Trail of Bits, 2023); AES-GCM and HKDF come from Web Crypto.
    - Our tests run RFC 9180's own A.1.1 vector through it, plus low-order public keys (rejected, §7.1.4).
  - **Storage:** the seed is kept on the device like the inbox key, so Home can open messages without a prompt. XSS could read messages, but not move money; see the review, item 5.
  - Older accounts publish their key with one prompt ("Turn on voice messages"). Senders see the composer only for recipients with a verified key.
- `metadataCommitment` binds `envelopeHash` plus a random salt, so tampering is detectable.
- **Storage (built: `server/voice`, self-hosted with the test stack, not a bucket):**
  - Reads need the 256-bit locator, derived from the link and known only to link holders. That locator stands in for short-lived signed URLs. There is no listing endpoint, and responses are `no-store` and served as `application/octet-stream`.
  - Header checks (version, type, duration ≤ 30 s); envelope ≤ 1 MiB; first write wins (a different envelope can't replace one).
  - Limits: per-IP rate and daily upload caps, plus a total-bytes cap (507 when full); messages are deleted 45 days after upload.
  - Production: re-evaluate R2/S3 with private buckets and signed reads (INTEGRATION_LEDGER).
- **Media failure never blocks claim, cancel or refund** (master §24.8).
  - Link page: the message loads on its own, separately from the claim.
  - Home: waits at most 4 s for a message, then shows the payment anyway.
  - E2E: with the store blocked, the claim still opens.

### K.1 Security self-review of messages (core team, 2026-10-02; owner asked not to wait for Codex)
1. **Fixed, Medium: relayer broadcast.** HTTP 429/5xx/timeouts from the RPC were treated as rejections: the request was marked FAILED and, after a timeout the node had in fact accepted, the nonce was reused. Found when Monad's public testnet RPC returned 429 on a cancel.
   - Now: 3 quick retries, then the signed transaction stays PROCESSING for the monitor (`20592b9`; offline classifier tests, fork 26/26).
   - Edge: if the node refuses nonce gaps, a request queued behind a deferred one may fail as BroadcastRejected while the first is rebroadcast. No money at risk; it can be retried.
2. **Accepted: link-mode key derived from voiceRootSecret,** not a content key plus wrap. The secret is 256 fresh random bits per payment, used for one message only, with a random IV. A wrap layer would add nothing.
3. **Accepted: capability reads.** Reads take a 256-bit locator HKDF'd from the message secret, instead of signed URLs.
   - A leaked locator (for example in a proxy log) yields ciphertext only. There is no listing, and responses are no-store.
4. **Accepted with mitigations: unaudited HPKE library.** See above: exact pins, RFC vector, low-order rejection. Revisit if an audited JS HPKE appears.
5. **Accepted, Low: device-stored message seed.** Same exposure as the inbox key: XSS on our origin can read messages but can't sign or move money. The strict nonce CSP (F1) is the control.
6. **Fixed (`2800a84`): store abuse.** Uploads used to stay 45 days whether or not a payment carried them. Now every upload starts with a **24 h** lifetime.
   - Sender (after confirmation) and recipient (after opening) **bind** it: they reveal the paymentId and the commitment salt, which can't decrypt anything.
   - The store recomputes `metadataCommitment` from the bytes it holds, compares it with `getPayment` at "finalized", and then keeps the message until 15 days after the payment's expiry.
   - RPC trouble is a retryable 503, never a deletion. Pending binds retry from Home.
   - Still bounded: ≤ 1 MiB each, per-IP caps, 500 MB total.
   - Privacy cost: the store now learns which payment a message belongs to (item 7).
7. **Accepted: metadata.**
   - A non-zero `metadataCommitment` shows on-chain that a payment carries a message.
   - The store sees size, type, duration, uploader IP and, once bound, the paymentId; the directory sees an opaque 80-byte wrap.
   - No content, keys or plaintext leave the device.
8. **By design: link holders hear the message before the code check.** The link is already the secret that grants access to the message, not to the money (master §24.5).
9. **Low: sender-supplied media is decoded by the recipient's browser.** The type is limited to webm/mp4/ogg, played from a blob: URL (CSP `media-src 'self' blob:`). The note is rendered as text, never HTML.
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
