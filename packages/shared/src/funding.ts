import { getAddress, isAddress, type Address } from "viem";

/**
 * "Add Dollars from another chain": Aurora Intents moves USDC the payer holds on another chain to the payer's OWN
 * Everpiece account on Monad (EXACT_OUTPUT: exactly the USDC Agora needs), then one passkey prompt converts it to
 * exactly that many Dollars (EverpiecePay.payWithToken through the Agora AUSD/USDC pair). Facts: docs/VERIFIED.md §7.
 *
 * Money rules (owner-confirmable, docs/FUNDING.md): the payer pays Aurora's fee (shown first, no Everpiece fee);
 * a failed cross-chain step is refunded by Aurora to the payer's own address on the origin chain; USDC that arrived
 * but wasn't converted stays the payer's, in their Everpiece account.
 */

/** Aurora Intents API base (docs.intents.aurora.dev → API reference). The API key is a path segment. */
export const AURORA_API_URL = "https://intents-api.aurora.dev/api";

/** Every swap status Aurora reports (`GET /status/{apiKey}?depositAddress=`). */
export const AURORA_STATUSES = ["KNOWN_DEPOSIT_TX", "PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"] as const;
export type AuroraStatus = (typeof AURORA_STATUSES)[number];

/** What the app tells the payer. */
export type FundingPhase = "WAITING_FOR_DEPOSIT" | "DEPOSIT_TOO_SMALL" | "MOVING" | "ARRIVED" | "REFUNDED" | "FAILED";
export function fundingPhase(s: AuroraStatus): FundingPhase {
  switch (s) {
    case "PENDING_DEPOSIT":
      return "WAITING_FOR_DEPOSIT";
    case "INCOMPLETE_DEPOSIT":
      return "DEPOSIT_TOO_SMALL";
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return "MOVING";
    case "SUCCESS":
      return "ARRIVED";
    case "REFUNDED":
      return "REFUNDED";
    case "FAILED":
      return "FAILED";
  }
}
export const isFinalFunding = (p: FundingPhase) => p === "ARRIVED" || p === "REFUNDED" || p === "FAILED";

/**
 * Origin chains we offer: EVM chains, so the refund address is a plain 0x address the payer can check. Keys are
 * Aurora's `blockchain` ids; anything not listed (or not EVM) is never offered.
 */
export const FUNDING_ORIGIN_CHAINS: Readonly<Record<string, string>> = {
  base: "Base",
  eth: "Ethereum",
  arb: "Arbitrum",
  op: "Optimism",
  pol: "Polygon",
  avax: "Avalanche",
  gnosis: "Gnosis",
  bsc: "BNB Chain",
};
/** Aurora's id for Monad. */
export const AURORA_MONAD_CHAIN = "monad";
/** Test stacks label their simulated provider's chains with this prefix; the app shows "(simulated)". */
export const SIMULATED_CHAIN_PREFIX = "sim-";

export type FundingSource = { assetId: string; chain: string; chainLabel: string; symbol: string; decimals: number; token: Address; simulated: boolean };

type WireToken = { assetId?: unknown; decimals?: unknown; blockchain?: unknown; symbol?: unknown; contractAddress?: unknown };
const tokenOk = (t: WireToken) =>
  typeof t.assetId === "string" && t.assetId.length > 0 && t.assetId.length <= 200 && typeof t.blockchain === "string" &&
  typeof t.symbol === "string" && typeof t.decimals === "number" && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 30 &&
  typeof t.contractAddress === "string" && isAddress(t.contractAddress, { strict: false });

/** Aurora's token list → the `symbol` (USDC) origins we support, by chain label. */
export function fundingSources(tokens: unknown, symbol = "USDC"): FundingSource[] {
  if (!Array.isArray(tokens)) return [];
  const out: FundingSource[] = [];
  for (const t of tokens as WireToken[]) {
    if (!t || typeof t !== "object" || !tokenOk(t) || t.symbol !== symbol) continue;
    const chain = t.blockchain as string;
    const simulated = chain.startsWith(SIMULATED_CHAIN_PREFIX);
    const label = FUNDING_ORIGIN_CHAINS[simulated ? chain.slice(SIMULATED_CHAIN_PREFIX.length) : chain];
    if (!label) continue;
    out.push({
      assetId: t.assetId as string, chain, chainLabel: simulated ? `${label} (simulated)` : label, symbol, decimals: t.decimals as number,
      token: getAddress(t.contractAddress as string), simulated,
    });
  }
  return out.sort((a, b) => Object.keys(FUNDING_ORIGIN_CHAINS).indexOf(a.chain.replace(SIMULATED_CHAIN_PREFIX, "")) - Object.keys(FUNDING_ORIGIN_CHAINS).indexOf(b.chain.replace(SIMULATED_CHAIN_PREFIX, "")));
}

/** The Monad asset id for exactly `token` (never matched by symbol: a look-alike must not be the destination). */
export function destinationAssetId(tokens: unknown, token: Address): string | null {
  if (!Array.isArray(tokens)) return null;
  const hit = (tokens as WireToken[]).find(
    (t) => t && tokenOk(t) && t.blockchain === AURORA_MONAD_CHAIN && (t.contractAddress as string).toLowerCase() === token.toLowerCase(),
  );
  return hit ? (hit.assetId as string) : null;
}

