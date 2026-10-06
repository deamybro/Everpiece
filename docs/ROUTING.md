# ROUTING.md — how money reaches exact AUSD

Owner direction (2026-10-06):

- Aurora Intents is the **preferred future multi-chain funding provider**, not an AUSD settlement provider.
- Don't implement or enable it yet (see "Status" for what already exists).
- 0x stays an alternative EVM routing provider.
- AUSD is never assumed to be Aurora-deliverable.
- If Aurora completes but Agora fails, the funds stay with the payer and nothing is reversed automatically.
- No real mainnet transaction without owner approval.

Facts: `docs/VERIFIED.md` §4.14 (Aurora, USDC, Agora mainnet pair) and `docs/INTEGRATION_VERIFICATION.md` (Agora testnet, 0x).
Money rules: `docs/FUNDING.md`.

## 1. The one invariant

**Every payment settles as an exact AUSD amount on Monad, through Everpiece's own contracts.**

- Instant: `EverpiecePay`. Protected: `EverpieceEscrow`.
- Providers only bring value *to* the payer or *into* AUSD. None of them is ever the settlement layer, and none of them ever holds a payment.

## 2. Layers and providers

| Layer | Job | Provider | Where | Status |
|---|---|---|---|---|
| **Funding** (cross-chain) | Bring value the payer holds on another chain into **their own** Everpiece/Mera account on Monad, as a verified intermediate asset | **Aurora Intents** (preferred future provider) | origin chain → Monad | Designed; code exists but is **not enabled for real money** (§7) |
| **Settlement** (on Monad) | Turn a Monad asset into **exact** AUSD | `DIRECT_AUSD` (none needed) | Monad | Live (testnet) |
| | | **Agora Instant Settlement** (fixed-output pair, `swapTokensForExactTokens`) inside `EverpiecePay.payWithToken` | Monad | Live on testnet (CTK/AUSD); mainnet USDC/AUSD fork-proven, needs Agora `APPROVED_SWAPPER` |
| | | **0x** (alternative EVM routing provider: exact-buy `buyAmount`, `maxSellAmount`) | Monad mainnet only (no testnet) | Designed, not implemented. `RouteType "ZEROX"` is reserved, and the relayer returns UNSUPPORTED_NETWORK on testnet |
| **Payment** | Exact AUSD → recipient | Instant (`EverpiecePay`) or Protected (`EverpieceEscrow`) | Monad | Live (testnet) |

**Provider choice for settlement, per token:**
- prefer Agora where a pair exists and EverpiecePay is approved (fixed price, exact output, no slippage);
- 0x only where Agora has no route, and only on mainnet, after its own verification and an owner decision;
- never a guessed route: no verified route means `NO_ROUTE` or `UNSUPPORTED_TOKEN`, never a fake quote.

## 3. The multi-chain flow

```text
source asset (e.g. USDC on Base, in the payer's own external wallet)
  │  Aurora Intents · EXACT_OUTPUT · recipient = payer's OWN Everpiece/Mera account · refunds = payer's origin wallet
  ▼
verified Monad intermediate asset in the payer's account      ← prefer USDC (0x7547…f603, VERIFIED §4.14)
  │  one passkey prompt · EverpiecePay.payWithToken · Agora Instant Settlement (fixed output)
  ▼
exact AUSD
  │  Instant (EverpiecePay) or Protected (EverpieceEscrow) Send
  ▼
recipient
```

**Why stop at the payer's own account** instead of sending cross-chain straight into a payment:
- converting to exact AUSD needs the payer's own signature (permit + payment authorization);
- every stage ends with the money in a place the payer controls;
- the payment flows (instant, protected, requests) stay exactly as audited.

### 3.1 Choosing the intermediate asset

An asset may be the Monad intermediate only if **all** of these hold. Today only **USDC** qualifies on mainnet.

1. **Aurora delivers it on Monad.** It appears in **Aurora's own token API** (`GET /tokens/{apiKey}`) with `blockchain = "monad"`. It's matched by exact contract address, never by symbol.
2. **It's in our registry**, with a verified `docs/VERIFIED.md` entry: address, decimals, permit domain.
3. **Agora has an exact-output pair** to AUSD for it, and EverpiecePay holds `APPROVED_SWAPPER` on that pair.
4. **The full conversion is fork-proven**, gas included (`contracts/test/fork/RelayerGas.t.sol`).

### 3.2 AUSD is never assumed to be Aurora-deliverable

- The public NEAR Intents token list (2026-10-06) has Monad **MON, USDC, USDT0 and no AUSD**. Aurora's own list needs an API key and hasn't been checked (TODO(VERIFY)).
- **Even if Aurora lists AUSD on Monad later**, a direct `source → Aurora → AUSD` route needs all of the following before it's used:
  - confirmation in Aurora's own token API;
  - a VERIFIED.md entry;
  - a design change here, because the exact-amount and refund semantics differ from the Agora path;
  - owner approval.
