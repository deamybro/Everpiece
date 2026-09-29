# @everpiece/claims

Claims/approver server for **link payments**: "Capability B" of the two-capability claim (MASTER_PROMPT §11–14).
It checks that the intended recipient controls the phone the sender registered, then signs a short-lived `ClaimApproval` for **that recipient's wallet**.

The approver alone can never claim: the escrow also requires the link claim key's signature (Capability A). The approver cannot transfer, cancel, change amounts or redirect an issued approval.

## Flow

```text
sender   POST /v1/invites        {paymentId, phone(E.164), deadline, senderSig: InviteRegistration}
                                 → payment must be ACTIVE, LINK, guarded by this approver; signed by payment.sender
recipient POST /v1/claims/start  {paymentId, recipient, claimKey, recipientSalt, deadline, claimKeySig: ClaimStart}
                                 → proves possession of the link (commitment opening + claim-key signature) BEFORE any SMS
                                 → provider sends the code to the registered phone; response shows a masked phone only
recipient POST /v1/claims/verify {paymentId, recipient, code}
                                 → must be the same recipient that started; provider checks the code
                                 → { approvalNonce, approvalDeadline (≤ 300 s), approverSig, approver }
client   → relayer POST /v1/payments/claim-link with the claim-key signature + this approval
```

`InviteRegistration` and `ClaimStart` are EIP-712 in the "Everpiece Claims" v1 domain (bound to chain + escrow). Builders and vectors are in `@everpiece/shared`.

## Security properties (tested, `test/claims.fork.test.ts`)

- **No OTP storage.** Twilio Verify / Termii generate and check codes. The SIMULATED provider keeps only an HMAC and exists for local tests only.
- **No SMS without the link.** Blocks pumping or harassing a recipient by anyone who only knows the paymentId.
- **Progressive resend cooldowns** (default 30/60/120/300/600 s), a per-phone daily cap, and 5 wrong attempts per session. After that, request a new code once the cooldown passes. **No permanent lockout** (§13.1): the sender can always cancel or get the expiry refund.
- **Approval bound to the wallet that started verification.** A redirect is refused.
- **Phone privacy.** Phones are AES-256-GCM at rest (HKDF subkeys from `PHONE_ENC_KEY`), matched by HMAC lookup keys, masked in responses, never logged and never on-chain. Invites are immutable; a wrong phone means cancel and resend.
- **Startup guards.** Refuses to run on the wrong chain, with no escrow code, if the key is not `escrow.claimApprover()` (unless `APPROVER_ALLOW_RETIRED=1`, for draining payments snapshotted to a retired approver), or if the key is the escrow owner.
- **Caching.** Every response is `no-store`.

## Providers

| `SMS_PROVIDER` | Status | Needs |
|---|---|---|
| `twilio` | API verified from docs (VERIFIED §4.4); not live-tested | `TWILIO_API_USER`, `TWILIO_API_SECRET`, `TWILIO_VERIFY_SERVICE_SID` |
| `termii` | API verified from docs (VERIFIED §4.5), with TODO(VERIFY) on encoding, phone format and failure shape; not live-tested | `TERMII_BASE_URL`, `TERMII_API_KEY`, `TERMII_SENDER_ID` |
| `simulated` | **SIMULATED**; refused unless `ALLOW_SIMULATED_SMS=1` **and** `MONAD_RPC` is localhost. Health and responses say `simulated: true` | — |

**Nigeria:**
- MTN, Airtel and 9mobile reject numeric international senders.
- Alphanumeric sender IDs need 2–3 weeks of registration.
- DND filtering can block OTPs.

Delivery to Nigerian numbers is **unproven until a live test** (INTEGRATION_LEDGER).

## Run

```bash
APPROVER_PRIVATE_KEY=… PHONE_ENC_KEY=0x<32 bytes> MONAD_RPC=… ESCROW_ADDRESS=… SMS_PROVIDER=twilio TWILIO_…=… npm start -w @everpiece/claims
npm test -w @everpiece/claims                        # offline (adapters, vault, config)
RUN_FORK_TESTS=true npm test -w @everpiece/claims    # + Monad fork end-to-end (needs contracts/out)
```

Before mainnet:
- Approver key in KMS/HSM, distinct from the relayer, deployer and owner keys.
- `PHONE_ENC_KEY` in a secret manager.
- A live SMS test to Nigerian and UK numbers.
- A retention and deletion policy for invites.
