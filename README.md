# Everpiece

**Send money to the right person, and let them choose what it becomes.**

Everpiece is a mobile-first web app (installable PWA) on Monad for person-to-person Dollar payments:

- **Passkey accounts (Mera).** A fingerprint or screen lock instead of a wallet; no seed phrase; **users never need MON** (a relayer pays gas).
- **Protected payments (escrow).** The sender's Dollars (AUSD) wait in `EverpieceEscrow` until the intended person claims them:
  - by **@username**, or by **link + a code** sent to their phone or email;
  - the sender can cancel before the claim, and anyone can return an expired payment to the sender.
- **Instant payments** (`EverpiecePay`): final, exact AUSD to the recipient. Pay in Dollars, or in another token that Agora Instant Settlement converts to the exact amount.
- **Payment requests:** "Pay @maris $25" as a signed QR code or link; scan to pay (Android and iPhone); a "paid" mark only after an on-chain proof.
- **Encrypted voice and text notes** with a payment. Only the recipient can open them, and a message outage never blocks the money.
- **History and receipts** from an Envio indexer, with explorer proof for every step.
- **Get paid in naira, to your bank:** recipients add a verified Nigerian bank account; "pay me at least ₦50,000" becomes a QR code; the payer pays in Dollars; "Delivered" only when the payout provider confirms the bank transfer. *Paycrest; SIMULATED on the test site* (`docs/PAYOUT.md`).
- **Add Dollars from another chain:** USDC elsewhere → Aurora Intents → USDC in your own account on Monad → exact Dollars via Agora. *SIMULATED on the test site; not enabled for real money* (`docs/ROUTING.md`).

**Try it:** https://test.everpiece.xyz (Monad testnet, real Agora AUSD, **test money only**).

## Status (2026-10-06)

| Component | State |
|---|---|
| `contracts/`: EverpieceEscrow v1, EverpiecePay | 260/260 tests (unit, boundary, fuzz 10k, invariants, adversarial A01–A40, mainnet + testnet forks, relayer gas limits). Deployed on **Monad testnet** over real Agora AUSD. **Not on mainnet** (owner GO pending) |
| `server/relayer` | Gasless, allow-listed, simulation-gated, finality-confirmed; fork-proven gas limits; payment policy engine (TEST rules); Aurora funding proxy. 40/40 incl. fork |
| `server/claims` | Link-mode recipient verification (Twilio Verify SMS, Resend email) + short-lived claim approvals. 22/22 incl. fork |
| `server/directory`, `server/voice` | @usernames, inbox, message keys, signed payment requests · ciphertext-only message store. 13/13 · 9/9 |
| `packages/shared` | The only source of ABI, typed data, vectors, token registry and funding rules. 36/36 |
| `indexer/` | Envio HyperIndex: payments, timelines, instant payments, stats |
| `web/` | Next.js 16 PWA. Live E2E on testnet: request/scan/pay, add-from-another-chain, history, messages, username |
| Readiness | `docs/READINESS.md`: Definition of Done and the release checklist, with evidence and the owner's open items |

## Layout

```text
contracts/        Foundry (network = "monad"): src/, test/ (incl. fork/, adversarial/), script/
packages/shared/  ABI, EIP-712 typed data, vectors, token registry, funding (Aurora) rules
server/           relayer/ · claims/ · directory/ · voice/
indexer/          Envio HyperIndex
web/              the Everpiece PWA; e2e/ Playwright specs
deploy/test-stack the public test site (Docker on a shared host): push.sh, e2e.sh
scripts/          dev-stack.mjs (local fork stack), testnet-stack.mjs, aurora-sim.mjs, deploy scripts
docs/             start with docs/HANDOFF.md and docs/READINESS.md
```

## Quick start

```bash
git clone --recurse-submodules <repo> && cd <repo>
npm ci && npm test && npm run typecheck                 # shared + servers
cd contracts && forge test                               # offline
RUN_FORK_TESTS=true forge test                           # + real AUSD / Agora forks
npm run dev:stack                                        # local fork stack + web on :3000 (repo root)
```

Requires Foundry 1.8.3 and Node ≥ 24.

## Key documents

- `docs/ESCROW_SPEC.md`: the contract spec.
- `docs/ROUTING.md`: how money reaches exact AUSD; providers and failure handling.
- `docs/FUNDING.md`: cross-chain money rules.
- `docs/THREAT_MODEL.md`.
- `docs/VERIFIED.md`: every external fact, with sources.
- `docs/READINESS.md`.
- `docs/HANDOFF.md`.
- `MASTER_PROMPT.md`: the engineering source of truth.

Nothing here is audited. Any mainnet transaction requires the owner's explicit approval.
