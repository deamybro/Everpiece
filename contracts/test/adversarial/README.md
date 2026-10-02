# contracts/test/adversarial — the permanent attack suite (master §44.1)

Originally Codex's. The owner reassigned Phase A to the core team on 2026-10-02 ("don't wait for codex, do it urself"; "yes").
A later Codex review may add to it, but no one deletes an attack test (master §0.11).

- `AttackMatrix.t.sol`: every row of master §44.2 (A01–A40) plus fuzz properties, against the escrow's external
  surface only.
- `Reentrancy.t.sol`: a hostile token that calls back into the escrow during funding and payouts.
- `FINDINGS.md`: the coverage table and each finding in the master §44.3 format. **No CRITICAL/HIGH.** F-01 (MEDIUM,
  global liability-cap griefing) needs an owner decision.

Every finding ships with a regression test. `src/` is never edited from here: fixes go through the owner.

Useful fixtures (read-only from here):
- `../utils/EscrowBase.t.sol`: MockAUSD at the real AUSD address, escrow at the vector address, chain 143, signing helpers.
- `../utils/MockAUSD.sol`: mirrors the fork-verified AUSD semantics, plus fault switches.
- `../fork/`: the same scenarios against real Monad AUSD (`RUN_FORK_TESTS=true`).

Run: `forge test --match-path "test/adversarial/*"` (CI depth: `FOUNDRY_PROFILE=ci`).
