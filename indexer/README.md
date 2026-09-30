# indexer — Everpiece payment history (Envio HyperIndex)

Indexes the four canonical EverpieceEscrow events on Monad mainnet (143) into:

- **Payment**: one row per payment (sender, mode, amount, expiry, status, the recipient once claimed, created/settled block and tx).
- **PaymentEvent**: the timeline (CREATED → CLAIMED | CANCELLED | REFUNDED).
- **Stats**: real metrics from executed events only. `activeLiability` mirrors the escrow's own.

This is **history, not financial truth**. The app still confirms money movements with `getPayment` read at `"finalized"` (ESCROW_SPEC §17).
The handlers throw on impossible history: a settle for an unknown payment, a second settle, or an amount or sender mismatch. A wrong start block fails loudly instead of producing a plausible but wrong history.

## Settings (environment)

| Variable | Production | Tests |
|---|---|---|
| `ENVIO_ESCROW_ADDRESS` | deployed escrow (after the owner's GO) | `0x…01` |
| `ENVIO_ESCROW_START_BLOCK` | the escrow's deployment block | `1` |
| `ENVIO_BLOCK_LAG` | `3` (Monad finalizes at head − 2, VERIFIED §1.14; one block of margin) | `0` (a lag stalls the simulated chain, VERIFIED §4.7) |

## Running

Envio 3.12.1 has **no Windows binary**, so use WSL, Linux or macOS. Installs on `/mnt/c` are very slow; copy the folder to WSL's own disk for development.

```bash
npm ci
ENVIO_ESCROW_START_BLOCK=1 ENVIO_ESCROW_ADDRESS=0x0000000000000000000000000000000000000001 ENVIO_BLOCK_LAG=0 npx envio codegen
npm run typecheck && npm test
```

- `test/handlers.test.ts` runs the real handlers on simulated events with Envio's `createTestIndexer` (no Docker, DB or network).
- `test/abi.test.ts` fails if `config.yaml`'s event signatures drift from the escrow ABI in `packages/shared`.
- Running against a chain (`npm run dev`) needs Docker/Podman locally, or Envio Cloud (GitHub App on push).
- Use npm 11 for installs. npm 10.9 crashes resolving vitest's optional peers ("reading 'edgesOut'").