export type FundingQuoteArgs = {
  origin: FundingSource;
  destinationAssetId: string;
  /** Exact amount of the destination token (base units) to deliver on Monad. */
  amountOut: bigint;
  /** The payer's own Everpiece account on Monad. */
  recipient: Address;
  /** The payer's own address on the origin chain (refunds). */
  refundTo: Address;
  /** ISO time after which an unpaid quote is refunded. */
  deadline: string;
  /** Input-side buffer in basis points (EXACT_OUTPUT: excess input is refunded after the swap). */
  slippageBps: number;
};

/** The POST /quote/{apiKey} body (fields and enums as in the Aurora / 1Click API reference). */
export function auroraQuoteRequest(a: FundingQuoteArgs) {
  return {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: a.slippageBps,
    originAsset: a.origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: a.destinationAssetId,
    amount: a.amountOut.toString(),
    refundTo: a.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: a.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: a.deadline,
    referral: "everpiece",
    quoteWaitingTimeMs: 3000,
  } as const;
}

export type FundingQuote = {
  depositAddress: Address;
  originAssetId: string;
  originChain: string;
  originDecimals: number;
  /** Send this much (includes Aurora's input buffer; anything unused is refunded to `refundTo`). */
  amountIn: bigint;
  /** Less than this is refunded by the deadline. */
  minAmountIn: bigint;
  /** Delivered to `recipient` on Monad (exact). */
  amountOut: bigint;
  recipient: Address;
  refundTo: Address;
  deadline: string;
  timeEstimateSec: number;
  amountInUsd: string | null;
  amountOutUsd: string | null;
};

export class FundingError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const big = (v: unknown, name: string): bigint => {
  if (typeof v !== "string" || !/^[0-9]{1,40}$/.test(v)) throw new FundingError("BAD_QUOTE", name);
  return BigInt(v);
};

/**
 * Accept Aurora's quote only if it is the quote we asked for: same assets, same recipient and refund address, at least
 * the exact amount out, a deposit address, and a deadline in the future. Anything else is BAD_QUOTE (never shown).
 */
export function parseAuroraQuote(resp: unknown, asked: FundingQuoteArgs, nowMs: number): FundingQuote {
  const r = resp as { quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown> } | null;
  const q = r?.quote;
  const req = r?.quoteRequest;
  if (!q || typeof q !== "object" || !req || typeof req !== "object") throw new FundingError("BAD_QUOTE", "shape");
  const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
  if (!same(req.originAsset, asked.origin.assetId) || !same(req.destinationAsset, asked.destinationAssetId)) throw new FundingError("BAD_QUOTE", "assets");
  if (!same(req.recipient, asked.recipient) || !same(req.refundTo, asked.refundTo)) throw new FundingError("BAD_QUOTE", "addresses");
  if (req.swapType !== "EXACT_OUTPUT") throw new FundingError("BAD_QUOTE", "swapType");
  const amountOut = big(q.amountOut, "amountOut");
  if (amountOut < asked.amountOut) throw new FundingError("BAD_QUOTE", "amountOut below the exact amount");
  const amountIn = big(q.amountIn, "amountIn");
  const minAmountIn = big(q.minAmountIn, "minAmountIn");
  if (amountIn === 0n || minAmountIn > amountIn) throw new FundingError("BAD_QUOTE", "amountIn");
  if (typeof q.depositAddress !== "string" || !isAddress(q.depositAddress, { strict: false })) throw new FundingError("BAD_QUOTE", "depositAddress");
  if (typeof q.depositMemo === "string" && q.depositMemo) throw new FundingError("BAD_QUOTE", "memo deposits are not supported");
  const deadline = typeof q.deadline === "string" ? q.deadline : asked.deadline;
  const dl = Date.parse(deadline);
  if (!Number.isFinite(dl) || dl <= nowMs) throw new FundingError("BAD_QUOTE", "deadline");
  const te = Number(q.timeEstimate);
  return {
    depositAddress: getAddress(q.depositAddress), originAssetId: asked.origin.assetId, originChain: asked.origin.chain, originDecimals: asked.origin.decimals,
    amountIn, minAmountIn, amountOut, recipient: getAddress(asked.recipient), refundTo: getAddress(asked.refundTo), deadline,
    timeEstimateSec: Number.isFinite(te) && te >= 0 ? te : 0,
    amountInUsd: typeof q.amountInUsd === "string" ? q.amountInUsd : null,
    amountOutUsd: typeof q.amountOutUsd === "string" ? q.amountOutUsd : null,
  };
}

/** `GET /status` → status (unknown values are FAILED-safe: never treated as arrived). */
export function parseAuroraStatus(resp: unknown): { status: AuroraStatus; deliveredTxHash: string | null; refundedAmount: string | null } {
  const r = resp as { status?: unknown; swapDetails?: Record<string, unknown> } | null;
  const s = r?.status;
  if (typeof s !== "string" || !(AURORA_STATUSES as readonly string[]).includes(s)) throw new FundingError("BAD_STATUS", String(s));
  const d = (r?.swapDetails ?? {}) as Record<string, unknown>;
  const dest = Array.isArray(d.destinationChainTxHashes) ? d.destinationChainTxHashes : [];
  const h = dest.map((x) => (x as { hash?: unknown })?.hash).find((x) => typeof x === "string") as string | undefined;
  const refunded = typeof d.refundedAmount === "string" && /^[0-9]{1,40}$/.test(d.refundedAmount) ? d.refundedAmount : null;
  return { status: s as AuroraStatus, deliveredTxHash: h ?? null, refundedAmount: refunded };
}