- **Enforced in code:** the relayer refuses `AURORA_DESTINATION_TOKEN` = AUSD, or any token without an Agora route (`server/relayer/src/config.ts`). The web refuses a destination that isn't an Agora-routed token (`web/lib/funding.ts`).

## 4. Order of checks: never start a transfer that can't finish

1. **Agora first.** Quote the settlement (USDC → exact AUSD) before asking Aurora for anything. If Agora can't settle, nothing cross-chain starts:
   - `AGORA_NOT_WHITELISTED`, `NO_ROUTE` or `PROVIDER_UNAVAILABLE`;
   - the pair is paused;
   - EverpiecePay isn't approved.
2. **Aurora quote**, accepted only if it matches what was asked (shared `parseAuroraQuote`):
   - the payer's own Monad account as recipient;
   - the payer's origin wallet as refund address;
   - at least the exact amount out;
   - a deposit address, no memo, a future deadline.
3. **The payer sends** on the origin chain, from their own wallet. Everpiece never signs on other chains.
4. **Arrival** is confirmed by Aurora `SUCCESS` and by the intermediate-asset balance on Monad.
5. **Settlement:** one passkey prompt. Re-quote Agora, then `payWithToken`. CONFIRMED only with the `Paid` event + `settled(id)` at finalized.
6. **Payment**, instant or protected, as today.

## 5. Failure matrix: where the money is, and what happens

| Stage that fails | Where the payer's money is | What Everpiece does | Automatic reverse? |
|---|---|---|---|
| Agora pre-check (step 1) | Untouched, in their origin wallet | Shows why; no Aurora quote is requested | — |
| Aurora quote refused or doesn't match | Untouched | `QUOTE_REFUSED` or `BAD_QUOTE`; nothing to send | — |
| Deposit too small or too late | Aurora refunds to the payer's **origin wallet** | Shows "refunded"/"too small" from Aurora's status | Aurora's own refund only |
| Aurora `FAILED` / `REFUNDED` | Aurora refunds to the payer's origin wallet | Shows it, marks the top-up finished | Aurora's own refund only |
| **Aurora completes, Agora settlement fails** (price moved past the ceiling, pair paused, approval revoked, relayer down, passkey cancelled) | **In the payer's own Everpiece/Mera account on Monad, as the delivered intermediate asset (USDC)** | Says so plainly, with the amount. Keeps the top-up open on Home ("arrived, convert to Dollars"). The payer can retry whenever settlement is available again. The USDC counts first toward any later top-up | **Never.** No automatic USDC → origin-chain route, no automatic re-swap through another provider |
| Instant/Protected payment fails after settlement | Exact AUSD in the payer's balance | The existing payment error handling | — |

**Why no automatic reverse route:**
- A reverse transfer is a new cross-chain transaction, with its own fee, quote, deadline and failure modes. Running one unprompted could lose the payer money or strand it somewhere worse.
- The intermediate asset in the payer's own account is already the safe resting state.
- A future "send it back" would be an explicit, payer-initiated action with its own quote. It isn't built.

## 6. Rules that apply to every route

- **No real mainnet transaction without owner approval.** That covers broadcasts, canaries, relayer funding and real top-ups. Simulated, fork and testnet runs are how routes are proven first.
- Inclusion isn't success: receipt status + expected event + block ≤ finalized (VERIFIED §1.14).
- Every relayer gas limit is fork-proven against the worst case (`RelayerGas.t.sol`, `test/gasLimits.test.ts`). Monad charges the full limit.
- Provider keys stay server-side (the relayer). The app never sees them.
- Every external constant maps to a `docs/VERIFIED.md` entry; otherwise it's `TODO(VERIFY)`.

## 7. Status (2026-10-06)

| Piece | State |
|---|---|
| Funding code (shared `funding.ts`, relayer `/v1/funding/*`, web `/add`, `scripts/aurora-sim.mjs`) | Exists (session 24) |
| Real Aurora (`NEXT_PUBLIC_FUNDING=live`, `AURORA_API_KEY`) | **Not enabled anywhere**: no API key configured; the relayer endpoints answer `FUNDING_UNAVAILABLE` |
| Simulated Aurora on https://test.everpiece.xyz | See `docs/HANDOFF.md` for whether the demo is on (owner decision, 2026-10-06) |
| Agora mainnet USDC/AUSD | Fork-proven; needs Agora `APPROVED_SWAPPER` for EverpiecePay's mainnet address |
| 0x | Verified facts only (mainnet support, exact-buy). No provider code |

**Before real use:**
1. Aurora API key; confirm §3.1(1) in Aurora's own token API.
2. Agora approval.
3. Confirm the FUNDING.md money rules.
4. Owner GO and one small real top-up.
