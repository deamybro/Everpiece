# INTEGRATION_LEDGER.md

This file answers: **how ready is it?** Facts live in `VERIFIED.md`.

Statuses: UNKNOWN · RESEARCHING · VERIFIED_DOCS · VERIFIED_CODE · VERIFIED_LOCAL · VERIFIED_FORK · VERIFIED_SANDBOX · VERIFIED_MAINNET · BLOCKED · DISABLED

Feature flags all start `false` (master §36): RAMP, AURORA, PAYOUT, PIECES, PRIVATE_SEND, CRE.

| Integration | Core? | Status | Evidence | Blockers / next step | Last checked | Owner |
|---|---|---|---|---|---|---|
| Monad mainnet | Core | VERIFIED_FORK | Chain 143 via live RPC; docs read; EverpieceEscrow suite green under Foundry 1.8.3 `network = "monad"` on a mainnet fork; deploy script simulated against mainnet (VERIFIED §1) | RPC finality semantics verified (VERIFIED §1.14); claim QuickNode/Tenderly perks; dedicated RPC for relayer | 2026-09-29 | core team |
| AUSD | Core | **VERIFIED_FORK** | Sourcify source; live reads; the **real EverpieceEscrow** runs create/claim/link-claim/cancel/refund with the published vectors on live AUSD, plus freeze/burn/guard (`contracts/test/fork/`, 28 tests) | Mainnet canary after Maris GO | 2026-09-29 | core team |
| EverpieceEscrow | Core | VERIFIED_LOCAL + VERIFIED_FORK | 177/177 tests (CI profile, fork included); Slither: 0 high/medium (`evidence/escrow-v1/`) | Codex adversarial suite; Maris deploy GO | 2026-09-29 | core team |
| Mera | Core | VERIFIED_LOCAL | `@category-labs/mera@0.2.0` types; official recipe frozen as `EVERPIECE_ACCOUNT_V1` with 3-implementation vectors (`evidence/milestone1/account-derivation`); the PWA runs Mera's real PRF path end to end under Playwright with a Chrome CDP virtual authenticator (`hasPrf`), `web/e2e/flow.spec.ts` | Real devices: budget Android/Chrome+GPM, iOS Safari, WhatsApp/Telegram WebViews; production rpId | 2026-09-29 | core team |
| Relayer (server/relayer) | Core | VERIFIED_FORK | 24/24 tests incl. 18 on an anvil `--network monad` fork of mainnet with real AUSD: create/claim/link/cancel/refund CONFIRMED only after finality; claim/cancel race → loser FAILED; idempotency, rate/budget/balance guards, no arbitrary calldata (`evidence/relayer-v0/`) | KMS signer, dedicated RPC + alerting, deploy after escrow GO | 2026-09-29 | core team (reassigned by owner) |
| Envio | Core-support | VERIFIED_FORK | `indexer/` on envio 3.12.1 (config from the package's own schema, VERIFIED §4.7): the four payment events → Payment, PaymentEvent timeline and Stats. 4/4 tests run the real handlers on simulated events (Docker-free), including a drift check against the shared ABI and refusal of impossible history. **Running on the test stack** (owner's shared VPS: Envio + postgres 18.3 + Hasura 2.43.0) against a Monad mainnet fork, it indexed the E2E payments exactly: 4 payments, 8 events equal to raw `eth_getLogs`, and `activeLiability` equal to on-chain `totalActiveLiability` at finalized | Mainnet deploy after escrow GO (HyperSync primary + RPC fallback); wire web history to its GraphQL | 2026-09-30 | core team (owner-assigned) |
| SMS provider | Core (link mode) | VERIFIED_DOCS (adapters) / **BLOCKED for Nigeria** | Twilio Verify + Termii APIs verified from official docs, adapters tested against mocked HTTP; the full flow was run with the SIMULATED provider on a mainnet fork (VERIFIED §4.4–4.5, `evidence/claims-v0/`) | Owner: choose a provider + create the account. Nigeria MTN/Airtel/9mobile need a registered alphanumeric sender ID (2–3 weeks) and DND may filter OTPs, so there is no proven NG delivery before Oct 12. Live test sends to NG/UK numbers are required. Otherwise the §12.4 weaker fallback needs owner approval | 2026-09-29 | core team |
| Claims / approver server (server/claims) | Core (link mode) | VERIFIED_FORK | 15/15 tests; invite → code → approval → on-chain `claimLinkPayment` paid the recipient in real AUSD on a fork; link-holder-only SMS trigger, progressive cooldown with no permanent lockout, phone AES-GCM at rest, no OTP storage (`evidence/claims-v0/`) | Approver key → KMS; live SMS provider; deploy after escrow GO | 2026-09-29 | core team (owner-assigned) |
| Voice object storage | Core (messages) | UNKNOWN | — | Choose (R2 / S3-compatible); private bucket, signed reads | 2026-09-29 | Codex |
| Monad multisig (escrow owner) | Ops | VERIFIED_CODE | Safe v1.4.1 canonical on 143; on-chain bytecode matches the Safe registry codeHash; listed by Monad docs (VERIFIED §4.3) | Create a test Safe via the UI, then transferOwnership + acceptOwnership before broader exposure | 2026-09-29 | core team |
| Ramp | Optional | DISABLED | — | Gate: master §31.1 | 2026-09-29 | — |
| Aurora Intents | Optional | DISABLED | — | Gate: master §31.2 | 2026-09-29 | — |
| Monday Trade ("Own a Piece") | Optional | DISABLED | — | Gate: master §34.1 (programmatic RWA execution unproven) | 2026-09-29 | — |
| Payout provider (Paycrest candidate) | Optional | DISABLED | — | Gate: master §33.2 | 2026-09-29 | — |
| Circle CCTP | Optional | DISABLED | — | Moves USDC, not AUSD; addresses/domains unverified | 2026-09-29 | — |
| Unlink | Optional (stretch) | DISABLED | — | Gate: master §28.2 | 2026-09-29 | — |
| Chainlink CRE | Optional (stretch) | DISABLED | — | Never for claim/cancel/refund | 2026-09-29 | — |

Rules: never display SIMULATED as LIVE; never invent receipts, transaction hashes, users or volume.
