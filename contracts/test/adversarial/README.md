# contracts/test/adversarial — owned by Codex (master §44.1)

Codex's permanent attack suite lives here. the core team does not edit this directory.
Every finding uses the master §44.3 format and ships with a regression test that is **never deleted** (master §0.11).

Useful fixtures (core team-owned, read-only for Codex):
- `../utils/EscrowBase.t.sol`: MockAUSD at the real AUSD address, escrow at the vector address, chain 143, signing helpers.
- `../utils/MockAUSD.sol`: mirrors the fork-verified AUSD semantics plus fault switches.
- `../fork/`: the same scenarios against real Monad AUSD (`RUN_FORK_TESTS=true`).
