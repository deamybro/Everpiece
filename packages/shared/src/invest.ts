// Everpiece Invest (docs/INVEST.md): tokenized equities as a money-account feature, not a trading terminal. An asset is
// AVAILABLE only when a real route exists, its quote passes the quality policy, the transaction simulates, and the
// owner is eligible. Existence of an ERC-20 proves nothing. Amounts: bigint base units; prices in micro-dollars.
import type { Address, Hex } from "viem";

export type AssetStatus = "AVAILABLE" | "LOW_LIQUIDITY" | "UNAVAILABLE" | "COMING_SOON" | "RESTRICTED";

export type InvestAsset = {
  /** Stable id used in Automate rules (e.g. "aNVDA"). */
  id: string;
  symbol: string;
  company: string;
  issuer: string;
  /** The underlying listed share it tracks (for the reference price). */
  referenceTicker: string;
  chainId: number;
  token: Address;
  decimals: number;
  /** How the token address was verified (never a guessed address). */
  verification: string;
};

/** Verified on-chain (name/symbol/decimals read back; docs/INTEGRATION_VERIFICATION.md, Kuru × Anchored section). */
export const INVEST_ASSETS: readonly InvestAsset[] = [
  { id: "aNVDA", symbol: "aNVDA", company: "NVIDIA", issuer: "Anchored", referenceTicker: "NVDA", chainId: 143, token: "0x701193374879131f923532987c7ef363a91a80eb", decimals: 18, verification: "on-chain name \"NVIDIA aStock\" / aNVDA / 18 (2026-10-06)" },
  { id: "aAAPL", symbol: "aAAPL", company: "Apple", issuer: "Anchored", referenceTicker: "AAPL", chainId: 143, token: "0x17683e492d0c8910f7c0157d04af31cb7a23ad71", decimals: 18, verification: "on-chain name \"Apple aStock\" / aAAPL / 18 (2026-10-06)" },
  { id: "aMSFT", symbol: "aMSFT", company: "Microsoft", issuer: "Anchored", referenceTicker: "MSFT", chainId: 143, token: "0x73e9eb2c7a4b4e8c68232b31ea0f1246963d0375", decimals: 18, verification: "on-chain name \"Microsoft aStock\" / aMSFT / 18 (2026-10-06)" },
];

// ── quote-quality policy ────────────────────────────────────────────────────────────────────────────────────────────

export type QualityPolicy = {
  /** |execution price − reference price| / reference, in bps. */
  maxPriceDeviationBps: number;
  /** How much worse the price is at this size than at the smallest probe size, in bps. */
  maxPriceImpactBps: number;
  /** (expected out − minimum out) / expected out, in bps. */
  maxSlippageBps: number;
  /** Simulation of the exact built transaction must succeed. */
  requireSimulation: true;
};

/** Defaults for a SMALL proof-of-execution (owner may tighten; never loosen without a decision in docs/INVEST.md). */
export const DEFAULT_QUALITY_POLICY: QualityPolicy = { maxPriceDeviationBps: 300, maxPriceImpactBps: 200, maxSlippageBps: 100, requireSimulation: true };

export type QuoteEvidence = {
  /** Dollars in (6 dp) and asset out (asset decimals). */
  amountInUsd: bigint;
  expectedOut: bigint;
  minOut: bigint;
  decimals: number;
  /** Reference price of ONE share in micro-dollars, from a named source, with its time. */
  referencePriceMicroUsd: bigint | null;
  /** The same route's execution price at the smallest probe size, micro-dollars per share (for price impact). */
  probePriceMicroUsd: bigint | null;
  /** Did the exact built transaction simulate successfully? */
  simulated: boolean | null;
  /** Quote valid until (unix seconds). */
  expiresAt: bigint;
};

export type QualityFailure =
  | "NO_ROUTE" | "NO_REFERENCE_PRICE" | "PRICE_DEVIATION" | "PRICE_IMPACT" | "SLIPPAGE" | "SIMULATION_FAILED" | "NOT_SIMULATED" | "QUOTE_EXPIRED";

/** Execution price in micro-dollars per whole share (bigint math only). */
export function executionPriceMicroUsd(amountInUsd: bigint, out: bigint, decimals: number): bigint | null {
  if (out <= 0n) return null;
  return (amountInUsd * 10n ** BigInt(decimals)) / out;
}

const absBps = (a: bigint, ref: bigint) => Number(((a > ref ? a - ref : ref - a) * 10_000n) / ref);

/**
 * Every check is evaluated (the UI shows all reasons). Any failure → INVESTMENT_ROUTE_UNAVAILABLE: never executed.
 * Passing everything except deviation/impact on a route that otherwise works → LOW_LIQUIDITY (shown, not executable).
 */
