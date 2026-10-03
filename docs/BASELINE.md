# Baseline — 2026-10-03 (before the payment-intents / Agora / Android mandate)

Commit `1940535` on `feat/escrow-v1`, clean tree. Everything below was run, not assumed.

## What exists

| Area | Where | State |
|---|---|---|
| Web app (PWA, Next.js 16, mobile-first) | `web/` | Live at https://test.everpiece.xyz on Monad testnet |
| Mera passkey accounts (PRF) | `web/lib/mera.ts` (`@category-labs/mera` 0.2.0, web WebAuthn path) | Create / sign in / one passkey prompt per money action; no seed phrase; nothing private stored except the inbox and message keys (privacy-only) |
| Protected payments (escrow) | `contracts/src/EverpieceEscrow.sol` | AUSD-specific, ERC-3009 funding (nonce = paymentId), USERNAME + LINK claim, cancel before expiry, refund after expiry, caps, pause (never blocks cancel/refund). Deployed on testnet over **TestDollar** (`0x94A25e4c…BFD5`) |
| Gasless relayer | `server/relayer` | Submits create/claim/cancel/refund; CONFIRMED only at finality; 429/5xx retry |
| Claim codes (SMS / email) + claim approver | `server/claims` | Twilio Verify (trial) and Resend (live); approver signs a short-lived ClaimApproval bound to the recipient wallet |
| Usernames, inbox, message keys | `server/directory` | One name per account, lookalike-proof; HPKE message keys |
| Encrypted voice/text messages | `packages/shared/src/voice.ts`, `messageKey.ts`, `server/voice` | Live; tested on a real Android phone (owner) |
| History, receipts, proof page | `indexer/` (Envio), `web/lib/history.ts`, `/r/<id>`, `/proof` | Live |
| Monad config | `web/lib/config.ts`, `scripts/testnet-stack.mjs`, `packages/shared/src/constants.ts` | chain 10143, RPC testnet-rpc.monad.xyz |
| Native Android app | — | **None.** No React Native code, no Java/Android SDK on this machine |
| Instant (non-escrow) send, payment requests/QR, token routing, compliance engine | — | **None** |

## Results

| Check | Result |
|---|---|
| `npm test` (shared, relayer, claims, directory, voice) | 24 + 8 + 12 + 10 + 9 = **63/63** |
| `npm run typecheck` (all workspaces incl. web) | **clean** |
| `forge test` (contracts) | **202 passed, 2 skipped** (fork tests need `RUN_FORK_TESTS=true`) |
| Relayer fork suite (`RUN_FORK_TESTS=true`, 2026-10-02) | 26/26 |
| Indexer (WSL, Envio has no Windows build) | 4/4 (2026-10-02) |
| Playwright on the live testnet site (2026-10-02) | history, message ×2, username passing (username limited by the per-IP sign-up cap) |
| Lint | **no ESLint config in `web/`** (ESLint 10 finds none); typecheck is the static gate today |

## Conflicts between the mandate and what exists (resolved in docs/ARCHITECTURE.md)

1. **AUSD on Monad testnet exists** at `0xa9012a05…22dC` (Agora docs + chain). Our earlier note "AUSD absent on testnet" only checked the mainnet address. It has the exact surface the escrow needs (ERC-3009, `isReceiveWithAuthorizationUpgraded() = false`, 6 decimals, EIP-712 "Agora Dollar" v1, chain 10143). **Decision:** redeploy the unchanged escrow over real testnet AUSD and retire TestDollar.
2. **Android:** the product is a web PWA. Mera supports React Native (Android 9+, `react-native-passkey` 3.6.1), but a React Native app would duplicate every screen. The mandate (§25) says not to throw the web app away and to reuse shared code. **Decision:** an installable Android app as a Trusted Web Activity over the same PWA (Chrome WebAuthn/PRF = Mera's supported web path). It needs a JDK + Android SDK (not installed) and Digital Asset Links on the site.
3. **0x:** its current supported-chains page lists Monad mainnet (143) and no testnet, so on 10143 the 0x provider answers UNSUPPORTED_NETWORK.
4. **Agora swaps are permissioned (APPROVED_SWAPPER), and the pair pulls the input from the caller.** Everpiece users are gasless passkey accounts, so the swap must run inside an Everpiece contract whitelisted through the testnet Whitelister, authorized by the payer's signatures (a CTK permit plus a signed payment authorization).
