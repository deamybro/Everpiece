# HANDOFF.md

Read `MASTER_PROMPT.md` (full v3.2), this file, and the repo before continuing.

---

## Session 3 — 2026-09-29 — EverpieceEscrow v1 implementation

- **Date/time:** 2026-09-29
- **Agent:** Everpiece team
- **Branch:** `feat/escrow-v1` (from `main` @ 4b223f5). Not merged, not pushed; no remote configured.
- **Completed:**
  1. Initialized git; committed the docs, `MASTER_PROMPT.md` (transcribed verbatim from Maris's chat paste; Maris please diff against your original) and Milestone 1 evidence on `main`.
  2. Foundry project `contracts/`: `network = "monad"`, solc 0.8.28, cancun, via-IR; OZ v5.7.0 and forge-std v1.16.2 pinned as submodules.
  3. `EverpieceEscrow.sol` per ESCROW_SPEC v0.2, including:
     - single-signature ERC-3009 funding (nonce = paymentId, all AUSD arguments derived from the intent, exact balance deltas);
     - username claim;
     - two-factor link claim with the approver snapshot;
     - cancel and refund that pause can never block;
     - V1 cap ceilings;
     - the fail-closed AUSD security-mode guard;
     - Ownable2Step with renounce disabled;
     - no admin fund path.
  4. Tests: 177 in total. Unit, exact boundaries, authorization/replay, race/accounting, vectors, fuzz, invariants, and fork against real AUSD.
  5. Slither 0.11.6: 0 high/medium, 13 informational (triaged below).
  6. `packages/shared`: generated ABI, EIP-712 typed data, commitments, `deriveEverpieceAccountV1`, `vectors.json`, and a viem test suite (7/7; 4th independent implementation).
  7. Deploy script with VERIFIED-fact assertions, simulated against mainnet. **Nothing broadcast.**
- **Files changed:**
  - `contracts/{foundry.toml,foundry.lock}`
  - `contracts/src/**`
  - `contracts/test/**` (`adversarial/` has a README only)
  - `contracts/script/DeployEverpieceEscrow.s.sol`
  - `packages/shared/**`
  - `scripts/gen-shared-abi.mjs`
  - `evidence/escrow-v1/**`
  - `docs/{ESCROW_SPEC §22, VERIFIED §1.13/§3.5, THREAT_MODEL §H, INTEGRATION_LEDGER, HANDOFF}`
  - `.gitmodules`
- **Tests run:**
  - `RUN_FORK_TESTS=true FOUNDRY_PROFILE=ci forge test`: **177 passed, 0 failed**.
    - Fuzz: 9 properties × 10,000 runs.
    - Invariants: 8 invariants over 1,024 runs × 128 depth = 131,072 calls.
    - Fork block ≈ 108.92M.
  - `forge test` offline: 149 passed, 2 fork suites skipped.
  - `packages/shared`: `node --test` 7/7; `tsc --noEmit` clean.
  - Outputs are in `evidence/escrow-v1/`.
- **Facts verified:** OZ/forge-std/viem/Slither versions (VERIFIED §1.13). The AUSD receive-upgrade flag is readable on the live system and the guard works on a fork.
- **Open findings:** none CRITICAL/HIGH/MEDIUM known. Slither informational triage:
  - `reentrancy-balance`: the balance-delta check is intentional; `nonReentrant` everywhere; fail-safe.
  - `unused-return`: `tryRecover` error argument ignored on purpose.
  - `timestamp` ×7: expiry semantics by design.
  - `cyclomatic-complexity` (createPayment 13) and naming (`AUSD`, `DOMAIN_SEPARATOR`): accepted.
- **TODO(VERIFY):**
  - hackathon deadline/timezone;
  - Agora bounty text;
  - Monad RPC finality tags for the relayer;
  - a Monad multisig (before broader exposure);
  - ownership of `everpiece.xyz` + HTTPS (before freezing the rpId);
  - SMS provider;
  - the `@noble/curves` key API (link package).
- **Blocked integrations:** all optional integrations DISABLED.
- **Decisions (Maris, this session):** expiry 1 d / 30 d / default 30 d; caps $500 / $5,000 as absolute ceilings; username claim to the committed recipient only; two-factor link claim with approver snapshot; owner-only pause that never blocks cancel/refund; no withdraw/rescue/proxy; single-signature ERC-3009 funding; implement the AUSD security-mode guard (conditions met: present, readable, documented); `EVERPIECE_ACCOUNT_V1` unchanged; no custom recovery; target rpId `everpiece.xyz`, not frozen; git initialized; inclusion ≠ success.
- **Deviations from spec:** ESCROW_SPEC §22 (8 items). None alters money semantics. The notable one: `claimKey` may not equal the snapshotted approver (`InvalidClaimKey`).
- **Next recommended action:**
  1. **Codex Phase A**: an adversarial review and suite against `contracts/src/EverpieceEscrow.sol` in `contracts/test/adversarial/` (prompt below).
  2. Maris: push to GitHub, open a PR `feat/escrow-v1 → main`.
  3. Add CI (forge offline suite + `packages/shared` test/typecheck).
  4. After Codex is green, Maris GO → mainnet deploy + canaries A/B/C at about $10 with `setCaps` lowered first.

### Codex Phase A prompt (paste into Codex)

> Read MASTER_PROMPT.md, docs/ESCROW_SPEC.md (v0.2 + §22), docs/THREAT_MODEL.md and contracts/. Assume contracts/src/EverpieceEscrow.sol is vulnerable. Do not edit contracts/src/. Write your attack suite in contracts/test/adversarial/ (you may reuse test/utils/EscrowBase.t.sol and MockAUSD). Execute the full master §44.2 matrix, independently of the core team's tests. Report every issue in the §44.3 format with a regression test. CRITICAL/HIGH block mainnet.

---

## Session 2 — 2026-09-29 — Milestone 1 reconciliation

- **Date/time:** 2026-09-29
- **Agent:** Everpiece team
- **Branch:** none. The repository is **not yet a git repo** (see Decisions needed).
- **Completed:**
  - Read the full master prompt (pasted in chat) and the Maris decisions D1–D10.
  - Reconciled all eight docs. ESCROW_SPEC is now **v0.2** (change table in §21).
  - Upgraded Foundry to 1.8.3 (attestation-verified) and re-ran all AUSD fork evidence under `network = "monad"`: **21/21 pass**.
  - Regenerated the cryptographic vectors for v0.2, triple-checked (cast manual encoding, Solidity, cast typed-data encoder). V_U3 was accepted by live AUSD.
  - Froze the Mera account recipe as `EVERPIECE_ACCOUNT_V1`. Derivation vectors reproduced by 3 implementations.
  - Verified that Envio supports Monad 143. The hackathon window is 1 Sep – 13 Oct (no time/timezone shown).
  - Saved non-secret evidence to `evidence/milestone1/`.
- **Files changed:** `docs/*.md` (all eight); new `evidence/milestone1/**`.
- **Tests run:** `forge test` (Foundry 1.8.3, `network = "monad"`, Monad mainnet fork ≈ block 108,896,566) → 21 passed, 0 failed. Output: `evidence/milestone1/ausd-fork-probe/forge-test-output-foundry-1.8.3-network-monad.txt`.
- **Facts verified:** VERIFIED §1.12 (toolchain), §2.12 (evidence re-run), §3.4 (exact Mera recipe at tag v0.2.0), §4.1 (Envio), §4.2 (hackathon window).
- **Open findings:** none CRITICAL/HIGH known.
  - New engineering finding: AUSD's `isReceiveWithAuthorizationUpgraded` flag could remove the payee check. The proposed fail-safe guard is ESCROW_SPEC §7.4. Codex to review.
- **TODO(VERIFY):** VERIFIED §5. Plus: real-device WebView/PRF/fragment-handoff tests; SMS provider; production rpId.
- **Blocked integrations:** all optional integrations DISABLED (INTEGRATION_LEDGER).
- **Next recommended action:** **Codex independent review of ESCROW_SPEC v0.2 + vectors** (prompt below) → Maris GO → the core team implements `EverpieceEscrow.sol` (master §58 order).

### Owner decisions applied (Maris, 2026-09-29)

| # | Decision | Where applied |
|---|---|---|
| D1 | Username payment releases only to the committed recipient; sender has no special claim; post-claim movement is a separate recipient-signed action | ESCROW §8.3, §9.2; vector V_U5; T50 |
| D2 | Pause blocks create + claims; cancel/refund always available | ESCROW §10; T70 |
| D3 | Caps $500 / $5,000 are initial **and** absolute; owner may only set ≤ ceiling; canaries ≈ $10 | ESCROW §5, §11; T22 |
| D4 | Approver snapshotted per LINK payment; new payments use the current approver; rotation never invalidates existing payments | ESCROW §9.3, §12; V_L8; T60–T63 |
| D5 | Single AUSD signature approved (deployed behavior verified exactly as tested); full preimage binding; contract derives all ERC-3009 args | ESCROW §6.3, §7; V_N1–V_N11 |
| D6 | Use Mera's documented recipe verbatim; freeze + version it; deterministic vectors; no real PRF in fixtures; voice identity separate from the EVM key | ESCROW §18.6; VERIFIED §3.4; THREAT §K |
| D7 | No invented recovery; document the limitation; cancel/refund is the recovery for unclaimed payments | THREAT §F7; PRODUCT §8 |
| D8 | Maris-controlled owner account OK for canaries; multisig before broader exposure; no extra owner powers | ESCROW §2, §13, §20; THREAT §G4 |
| D9 | Transaction inclusion is not application success | ESCROW §17; PRODUCT §9; THREAT §E6 |
| D10 | Foundry upgraded; version + config recorded | VERIFIED §1.12 |

### Conflicts found between the truncated copy (session 1) and the full master prompt — resolved in v0.2

- Status names (ACTIVE), expiry bounds (1–30 days), **no cancel at/after expiry**, salted versioned recipient commitments, an independent link claim key plus a separate voice secret, no phone data on-chain, action nonces, the approver model, the no-rescue rule. Full list: ESCROW_SPEC §21.

### Decisions still needed from Maris

1. **[CONFIRM] Expiry constants**: 1 day minimum, 30 days maximum, 30-day default (master §8 says Maris confirms before freeze).
2. **`setClaimApprover` owner power.** D4 implies a configurable approver, so the owner needs this one power. It affects new link payments only and cannot claim alone. Confirm.
3. **Pause is owner-only** (no separate hot pauser key), to keep owner surface minimal. Confirm, or ask for a pause-only guardian role.
4. **AUSD upgrade guard** (ESCROW §7.4). If Agora flips that flag, new payments halt. This is fail-safe; confirm, or accept the stranding risk instead.
5. **Production domain / rpId.** Irreversible for user accounts; needed before real onboarding (Oct 3).
6. **`git init` + GitHub repo.** Master §0.10 requires branches, PRs and Conventional Commits; nothing is committed yet.
7. **`MASTER_PROMPT.md` is not in the repo root yet.** This session used the copy pasted in chat. Please add the file so future sessions can read it.

### Codex review request (paste into Codex)

> Read MASTER_PROMPT.md, docs/ESCROW_SPEC.md (v0.2), docs/THREAT_MODEL.md, docs/VERIFIED.md §2, and evidence/milestone1/. Independently review the escrow design and test vectors before any contract is written. Do not write contract code or invent a competing ABI. Re-derive at least V_U2, V_U3, V_L2, V_L4, V_L5 and D1/D2 yourself. Return only: CRITICAL/HIGH design problems; incorrect assumptions; missing attack cases; any disagreement with the single-signature ERC-3009 construction (ESCROW §7). Use the finding format from master §44.3. If no blocking issue remains, reply exactly: "ESCROW SPEC REVIEW: READY FOR IMPLEMENTATION".

---

## Session 1 — 2026-09-29 — Milestone 1 verify/specify

- Repo `C:\monadmetr` was **empty** at start: no files, not a git repo, **no pre-existing code**.
- Verified Monad, AUSD (Sourcify source, live reads, fork probe) and Mera 0.2.0 (VERIFIED.md).
- Drafted ESCROW_SPEC v0.1 from a master prompt **truncated at §4.8**. Superseded by v0.2 above.

## Dependency / tooling log

| Date | Change |
|---|---|
| 2026-09-29 | Foundry 1.6.0 → **1.8.3** via `foundryup` (attestation verified) |
| 2026-09-29 | Evidence-only (not app deps): `@scure/bip39 2.4.0`, `@scure/bip32 2.4.0`, `@noble/hashes 2.2.0`, `@noble/curves 2.2.0`, `@category-labs/mera 0.2.0` |
| — | App pins to set later: `@category-labs/mera` exactly `0.2.0`; OpenZeppelin Contracts TODO(VERIFY) |