export function evaluateQuote(q: QuoteEvidence | null, policy: QualityPolicy, nowSec: bigint): { status: AssetStatus; failures: QualityFailure[]; priceMicroUsd: bigint | null; deviationBps: number | null; impactBps: number | null; slippageBps: number | null } {
  if (!q || q.expectedOut <= 0n) return { status: "UNAVAILABLE", failures: ["NO_ROUTE"], priceMicroUsd: null, deviationBps: null, impactBps: null, slippageBps: null };
  const failures: QualityFailure[] = [];
  const price = executionPriceMicroUsd(q.amountInUsd, q.expectedOut, q.decimals)!;
  let deviationBps: number | null = null, impactBps: number | null = null;
  if (q.referencePriceMicroUsd === null || q.referencePriceMicroUsd <= 0n) failures.push("NO_REFERENCE_PRICE");
  else {
    deviationBps = absBps(price, q.referencePriceMicroUsd);
    if (deviationBps > policy.maxPriceDeviationBps) failures.push("PRICE_DEVIATION");
  }
  if (q.probePriceMicroUsd !== null && q.probePriceMicroUsd > 0n) {
    impactBps = price > q.probePriceMicroUsd ? Number(((price - q.probePriceMicroUsd) * 10_000n) / q.probePriceMicroUsd) : 0;
    if (impactBps > policy.maxPriceImpactBps) failures.push("PRICE_IMPACT");
  }
  const slippageBps = q.minOut >= q.expectedOut ? 0 : Number(((q.expectedOut - q.minOut) * 10_000n) / q.expectedOut);
  if (slippageBps > policy.maxSlippageBps) failures.push("SLIPPAGE");
  if (q.simulated === false) failures.push("SIMULATION_FAILED");
  if (q.simulated === null) failures.push("NOT_SIMULATED");
  if (nowSec >= q.expiresAt) failures.push("QUOTE_EXPIRED");
  const marketOnly = failures.every((f) => f === "PRICE_DEVIATION" || f === "PRICE_IMPACT");
  const status: AssetStatus = failures.length === 0 ? "AVAILABLE" : marketOnly ? "LOW_LIQUIDITY" : "UNAVAILABLE";
  return { status, failures, priceMicroUsd: price, deviationBps, impactBps, slippageBps };
}

// ── provider interface ─────────────────────────────────────────────────────────────────────────────────────────────

export type InvestQuote = QuoteEvidence & {
  asset: InvestAsset;
  /** Who built the route vs where the liquidity actually is — shown separately (Kuru Flow ≠ "Kuru stock market"). */
  routeProvider: string;
  liquiditySources: string[];
  /** The exact transaction that would execute; never sent without owner GO on mainnet. */
  tx: { to: Address; data: Hex; value: bigint } | null;
  /** The recipient the route delivers to; must be the owner (recipient binding). */
  recipient: Address;
};

export interface InvestmentProvider {
  readonly id: string;
  /** False until verified (docs/INVEST.md): a disabled provider never quotes or builds. */
  readonly enabled: boolean;
  getAssets(): readonly InvestAsset[];
  getQuote(asset: InvestAsset, amountInUsd: bigint, recipient: Address): Promise<InvestQuote | null>;
  simulateBuy(q: InvestQuote): Promise<boolean>;
  buildBuy(q: InvestQuote): Promise<InvestQuote["tx"]>;
  getPosition(owner: Address, asset: InvestAsset): Promise<bigint>;
}

/**
 * The candidate providers and why each is (not) enabled — evidence in docs/INVEST.md and evidence/kuru-astocks-*.
 * A provider becomes enabled only by changing this record together with new evidence; nothing infers it.
 */
export type ProviderRecord = { id: string; name: string; enabled: boolean; kind: "AGGREGATOR" | "AMM" | "ISSUER_API"; missing: string[]; evidence: string };
export const INVEST_PROVIDERS: readonly ProviderRecord[] = [
  {
    id: "kuru-flow", name: "Kuru Flow (route provider)", enabled: false, kind: "AGGREGATOR",
    missing: ["No Kuru order-book market for any aStock (597 registered markets checked on-chain)", "The only route found (aNVDA) runs through a ~0.5-aNVDA Uniswap v4 pool and fails the price-quality policy"],
    evidence: "evidence/kuru-astocks-2026-10-07, evidence/kuru-astocks-2026-10-08",
  },
  {
    id: "uniswap-v4", name: "Uniswap v4 (liquidity)", enabled: false, kind: "AMM",
    missing: ["MON/aNVDA pool: mid price ≈ +18% over NVDA and ~0.5 aNVDA in total: LOW_LIQUIDITY / demo-only", "No pool for most aStocks"],
    evidence: "docs/INTEGRATION_VERIFICATION.md (Kuru × Anchored)",
  },
  {
    id: "anchored-rwa-api", name: "Anchored RWA API (issuer; Monday Trade runs on it)", enabled: false, kind: "ISSUER_API",
    missing: [
      "Partner API key + secret (x-api-key / HMAC) with a WRITABLE scope for chain 143 (and 10143 for testnet)",
      "Egress IP whitelisted on the key (an empty whitelist rejects every request)",
      "Investor eligibility per Anchored: KYC/KYB; professional/qualified investors; prohibited jurisdictions include the US and Canada",
    ],
    evidence: "https://docs.anchored.finance/trading-api/getting-started/introduction ; …/authentication/headers-and-permissions ; …/getting-started/eligibility",
  },
];

/** Recipient binding: a quote whose route delivers anywhere but the owner is refused before anything else. */
export function recipientProblem(q: Pick<InvestQuote, "recipient">, owner: Address): "RECIPIENT_MISMATCH" | null {
  return q.recipient.toLowerCase() === owner.toLowerCase() ? null : "RECIPIENT_MISMATCH";
}
