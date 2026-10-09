# Mainnet audit: USDC + AUSD (2026-10-09)

Scope: the mainnet mandate's first task (§43). Nothing was broadcast. Every mainnet claim here was either read live from
`rpc.monad.xyz` or simulated on a fork of current mainnet (block ≈ 111.9M). Facts are in `docs/VERIFIED.md` (§2, §4.11, §4.14, §4.17, §4.18).

## 1. Findings that changed the design

1. **EverpiecePay (v1) made AUSD mandatory.** The recipient always received AUSD. A USDC payer was always swapped USDC → AUSD through the permissioned Agora pair, and no USDC → USDC path existed. On mainnet, Everpiece is not an Agora APPROVED_SWAPPER, so v1 could not accept USDC at all. **Do not deploy v1 to mainnet.**
2. **USDC can be a direct, first-class asset.** Monad USDC (FiatToken v2.2, domain "USDC"/"2") has the same payee-checked ERC-3009 `receiveWithAuthorization` as AUSD, including the packed-bytes overload. Proven on a fork: `test/fork/UsdcProbe.t.sol`, 9 tests.
3. **Why the escrow, Earn and Pay all rejected USDC:** each calls AUSD's `isReceiveWithAuthorizationUpgraded()` fail-closed, and USDC has no such function, so the call reverts.
4. **Everything else that assumed USDC → AUSD:**
   - `packages/shared/src/pay.ts`: the mainnet registry routes USDC only through `AGORA_INSTANT_SETTLEMENT`; `ausdFor` treats AUSD as the only direct asset.
   - Relayer:
     - `config.ts`: the Aurora destination must have an Agora route to AUSD.
     - `actions.ts`: `payWithAusd` and `payWithToken` take AUSD-only funding.
     - `chain.ts`: startup checks `escrow.AUSD()`.
     - `/v1/quotes`: `buyToken` is always AUSD.
   - Automate (`world.ts`): balances are read from a single `ausd` token.
   - Web:
     - `send/page.tsx` picks the `DIRECT_AUSD` token;
     - `request/page.tsx` and `PayRequest.tsx` treat the request amount as AUSD.
   - Funding (`funding.ts`): Aurora delivers USDC that must then be settled into AUSD.

## 2. What was built (no broadcast)

| Change | Files | Proof |
|---|---|---|
| **EverpiecePayV2**: recipient gets exactly `amount` of the signed `asset` (USDC or AUSD). Same asset = DIRECT; other asset = CONVERTED via the fixed Agora pair (exact output, refund of unused input). One ERC-3009 signature in the source token's domain, nonce = payment id. No owner, no arbitrary calls. `quote()` never reverts: it returns `available=false` when Agora hasn't approved the contract | `src/EverpiecePayV2.sol` | 21 unit tests + fuzz (`test/EverpiecePayV2.t.sol`); 5 mainnet-fork tests on real USDC, AUSD and the pair; TS↔Solidity id vector |
| **EverpieceEscrowUsdc / EverpieceEarnUsdc**: the existing escrow and Earn with only the AUSD-flag read removed (made `internal virtual`; AUSD behaviour unchanged) | `src/EverpieceUsdc.sol`, 2-line change in `EverpieceEscrow.sol` / `EverpieceEarn.sol` | 4 mainnet-fork tests (create/claim/refund/tamper; Aave USDC deposit + accrual); the full AUSD suite, adversarial included, still passes |
| Shared: `payV2.ts` (settlement assets, USDC default, typed data, authorization, structural checks), `flags.ts` (the ten mandated flags, fail-closed; NGN payout and the unbuilt DEX fallback forced off), V2 ABI | `packages/shared` | 8 new tests; token domains equal the live `DOMAIN_SEPARATOR()`s |
| Mainnet deploy script asserting every fact (chain, both token domains, USDC not paused, pair tokens, vault asset) | `script/DeployEverpieceMainnetV2.s.sol` | Simulated against live mainnet: OK |

Test totals:
- 265 offline contract tests pass, 0 fail (9 fork-only skipped).
- Mainnet fork: 30/30 (USDC probe, PayV2, AUSD escrow regression, USDC variants).
- shared: 76/76, typecheck clean.
- relayer: 22/22, typecheck clean.

