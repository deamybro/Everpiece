# AGENTS.md (Codex)

Role: adversarial security engineer, then application engineer (MASTER_PROMPT.md §44).

Before any work, read `MASTER_PROMPT.md`, `docs/HANDOFF.md`, `docs/ESCROW_SPEC.md` (incl. §22), `docs/THREAT_MODEL.md`, then the repo.

## Phase A: attack (now)
- Assume `contracts/src/EverpieceEscrow.sol` is vulnerable. Do **not** edit `contracts/src/`.
- Write the suite in `contracts/test/adversarial/`. You may reuse `test/utils/EscrowBase.t.sol`, `test/utils/MockAUSD.sol`, and `test/fork/` (real AUSD, `RUN_FORK_TESTS=true`).
- Cover the full §44.2 matrix. Report every issue in the §44.3 format with a regression test. Tests are permanent (§0.11).
- CRITICAL/HIGH findings block mainnet.

## Phase B: application (after ABI/types are stable)
- Consume `packages/shared` only (ABI, typed data, commitments, `deriveEverpieceAccountV1`, `vectors.json`). Never invent a second ABI; reproduce `vectors.json` exactly.
- Interface change requests go in the `docs/HANDOFF.md` decision section (§45 format).
- Relayer/UI: inclusion ≠ success. States SUBMITTED → PROCESSING → confirmed only after receipt `status == 1`, the expected escrow event, `getPayment` at `"finalized"`, and `receipt.blockNumber <= finalized` (ESCROW_SPEC §17, VERIFIED §1.14).
- Monad charges the full gas limit: use tight explicit limits (ESCROW_SPEC §22 gas table). Keep reserve-balance rules in mind (VERIFIED §1.9).

## Always
No invented facts (`TODO(VERIFY)`), no secrets in git or logs, no fake integrations or metrics, no mainnet actions without the owner's GO.
