# Everpiece Automate

> Money arrives. You decide what it should do next. Money then moves only within limits you signed, and every result can be verified.

**Status (2026-10-07):**
- The engine and persistence are built and tested:
  - `packages/shared/src/automate.ts` (12 tests);
  - `server/automate` (5 HTTP tests).
- No Earn or Invest provider is registered yet, so every target answers `UNAVAILABLE` and nothing moves (docs/EARN.md, docs/INVEST.md).
- Not deployed to the test site yet.

## 1. Principles
- **Deterministic:** `plan(rule, event, context)` is a pure function. Same inputs, same plan.
  - Amounts are bigint AUSD base units (6 dp); no floats anywhere.
- **Signed by the owner:** a rule only exists once its owner has signed it (EIP-712, directory domain).
  - Every change, including pause and resume, is a whole new signed version with a later `updatedAt`.
  - Older versions can't be replayed: re-sending an old "enabled" copy after a pause is refused (409).
- **Copilot proposes, never executes:** natural language → `RuleSpec` → validation → provider availability → preview → owner signature → engine.
  - Copilot holds no keys and calls no money endpoint.
- **Trusted inputs only:** trigger events come from the indexer watcher at finality (internal key, never a browser).
  - Balances and yield come from trusted reads.
  - Client-supplied amounts are never used.
- **Never lose money:** a leg that can't run leaves its money in the balance and the result says so.
  - That money is never redistributed to another leg.
  - The whole run is never reported COMPLETED when part of it didn't happen.

## 2. Rule model (`RuleSpec` + identity)

| Field | Meaning |
|---|---|
| `trigger` | `PAYMENT_RECEIVED {minAmount}` · `BALANCE_ABOVE {keep}` · `SCHEDULE {everySec ≥ 1h, startAt, amount}` · `YIELD_THRESHOLD {positionId, threshold}`. Reserved (refused for now): `STREAM_ACCRUAL`, `PROTECTED_PAYMENT_CLAIMED` |
| `actions[]` (1–6) | `KEEP_BALANCE {bps}` · `DEPOSIT_YIELD {bps, opportunityId}` · `BUY_STOCK {bps, assetId}`. Reserved: `SEND`, `PAYOUT`, `REINVEST_YIELD`. Shares are in basis points and must add up to exactly 10,000 |
| `limits` | `maxPerExecution ≤ maxPerDay ≤ maxPerMonth`, plus `expiresAt` (required, at most 366 days ahead) |
| `authorization` | `CONFIRM_EACH` (works today) or `BOUNDED_MODULE` (refused until the module exists, §5) |
| identity | `id` (bytes32), `owner`, `enabled`, `createdAt`, `updatedAt`, `version` = 1 |

**What the signature covers:**
- The signed `AutomationRule` struct carries the limits and expiry as their own fields, so a wallet can show them.
- It covers the rest through `specHash` = keccak256 of the canonical spec JSON (sorted keys; bigint as decimal strings).
- So a tampered allocation fails verification (tested).

## 3. The engine: how a plan is made
1. **Base:**
   - PAYMENT_RECEIVED: the amount received;
   - BALANCE_ABOVE: spendable − `keep`, where spendable = balance − reserved (pending bank payouts, plus amounts that open executions will move);
   - SCHEDULE: the scheduled amount;
   - YIELD_THRESHOLD: the harvestable yield.
