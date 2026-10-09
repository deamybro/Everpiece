import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUALITY_POLICY, evaluateQuote, executionPriceMicroUsd, recipientProblem, INVEST_ASSETS, type QuoteEvidence } from "../src/index.ts";

const NOW = 1_791_331_200n;
const E18 = 10n ** 18n;
const NVDA_REF = 239_240_000n; // $239.24 close 2026-10-06 (stockanalysis.com), micro-dollars
// Real Kuru Flow evidence (evidence/kuru-astocks-2026-10-07/quotes.json, sim.json): $5 → 0.016625627097459321 aNVDA
const real5: QuoteEvidence = {
  amountInUsd: 5_000_000n, expectedOut: 16_625_627_097_459_321n, minOut: 16_572_425_090_747_451n, decimals: 18,
  referencePriceMicroUsd: NVDA_REF, probePriceMicroUsd: null, simulated: true, expiresAt: NOW + 30n,
};

test("execution price is bigint math: $5 for 0.016625… aNVDA ≈ $300.74", () => {
  assert.equal(executionPriceMicroUsd(5_000_000n, 16_625_627_097_459_321n, 18), 300_740_535n);
  assert.equal(executionPriceMicroUsd(5_000_000n, 0n, 18), null);
});

test("the real aNVDA route is rejected: +25.7% over NVDA (deviation) — shown as LOW_LIQUIDITY, never executable", () => {
  const r = evaluateQuote(real5, DEFAULT_QUALITY_POLICY, NOW);
  assert.equal(r.status, "LOW_LIQUIDITY");
  assert.deepEqual(r.failures, ["PRICE_DEVIATION"]);
  assert.equal(r.deviationBps, 2570);
  // $25 on the same route: price impact vs the $5 probe too (+21.8%)
  const r25 = evaluateQuote({ ...real5, amountInUsd: 25_000_000n, expectedOut: 68_268_111_247_242_981n, minOut: 68_049_653_291_251_803n, probePriceMicroUsd: 300_740_535n }, DEFAULT_QUALITY_POLICY, NOW);
  assert.deepEqual(r25.failures, ["PRICE_DEVIATION", "PRICE_IMPACT"]);
});

test("no route, failed simulation, unsimulated, expired quote, wide slippage, no reference → UNAVAILABLE", () => {
  assert.deepEqual(evaluateQuote(null, DEFAULT_QUALITY_POLICY, NOW).failures, ["NO_ROUTE"]);
  const fair = { ...real5, expectedOut: (5_000_000n * E18) / 240_000_000n, minOut: (5_000_000n * E18) / 240_500_000n }; // ≈ $240
  assert.equal(evaluateQuote(fair, DEFAULT_QUALITY_POLICY, NOW).status, "AVAILABLE"); // a tiny, fair, simulated quote
  assert.deepEqual(evaluateQuote({ ...fair, simulated: false }, DEFAULT_QUALITY_POLICY, NOW).failures, ["SIMULATION_FAILED"]);
  assert.deepEqual(evaluateQuote({ ...fair, simulated: null }, DEFAULT_QUALITY_POLICY, NOW).failures, ["NOT_SIMULATED"]);
  assert.deepEqual(evaluateQuote({ ...fair, expiresAt: NOW }, DEFAULT_QUALITY_POLICY, NOW).failures, ["QUOTE_EXPIRED"]);
  assert.deepEqual(evaluateQuote({ ...fair, minOut: fair.expectedOut / 2n }, DEFAULT_QUALITY_POLICY, NOW).failures, ["SLIPPAGE"]);
  const noRef = evaluateQuote({ ...fair, referencePriceMicroUsd: null }, DEFAULT_QUALITY_POLICY, NOW);
  assert.equal(noRef.status, "UNAVAILABLE");
  assert.deepEqual(noRef.failures, ["NO_REFERENCE_PRICE"]);
  for (const s of ["SIMULATION_FAILED", "QUOTE_EXPIRED", "SLIPPAGE"] as const) {
    assert.equal(evaluateQuote({ ...real5, simulated: s === "SIMULATION_FAILED" ? false : true, expiresAt: s === "QUOTE_EXPIRED" ? NOW : NOW + 30n, minOut: s === "SLIPPAGE" ? 1n : real5.minOut }, DEFAULT_QUALITY_POLICY, NOW).status, "UNAVAILABLE", s);
  }
});

test("recipient binding: a route delivering to anyone but the owner is refused", () => {
  const owner = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  assert.equal(recipientProblem({ recipient: owner.toLowerCase() as `0x${string}` }, owner), null);
  assert.equal(recipientProblem({ recipient: "0x000000000000000000000000000000000000dEaD" }, owner), "RECIPIENT_MISMATCH");
});

test("registry: only on-chain-verified aStock addresses; unknown tokens are not assets", () => {
  assert.deepEqual(INVEST_ASSETS.map((a) => a.id), ["aNVDA", "aAAPL", "aMSFT"]);
  for (const a of INVEST_ASSETS) assert.match(a.verification, /on-chain/);
});

test("Anchored StockOracle: documented priceId derivation, 8dp → micro-dollars, fail closed when stale", async () => {
  const { priceIdOf, referenceFromOracle, ORACLE_MAX_AGE_SEC } = await import("../src/index.ts");
  assert.equal(priceIdOf(" nvda "), priceIdOf("NVDA"));
  // live read 2026-10-09: NVDA 229.52 (bid 229.51 / ask 229.53), REGULAR session
  const p = { price: 22_952_000_000n, bestBid: 22_951_000_000n, bestAsk: 22_953_000_000n, feedUpdateTimestamp: 1_791_568_987n, session: 2 };
  const r = referenceFromOracle("NVDA", p, 1_791_570_142n);
  assert.equal(r.priceMicroUsd, 229_520_000n);
  assert.equal(r.session, "REGULAR");
  assert.equal(r.stale, false);
  assert.equal(referenceFromOracle("NVDA", p, 1_791_568_987n + ORACLE_MAX_AGE_SEC + 1n).stale, true);
});

test("today's aNVDA route fails the policy against the oracle reference (never executable)", async () => {
  const { evaluateQuote, DEFAULT_QUALITY_POLICY } = await import("../src/index.ts");
  // $5 USDC → 0.018584516 aNVDA (Kuru Flow, 2026-10-09); reference $229.52
  const v = evaluateQuote({ amountInUsd: 5_000_000n, expectedOut: 18_584_516_141_920_770n, minOut: 18_584_516_141_920_770n, decimals: 18,
    referencePriceMicroUsd: 229_520_000n, probePriceMicroUsd: 255_790_000n, simulated: true, expiresAt: 2n ** 62n }, DEFAULT_QUALITY_POLICY, 0n);
  assert.equal(v.status, "LOW_LIQUIDITY");
  assert.ok(v.failures.includes("PRICE_DEVIATION"));
  assert.ok((v.deviationBps ?? 0) > 1_500);
});
