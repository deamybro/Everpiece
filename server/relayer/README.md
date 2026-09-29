# @everpiece/relayer

Gasless relayer for EverpieceEscrow (MASTER_PROMPT §26). It holds **MON for gas only** and never custodies AUSD. It is trusted for liveness, **not** safety: every money-relevant field is bound by user signatures that the contract checks.

## Pipeline

```text
HTTP (allow-listed route) → per-IP rate limit → strict schema → off-chain signature precheck
→ idempotency (natural key) → per-signer limits → MON balance guard → daily gas budget
→ eth_call simulation at the explicit gas limit (known reverts rejected, no gas spent)
→ serialized nonce queue → sign + persist raw tx → broadcast → monitor → reconcile
```

- **No arbitrary calldata.** Calldata is encoded server-side from `@everpiece/shared`'s ABI for exactly five methods, and `to` is always the configured escrow.
- **Tight explicit gas limits** per method. Monad charges the full limit (VERIFIED §1.5).
- **Startup safety:** refuses to run if the RPC chain id ≠ `EXPECTED_CHAIN_ID`, the escrow has no code, or `escrow.AUSD()` ≠ the verified AUSD.
- **Nonces:** one serialized sequence per relayer EOA. The signed tx is persisted before broadcast, and silent drops are rebroadcast.

## Request states: inclusion is not success (ESCROW_SPEC §17, VERIFIED §1.14)

| State | Meaning |
|---|---|
| `SUBMITTED` | accepted and simulated, queued |
| `PROCESSING` | broadcast; waiting for execution **and** finality |
| `CONFIRMED` | receipt `status == 1`, the expected escrow event for this `paymentId`, `getPayment` at `"finalized"` in the expected state, and `receipt.blockNumber <= finalized` |
| `FAILED` | broadcast rejected, reverted on-chain, or expected event/state missing; `chainStatus` holds the canonical on-chain status |
| `REJECTED` | refused before broadcast (simulation revert, balance, budget); no gas spent |

UIs must show "Sent / Claimed / Cancelled / Money returned" **only** for `CONFIRMED`.

## API

| Route | Body (all integers as decimal strings; signatures 65-byte hex) |
|---|---|
| `POST /v1/payments/create` | `{ intent: PaymentIntent, ausdSignature }` |
| `POST /v1/payments/claim-username` | `{ paymentId, recipient, recipientSalt, actionNonce, deadline, recipientSig }` |
| `POST /v1/payments/claim-link` | `{ paymentId, recipient, claimKey, recipientSalt, actionNonce, deadline, claimKeySig, approvalNonce, approvalDeadline, approverSig }` |
| `POST /v1/payments/cancel` | `{ paymentId, actionNonce, deadline, senderSig }` |
| `POST /v1/payments/refund` | `{ paymentId }` |
| `GET /v1/requests/:id` | → `{ requestId, method, status, paymentId, txHash, blockNumber, gasUsed, chainStatus, error }` |
| `GET /healthz` | chain id, relayer address/balance, in-flight count |

Responses:
- `202`: accepted.
- `200`: idempotent replay (`idempotent: true`, same `requestId`).
- `400` schema · `401` signature precheck · `404` · `405` · `413` · `415`.
- `422`: decoded escrow/AUSD error name, e.g. `PaymentNotActive`, `RecipientMismatch`, `InvalidSignature`.
- `429` rate limit · `503` balance/budget/upstream.

Build request bodies with `@everpiece/shared` (`fundingAuthorization`, `claimIntent`, `linkClaimIntent`, `claimApproval`, `cancelIntent`).

## Run

```bash
npm ci                                   # at repo root (workspace)
RELAYER_PRIVATE_KEY=… MONAD_RPC=… ESCROW_ADDRESS=… npm start -w @everpiece/relayer
npm test -w @everpiece/relayer           # offline unit tests
RUN_FORK_TESTS=true npm test -w @everpiece/relayer   # + anvil --network monad fork of mainnet with REAL AUSD (needs contracts/out: forge build)
```

Config (env, defaults in `src/config.ts`):
- Connection: `MONAD_RPC`, `EXPECTED_CHAIN_ID` (143), `ESCROW_ADDRESS`, `AUSD_ADDRESS` (verified default), `RELAYER_PRIVATE_KEY`, `PORT`/`HOST` (127.0.0.1), `RELAYER_DB_PATH`.
- Gas: `GAS_LIMIT_*`, `MAX_FEE_PER_GAS_WEI` (500 gwei), `PRIORITY_FEE_WEI` (2 gwei).
- Guards: `MIN_RELAYER_BALANCE_WEI` (11 MON), `DAILY_GAS_BUDGET` (100M gas), `RATE_PER_IP_PER_MINUTE`, `RATE_PER_SIGNER_PER_MINUTE`, `RATE_PER_SIGNER_PER_DAY`, `MIN_PAYMENT_AMOUNT` ($1).
- HTTP: `ALLOWED_ORIGIN`, `TRUST_PROXY`.

## Before mainnet (owner GO required)

- Key in a KMS/HSM-backed signer instead of `RELAYER_PRIVATE_KEY` env (master §0.6).
- Dedicated RPC (QuickNode/Alchemy perk) with a verified fallback; alerting on `level: "alert"` log lines (low balance, stuck tx, budget, unexpected outcome).
- Re-measure gas limits on the deployed escrow (fork observations: `evidence/relayer-v0/`).
- The in-memory rate limiter is per process: run one instance, or move the limits to a shared store.