2. **Allocation:** each action gets floor(base × bps / 10,000). The rounding remainder goes to KEEP_BALANCE, or stays unallocated in the balance; it never goes to a leg that moves money.
3. **Availability:** a moving leg whose target is not `AVAILABLE` moves nothing (`UNAVAILABLE`, with the provider's reason). Its share stays in the balance.
4. **Caps:** the moving total is limited to min(maxPerExecution, day left, month left, money source).
   - The money source is the spendable balance, the excess over `keep`, or **the harvestable yield**: principal can never be reached, whatever the limits.
   - The cap scales the moving legs down pro-rata (`LIMITED`); the cut stays in the balance.

**No-run reasons:** RULE_DISABLED, RULE_EXPIRED, TRIGGER_MISMATCH, NOT_OWNER, BELOW_MINIMUM, NOTHING_ABOVE_KEEP, BELOW_THRESHOLD, SELF_TRIGGERED, NOT_DUE, ALREADY_RAN_THIS_PERIOD, LIMIT_REACHED, INSUFFICIENT_BALANCE.
- SELF_TRIGGERED: money that Automate itself moved (for example an Earn withdrawal) never re-triggers a rule.

## 4. Executions, idempotency, states
- **Idempotency key** = `ruleId:eventId:actionIndex`, unique across everything ever planned.
- An execution is unique per (rule, event). A duplicate trigger plans nothing (tested).
- One transaction hash can complete at most one leg.
- **Rule states:** CREATED → AUTHORIZED (signed) → WAITING_TRIGGER, PAUSED, EXPIRED.
- **Execution states:** TRIGGERED → (QUOTING) → READY → EXECUTING → COMPLETED | PARTIALLY_COMPLETED | FAILED.
- **Leg states:** PENDING, KEPT, UNAVAILABLE, LIMITED, EXECUTING, DONE, FAILED.
- **Outcome** (`outcomeOf`):
  - COMPLETED only if every moving leg is DONE and nothing meant to move stayed behind (a limit cut counts as staying behind);
  - some money moved → PARTIALLY_COMPLETED;
  - nothing moved → FAILED.
- **Usage toward limits:** legs that are planned, executing or done count. Failed, unavailable and lapsed legs free their share.
- **Two rules can't spend the same money:** open executions reserve what they will move (tested).
- **Leg reports:**
  - the owner signs `AutomationLegReport {executionId, legIndex, outcome, txHash}`;
  - DONE counts only after a `LegVerifier` proves the transaction on-chain (receipt success, the expected event, the owner as beneficiary, final);
  - a transaction that doesn't match is refused.
- **Lapse:** a READY execution the owner doesn't confirm within `CONFIRM_WINDOW_SEC` (default 24 h) lapses. Its legs fail with NOT_CONFIRMED; the money never left the balance.

## 5. Authorization: what Mera can and cannot do
- **Mera** (`@category-labs/mera` 0.2.0, installed) derives the account key from a passkey and offers a signing session. That's all it offers: **no scoped, session or delegated permissions**.
  - So Mera alone cannot grant "20% of incoming money into Earn, max $200/day, for 30 days" to a server.
  - We don't pretend it can.
- **`CONFIRM_EACH` (built):**
  - each triggered run is planned automatically within the signed limits;
  - the owner confirms it with one fingerprint, which signs the leg transactions themselves;
  - the service verifies the result on-chain.
  - Nothing runs while the owner is away.
- **`BOUNDED_MODULE` (designed, not built; owner decision O-A):** an `EverpieceAutomate` contract would:
  - hold an AUSD allowance capped at the rule's total;
  - check each execution against the rule's signed caps, expiry and allow-listed targets (verified Earn vault, verified swap route) on-chain;
  - send every output to the owner (deposit `onBehalfOf` owner, stock to owner);
  - let the relayer execute.

  It needs its own adversarial suite and owner review before mainnet. Until then the engine refuses `BOUNDED_MODULE` rules (`AUTHORIZATION_NOT_AVAILABLE`).

## 6. Service API (`server/automate`, port 8794, behind the web proxy)

| Method | Path | Who |
|---|---|---|
| POST | `/v1/automate/rules` `{rule, signature}` | owner (create / update / pause / resume) |
| GET | `/v1/automate/rules/<owner>` | anyone: rules + state + provider status of each target + last execution |
| POST | `/v1/automate/triggers` `{event}` | **internal only** (`x-automate-key`) |
| GET | `/v1/automate/executions/by-owner/<owner>` · `/v1/automate/executions/<id>` | anyone |
| POST | `/v1/automate/legs` `{report, signature}` | owner |

**Rate limits:** 30 writes and 240 reads per minute per IP; at most 20 rules per owner. Bodies are capped at 16 KB.

## 7. Next
- Register the verified providers (P2 Earn, P3/P5 Invest) as `TargetRegistry` + `LegVerifier`.
- The indexer watcher (P7) posts PAYMENT_RECEIVED / BALANCE_CHECK / YIELD_CHECK.
- UI: templates (split income; keep X, earn the rest; Earn → Invest; recurring, disabled until scheduling ships), My Rules, and the run timeline.
