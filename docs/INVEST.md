# Invest

Tokenized US stocks (Anchored aStocks on Monad) as part of an Everpiece money account, not as a trading terminal.
Code: `packages/shared/src/invest.ts` (registry, quality policy, providers, availability snapshot), `web/app/invest/page.tsx`.

## When an asset is "Available"

An asset is `AVAILABLE` only when **all** of these hold:
1. a real route exists (an ERC-20 existing proves nothing);
2. the quote passes `DEFAULT_QUALITY_POLICY`: at most 300 bps deviation from the reference price, 200 bps price impact and 100 bps slippage;
3. the built transaction simulates;
4. the route delivers to the owner (`recipientProblem`);
5. the owner is eligible. Anchored aStocks are for eligible, qualified investors and are not available to US persons and some other jurisdictions.

Otherwise the asset is `LOW_LIQUIDITY` (a route exists but its market quality fails), `UNAVAILABLE`, `COMING_SOON` or `RESTRICTED`.
The app never shows a price without a live, verified quote, and never offers a buy for an asset that is not `AVAILABLE`.

## Current state (2026-10-08): nothing is offered

Read-only Kuru Flow scan of 10 aStocks from USDC, AUSD and MON at $1–$25, at block 111501031. Nothing was signed or sent.
Evidence: `evidence/kuru-astocks-2026-10-08/` (`discover.mjs`, `discovery.json`).

| Asset | Result | Status |
|---|---|---|
| aNVDA | Routes from all three inputs. Effective price $263.19 (at $1) → $276.38 ($5) → $342.43 ($25) per token; about 500 bps impact by $5 | `LOW_LIQUIDITY` |
| aAAPL, aMSFT, aTSLA, aAMZN, aMETA, aAMD, aPLTR, aAVGO | "no candidate paths available between tokens" from every input | `UNAVAILABLE` |
| aGOOGL | Kuru answered "insufficient liquidity" (AUSD, MON) and timed out (USDC) | `UNAVAILABLE` |

Kuru order books: none of the 597 registered markets lists an aStock (same as the 2026-10-07 check, `docs/INTEGRATION_VERIFICATION.md`).
Only aNVDA, aAAPL and aMSFT are in the app's registry (verified on-chain name, symbol and decimals); the other seven were only scanned.

## Re-check

Re-run `evidence/kuru-astocks-2026-10-08/discover.mjs`; it is read-only and takes about 90 minutes, because Kuru takes ~30 s to answer "no route".
Update `INVEST_AVAILABILITY` with the date, and enable a provider only after a route passes the policy and simulates.
