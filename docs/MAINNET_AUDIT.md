# Mainnet status (2026-10-09)

Nothing has been broadcast. "Fork-proven" below means run against a fork of current Monad mainnet with real tokens and protocols. Facts: `docs/VERIFIED.md` §4.11, §4.14, §4.17–4.20.

## What works (code + tests)

| Feature | How | Evidence |
|---|---|---|
| USDC and AUSD send/receive, USDC default | EverpiecePayV2: recipient gets exactly the signed asset and amount; one signature; no owner | 30 unit + fuzz tests; mainnet fork (direct USDC 307,702 gas, direct AUSD 271,199) |
| USDC ↔ AUSD conversion | Agora pair when Agora has approved us, else EverpieceStableConverter on the fixed Uniswap v4 AUSD/USDC pool (no aggregator calldata). Otherwise a truthful fallback (deliver USDC, labelled) or revert with nothing moved | Fork: 100 AUSD for 99.982929 USDC; AUSD→USDC; worst case 664,077 gas fits the 800k limit; partial fills refused |
| Protected sends, claims, refunds, usernames, links, QR, messages, voice | Unchanged AUSD escrow + EverpieceEscrowUsdc | Full suite incl. adversarial; USDC escrow fork create/claim/refund |
| Requests in USDC or AUSD, pay from either | Web Send/Request/Pay; directory `instantV2` proof records fallbacks as such | relayer, directory, indexer tests |
| External wallet pays a request (no account) | Aurora Intents deposit address delivers USDC straight to the requester; directory checks the finalized delivery tx (once per request) | directory tests; Aurora client unchanged (real API) |
| Earn in USDC and AUSD | EverpieceEarnUsdc / EverpieceEarn into Aave wrappers, gasless | Fork: USDC deposit 765,136, withdraw 643,800; real accrual |
| Automate: split income, keep X and earn the rest | Confirm each run (fingerprint), or run by itself through **EverpieceAutomate**: one signed grant (executor, vault, per-run/day/total caps, expiry), revocable | 11 unit + fork with real USDC into Aave (activate 359,751; execute 770,178; revoke 93,494); service: idempotent, failures leave money in the balance, pending legs are never reported failed |
| Private Send / Private Balance | TACEO Merces SDK in the app: join (compliance), move in, send privately, move out; 1 USDC cap enforced | Live read-only: registry, contract code, and a real compliance attestation |
| Invest | Live reference prices from Anchored's on-chain StockOracle; every route checked against them; Anchored HMAC client ready | aNVDA route is +11–17% over the oracle → LOW_LIQUIDITY, no Buy |
| Feature flags | Ten mandated flags, off unless `"true"`; NGN payout forced off (Coming Soon) | relayer enforces; web reads them |

## What genuinely blocks production

1. **Owner GO** to deploy (`DeployEverpieceMainnetV2.s.sol`):
   - deploys converter, PayV2, USDC escrow, USDC Earn and Automate;
   - simulated on mainnet at 12.09M gas, ≤2.44 MON;
   - then fund the relayer and run the canaries below.
2. **Aurora:** an API key from studio.aurora.dev on the relayer (`AURORA_API_KEY`). Without it, cross-chain funding shows as unavailable.
3. **Agora (optional):** APPROVED_SWAPPER for the deployed PayV2. Conversions already work without it via Uniswap v4.
4. **TACEO:** each user's account needs a little MON for gas (no relayer exists). The network's caps are fixed by TACEO: $1 per action, 35 per epoch, 100 members.
5. **Invest:** Anchored requires all of the following. Only Anchored can provide them:
   - a KYC'd professional/qualified investor per wallet;
   - an API key bound to that wallet;
   - a whitelisted egress IP;

   or a partner arrangement. The DEX route fails the price policy.
6. **Naira on/off-ramp:** Coming Soon (forced off).

## Owner approvals needed

| # | Approval | What it covers |
|---|---|---|
| 1 | **Deploy GO** | The five contracts above, from a hardware wallet / keystore, with ≥3 MON |
| 2 | **Relayer funding GO** | MON for gas, and `RELAYER_INTERNAL_KEY` for Automate |
| 3 | **Canary GO** | $1 each: USDC→USDC, AUSD→AUSD, USDC→AUSD (v4), escrow USDC create/claim, Earn USDC in/out, one Automate grant + execution + revoke, one $1 TACEO private send between two test accounts |
| 4 | **Flags** | Which to enable after the canaries |

## Deploy facts

**Permissions:**
- PayV2, the converter, Earn and Automate have no owner.
- The escrow owner (Safe) can only pause, set caps (≤ $500 per payment, ≤ $5,000 total) and rotate the claim approver.

**Server keys:**
- `RELAYER_PRIVATE_KEY`: gas only; also the Automate executor.
- `RELAYER_INTERNAL_KEY`: the Automate service → relayer internal route.
- `APPROVER_PRIVATE_KEY`, `PHONE_ENC_KEY`.
- API keys: Aurora, Resend, Termii.

**Relayer gas limits (fork-measured, pinned by `server/relayer/test/gasLimits.test.ts`):**

| Method | Limit |
|---|---|
| PayV2 direct | 340k |
| PayV2 convert | 800k |
| USDC Earn deposit | 820k |
| USDC Earn withdraw | 700k |
| Automate activate | 400k |
| Automate revoke | 120k |
| Automate execute | 830k |

## Residual risks

- USDC has no on-chain "receive re-routed" flag; balance checks bound any change to a reverted transaction.
- The Uniswap v4 pool is concentrated liquidity: large conversions cost more. The signed max and the 50 bps relayer cap protect the payer.
- Automate deposits are tracked in EverpieceAutomate's `principalOf`; "yield only" sums both ledgers.
