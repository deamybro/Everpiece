# FUNDING.md — Add Dollars from another chain (Aurora Intents + USDC)

Owner direction (2026-10-06): "build it, its part of our main build, use usdc".
Facts and sources: `docs/VERIFIED.md` §4.14. Status: `docs/INTEGRATION_LEDGER.md` (Aurora Intents row).

## How it works

```text
payer's USDC on Base / Ethereum / Arbitrum / …        (the payer's own wallet, outside Everpiece)
  → Aurora Intents, EXACT_OUTPUT                       (deposit address from a quote our relayer checked)
  → USDC in the payer's OWN Everpiece account on Monad
  → one passkey prompt: EverpiecePay.payWithToken to self through the Agora AUSD/USDC pair
  → exactly the requested Dollars (AUSD) in the payer's balance
  → any existing flow: send, request, pay
```

- **Code:**
  - `packages/shared/src/funding.ts`: request/response rules.
  - `server/relayer/src/funding.ts`: the Aurora proxy. The key stays server-side.
  - `web/app/add/page.tsx` and `web/lib/funding.ts`: the screens and client.
  - `scripts/aurora-sim.mjs`: the test site's SIMULATED Aurora.
- **Why the payer's own account, not the recipient's:**
  - Converting to exact AUSD needs the payer's signature.
  - If anything after arrival fails, the USDC is simply theirs, in their account. Nothing is ever stranded in a contract.
  - Every existing payment path (escrow, instant, requests) stays unchanged.
- **The amount Aurora is asked to deliver** = the conversion quote's ceiling (`maxSellAmount`, 0.5% headroom) minus any USDC already in the account. Unused headroom stays in the account and counts first next time.

## Money rules — defaults built, owner to confirm (AGENTS.md "money semantics")

| # | Question | Built default | Alternatives |
|---|---|---|---|
| M1 | Who pays Aurora's fee? | The payer. It's inside the amount they send, and shown before they send anything ("about $x (Aurora; Everpiece adds nothing)") | Everpiece subsidises it; or Everpiece adds an integrator fee (`appFees`, 60% to Everpiece) |
| M2 | Everpiece fee | None | An integrator fee in bps (Aurora's floor on stables is max(2 bps, 40% of ours)) |
| M3 | Refunds if the cross-chain step fails, is too small or is late | Aurora refunds to the payer's own address on the origin chain (`refundType: ORIGIN_CHAIN`), which they enter and see on the price screen | Refund to an Intents account (needs NEAR-side handling) |
| M4 | USDC arrived but the conversion fails (price moved, Agora paused, not approved) | It stays in the payer's Everpiece account as USDC. "Convert" can be retried; it counts toward the next top-up | Auto-retry; or let the payer pay in USDC directly where routes allow |
| M5 | Limits | ≤ 600 whole USDC per top-up (above the $500 payment ceiling); per-IP rate limits; $1 minimum | Per-account daily caps; KYC-tier limits |
| M6 | Input buffer | 0.5% (`FUNDING_SLIPPAGE_BPS=50`); Aurora refunds the unused part | Lower (risk of underfunding) or higher |
| M7 | Deadline | 30 minutes; deposits after it are refunded | Longer for slow chains |
| M8 | Origin chains | EVM chains with USDC in Aurora's list (Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Gnosis, BNB Chain), so the refund address is a checkable 0x address | Add Solana / others (needs per-chain address validation) |

## Before mainnet (owner)

1. **Aurora API key** from Intents Studio (studio.aurora.dev) → host env `AURORA_API_KEY`; web `NEXT_PUBLIC_FUNDING=live`.
2. **Agora approval:** EverpiecePay's mainnet address needs `APPROVED_SWAPPER` on the AUSD/USDC pair `0xf332…2470`. This is Agora's KYC; testnet self-whitelisting doesn't exist on mainnet.
3. **Confirm M1–M8** (or choose alternatives).
4. **Mainnet GO, then one small real top-up** (e.g. $5 from Base) checked end to end: the deposit, Aurora status SUCCESS, USDC arrival on Monad, the conversion receipt and the `Paid` event at finality.

## Test site

https://test.everpiece.xyz runs a **SIMULATED** Aurora. It's labelled on every screen:

- "Base (simulated)";
- "Simulate the deposit (test only)";
- test CTK is delivered instead of USDC, because CTK is what testnet converts to AUSD.

The relayer's real adapter, the real Agora conversion on testnet and the app are all exercised (`web/e2e/add.spec.ts`). Nothing crosses a chain there.
