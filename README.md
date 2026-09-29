# Everpiece

**Send money to the right person, and let them choose what it becomes.**

Everpiece is a mobile-first web app / installable PWA on Monad for protected person-to-person Dollar payments:
- The sender's Dollars (AUSD) stay in escrow until the intended recipient claims them.
- The sender can cancel before expiry, and anyone can return an expired payment to the sender.
- Users never need MON; a relayer pays gas.

## Status

| Component | State |
|---|---|
| `contracts/`: EverpieceEscrow v1 | Implemented; 177 tests green incl. a Monad mainnet fork against real AUSD; Slither 0 high/medium. **Not deployed.** Awaiting the adversarial review |
| `packages/shared` | ABI, EIP-712 typed data, commitments, account recipe, canonical vectors |
| `server/relayer` | Implemented: allow-listed gasless relayer with simulation, serialized nonces and finality-gated confirmation; 24 tests incl. a Monad fork with real AUSD. Not deployed |
| `server/claims` | Implemented: link-mode recipient verification (SMS OTP via Twilio Verify or Termii; SIMULATED for local tests only) and short-lived ClaimApproval signing; 15 tests incl. an end-to-end on-chain link claim on a Monad fork. Live SMS not yet configured |
| `web/`, `indexer/` | Not started |
| Optional integrations | All disabled (`docs/INTEGRATION_LEDGER.md`) |

## Layout

```text
contracts/        Foundry project (network = "monad")
  src/            EverpieceEscrow.sol, interfaces
  test/           unit, boundary, authorization, race, vectors, fuzz, invariant, fork; adversarial/ (reviewer-owned)
  script/         deploy script (asserts verified facts; simulate before any broadcast)
packages/shared/  the ONLY source of ABI / typed data / vectors for apps
server/relayer/   gasless relayer (see its README)
server/claims/    claims/approver server (see its README)
docs/             the eight project documents (start with docs/HANDOFF.md)
evidence/         non-secret test/fork/analysis evidence
scripts/          generators
```

## Quick start

```bash
git clone --recurse-submodules <repo> && cd <repo>/contracts
forge test                                   # offline suites
RUN_FORK_TESTS=true forge test               # + real Monad AUSD fork (uses https://rpc.monad.xyz or $MONAD_RPC)
cd .. && npm ci && npm test                    # shared vectors (viem) + relayer unit tests
RUN_FORK_TESTS=true npm test -w @everpiece/relayer   # relayer vs anvil fork with real AUSD
```

Requires Foundry ≥ 1.8 (pinned 1.8.3) and Node ≥ 24.

## Key documents

`docs/ESCROW_SPEC.md` (the contract spec, vectors, §22 implementation notes) · `docs/THREAT_MODEL.md` · `docs/VERIFIED.md` (every external fact with sources) · `docs/HANDOFF.md` (current state and next steps) · `MASTER_PROMPT.md` (engineering source of truth).

Nothing here should be treated as audited. Mainnet deployment requires the owner's explicit approval.