## 3. Feature table

| FEATURE | CURRENT IMPLEMENTATION | TESTNET STATUS | MAINNET STATUS | BLOCKER | ACTION REQUIRED |
|---|---|---|---|---|---|
| Instant pay, AUSD → AUSD | EverpiecePay v1 (live on testnet); PayV2 DIRECT | Live (v1) | PayV2 fork-proven (≈294k gas) | Owner GO; relayer not wired to V2 | Wire `/v1/pay/v2` + web; deploy V2; canary |
| Instant pay, USDC → USDC (default) | PayV2 DIRECT | None: no verified Monad-testnet USDC. TODO(VERIFY): Circle testnet USDC address on 10143 | Fork-proven (≈349k gas) | Same as above | Same; testnet demo via a TestDollar-style second asset |
| USDC ↔ AUSD conversion (AusdConversionProvider = Agora) | PayV2 CONVERTED via the Agora pair `0xf332…2470` | v1 CTK/AUSD live | Fork-proven only with a *simulated* Agora grant (≈544k gas; quote 1:1, no fee at the fork block) | **Agora APPROVED_SWAPPER for the deployed PayV2 address** (KYC, Agora's decision) | Owner applies to Agora after the deploy; until then `quote()` reports unavailable and the UI must offer only DIRECT |
| DEX fallback (Kuru) | Quotes only (scratch): USDC→AUSD 100.016–100.022%, AUSD→USDC 99.971–99.977% for $1–$10k | — | **Not built** | Kuru Flow returns router calldata; relaying it would be an arbitrary call (forbidden). Needs a fixed adapter to the Kuru AUSD_USDC market `0x699a…3b` | TODO(VERIFY): Kuru orderbook market interface. Flag forced off |
| Protected send, AUSD | EverpieceEscrow | Live; DoD #15 proven | Fork-proven; script exists | Owner GO, F-01 cap decision, Safe owner | Deploy after GO |
| Protected send, USDC | EverpieceEscrowUsdc | — | Fork-proven (create ≈395k gas) | Owner GO; relayer per-asset escrow config; create gas limit must be raised from 350k to ≈450k for USDC | Relayer: one escrow per asset |
| Earn, AUSD (Aave waMonAUSD) | EverpieceEarn | Live on TestYieldVault | Fork-proven | Owner GO | — |
| Earn, USDC (Aave waMonUSDC `0xC554…B8e2`) | EverpieceEarnUsdc | — | Fork-proven: deposit ≈799k gas (cold), 30-day accrual on $100 = 0.348565 USDC (variable, never a constant) | Relayer limit 800k is too tight: raise to ≈900k | Config + UI asset choice |
| Aurora cross-chain funding | Relayer funding config; SIMULATED | Simulated | Not live | Aurora API key (studio.aurora.dev); mainnet-only | Relax the config rule: USDC delivered by Aurora is now directly settleable (no Agora hop) |
| Private payments (TACEO Merces) | None (docs only) | — | Not integrated | Mainnet "limited users, volume caps": 1 USDC/tx, 35 tx/epoch, 100 members; compliance service required; user pays own gas (no relayer documented) | Keep the flag off; revisit when the limits lift |
| Automate (incl. income split, partial completion) | `server/automate`, shared engine | Live | Not live | Reads a single AUSD balance | Make the world per-asset; flag off until done |
| Copilot | Proposes a `RuleSpec` only; holds no keys | Live (proposal only) | Same | — | — |
| Invest | Invest screen with provider records | Display only | NOT_AVAILABLE (aStocks), aNVDA LOW_LIQUIDITY | No safe route | Flag off |
| NGN payout | Paycrest simulated | Simulated | Coming Soon | No live partner | Forced off |
| Feature flags | `packages/shared/src/flags.ts` | — | — | Not yet read by the web app / relayer | Wire both |
| Passkeys, relayer, indexer, directory, claims | Live on testnet | Live | Not deployed | RP ID `everpiece.xyz`, relayer funding (GO), indexer config | After GO |

## 4. Deploy readiness

**Contracts safe to deploy after the owner's GO** (all simulated on mainnet; none broadcast):
- EverpiecePayV2
- EverpieceEscrowUsdc
- EverpieceEarnUsdc
- EverpieceEscrow (AUSD)
- EverpieceEarn (AUSD)

**Do not deploy:** EverpiecePay v1. It is superseded by V2.

**Sequence:**
1. `DeployEverpieceMainnetV2.s.sol`: deploys PayV2, EscrowUsdc and EarnUsdc. Needs `ESCROW_OWNER` (Safe) and `CLAIM_APPROVER`.
2. Optionally deploy the AUSD escrow and AUSD Earn with their existing scripts.
3. Point the relayer and indexer at the new addresses (`DOMAIN` pinning unchanged).
4. Run canaries, all DIRECT and $1:
   1. USDC → USDC;
   2. AUSD → AUSD;
   3. escrow USDC create/claim;
   4. Earn USDC deposit/withdraw.
5. Apply to Agora for APPROVED_SWAPPER for the PayV2 address. Enable `AGORA_SETTLEMENT_ENABLED` only once `quote()` returns available.

**Gas and deployer:**
- The deploy simulation used ≈7.84M gas.
- Forge's worst-case estimate is 1.58 MON at a 202 gwei max fee (base fee was 100 gwei).
- Fund the deployer with ≥2 MON.
- Use a hardware wallet or `--account` keystore, never a key on the command line.

**Relayer gas limits (execution gas measured on the fork, plus margin; still to be confirmed cold, as in `RelayerGas.t.sol`):**

| Action | Measured | Suggested limit |
|---|---|---|
| PayV2 direct USDC | 349k | 420k |
| PayV2 direct AUSD | 294k | 360k |
| PayV2 conversion | 544k | 650k |
| Escrow USDC create | 395k | 450k |
| Earn USDC deposit | 799k | 900k |

**Permissions:**
- **PayV2:** none. No owner; assets and pair are fixed at deployment.
- **Escrow (each asset):** the owner (Ownable2Step) can `pause`/`unpause`, `setCaps` (≤ $500 per payment, ≤ $5,000 total liability) and `setClaimApprover`. The owner can never move funds.
- **Earn:** none.
- **Server keys (names in `.env.example`, values never in git):**
  - `RELAYER_PRIVATE_KEY`: submitter, pays gas only;
  - `APPROVER_PRIVATE_KEY`: claim approver for link claims;
  - `PHONE_ENC_KEY`: phone-number encryption in the claims service;
  - API keys: Resend, Termii, and Aurora once live.
  - None of these can move user funds without a user signature.

**Mainnet feature flags at launch** (recommended; the owner decides):

| Flag | Value |
|---|---|
| `USDC_PAYMENTS_ENABLED` | true, after canary |
| `AUSD_PAYMENTS_ENABLED` | true, after canary |
| `AGORA_SETTLEMENT_ENABLED` | false, until Agora approves |
| `EARN_ENABLED` | true, after canary |
| `DEX_AUSD_FALLBACK_ENABLED` | false |
| `AURORA_LIVE_ENABLED` | false |
| `PRIVATE_PAYMENTS_ENABLED` | false |
| `AUTOMATE_ENABLED` | false |
| `INVEST_ENABLED` | false |
| `NGN_PAYOUT_ENABLED` | false |

## 5. Limitations and residual risks

- **USDC has no on-chain "receive re-routed" flag.** A Circle upgrade could change semantics silently. The exact balance checks bound the damage to a reverted transaction. Circle can blacklist addresses, and a payment to a blacklisted recipient reverts.
- **Escrow `AUSD()` naming:** on EverpieceEscrowUsdc the inherited `AUSD()` getter returns USDC. The ABI is kept for compatibility, and off-chain code must label the asset from config.
- **Adversarial suite:** it runs against MockAUSD semantics. The USDC subclass differs only by the removed flag read, and is covered by real-USDC fork tests rather than a USDC-parametrised adversarial run.
- **Off-chain work still to do before a V2 launch:**
  - relayer `/v1/pay/v2` endpoint and quotes;
  - web Send/Request asset choice, with USDC as the default;
  - indexer `PaidV2` event;
  - Automate per-asset balances;
  - flag wiring.
- **Conversion depends entirely on Agora's approval.** No DEX fallback exists yet. When conversion is unavailable, a payer holding only the other asset cannot pay: they are shown "unavailable" and never a substitute asset.
