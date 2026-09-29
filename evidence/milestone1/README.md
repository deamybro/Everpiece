# Milestone 1 evidence (2026-09-29, the core team)

Non-secret evidence only. Test keys are the scalars 1–5; never fund those addresses.

- `ausd-fork-probe/` — Foundry 1.8.3, `network = "monad"`, forked from https://rpc.monad.xyz at block ~108,896,566.
  21/21 pass: 16 AUSD behavior probes + 5 ESCROW_SPEC v0.2 vector checks (incl. live AUSD accepting vector V_U3).
  To re-run: `forge init --no-git probe && cp -r ausd-fork-probe/* probe/ && cd probe && forge test -vv`.
- `vectors/` — `vectors.sh` (cast) generates ESCROW_SPEC §16; `vectors.out` is its output; `pi_typed.json` is the
  typed-data JSON used to cross-check the PaymentIntent digest with `cast wallet sign --data`.
- `account-derivation/` — EVERPIECE_ACCOUNT_V1 vectors (Mera recipe) via @scure/bip39+bip32 2.4.0, cross-checked with
  `cast wallet address --mnemonic` and `@category-labs/mera@0.2.0` `getEvmAddress`. Fixture PRF outputs are synthetic.
