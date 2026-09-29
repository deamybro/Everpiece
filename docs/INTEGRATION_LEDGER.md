# INTEGRATION_LEDGER.md

This file answers: **how ready is it?** Facts live in `VERIFIED.md`.

Statuses: UNKNOWN · RESEARCHING · VERIFIED_DOCS · VERIFIED_CODE · VERIFIED_LOCAL · VERIFIED_FORK · VERIFIED_SANDBOX · VERIFIED_MAINNET · BLOCKED · DISABLED

Feature flags all start `false` (master §36): RAMP, AURORA, PAYOUT, PIECES, PRIVATE_SEND, CRE.

| Integration | Core? | Status | Evidence | Blockers / next step | Last checked | Owner |
|---|---|---|---|---|---|---|
| Monad mainnet | Core | VERIFIED_DOCS | Chain 143 via live RPC; gas / reserve-balance / async docs read; Foundry 1.8.3 with `network = "monad"` installed (VERIFIED §1) | RPC block-tag/finality semantics for relayer; claim QuickNode/Tenderly perks | 2026-09-29 | core team |
| AUSD | Core | **VERIFIED_FORK** | Sourcify source; live reads; 21/21 fork tests under Monad rules incl. live acceptance of vector V_U3 (`evidence/milestone1/ausd-fork-probe`) | Port to `contracts/test/fork/`; mainnet canary after GO | 2026-09-29 | core team |
| Mera | Core | VERIFIED_CODE | `@category-labs/mera@0.2.0` types; official recipe frozen as `EVERPIECE_ACCOUNT_V1` with 3-implementation vectors (`evidence/milestone1/account-derivation`) | Real devices: budget Android/Chrome+GPM, iOS Safari, WhatsApp/Telegram WebViews; production rpId | 2026-09-29 | core team |
| Envio | Core-support | VERIFIED_DOCS | Envio lists Monad 143 as first-class mainnet (VERIFIED §4.1) | Read HyperIndex config docs at indexer milestone | 2026-09-29 | Codex (Phase B) |
| SMS provider | Core (link mode) | UNKNOWN | — | Choose provider; verify NG/UK/intl delivery, pricing, limits, sender-ID, auth (master §12.2) | 2026-09-29 | Codex |
| Voice object storage | Core (messages) | UNKNOWN | — | Choose (R2 / S3-compatible); private bucket, signed reads | 2026-09-29 | Codex |
| Monad multisig (escrow owner) | Ops | UNKNOWN | — | Verify a Safe (or other) deployment on 143 before broader exposure (D8) | 2026-09-29 | core team |
| Ramp | Optional | DISABLED | — | Gate: master §31.1 | 2026-09-29 | — |
| Aurora Intents | Optional | DISABLED | — | Gate: master §31.2 | 2026-09-29 | — |
| Monday Trade ("Own a Piece") | Optional | DISABLED | — | Gate: master §34.1 (programmatic RWA execution unproven) | 2026-09-29 | — |
| Payout provider (Paycrest candidate) | Optional | DISABLED | — | Gate: master §33.2 | 2026-09-29 | — |
| Circle CCTP | Optional | DISABLED | — | Moves USDC, not AUSD; addresses/domains unverified | 2026-09-29 | — |
| Unlink | Optional (stretch) | DISABLED | — | Gate: master §28.2 | 2026-09-29 | — |
| Chainlink CRE | Optional (stretch) | DISABLED | — | Never for claim/cancel/refund | 2026-09-29 | — |

Rules: never display SIMULATED as LIVE; never invent receipts, transaction hashes, users or volume.
