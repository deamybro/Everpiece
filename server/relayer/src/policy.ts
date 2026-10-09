import { getAddress, type Address } from "viem";
import { payableTokens, type ComplianceResult, type KycState } from "@everpiece/shared";

/**
 * Policy engine (owner mandate §23): a COMPLIANCE-READY layer, not a legal determination. Everpiece decides
 * ALLOW / DENY / REVIEW with machine-readable reasons before it relays any money movement; the chain stays the
 * authority for what actually happened.
 *
 * `LocalRulesPolicy` is Everpiece's own rule set: configured chain, tokens and routes, amount limits, a per-sender
 * daily velocity limit, an operator denylist, an optional review threshold, and the provider restriction that Agora
 * swaps need an APPROVED_SWAPPER caller. It does NOT screen sanctions lists and does NOT verify identity: the UI must
 * never present it as "screened" or "KYC verified". A real provider plugs in behind the same interface.
 */

export type PolicyContext = {
  chainId: number;
  sender: Address;
  /** Known for instant payments; for protected payments only a commitment is on-chain (null). */
  recipient: Address | null;
  amount: bigint; // AUSD base units
  sourceToken: Address;
  route: "DIRECT_AUSD" | "AGORA_INSTANT_SETTLEMENT" | "ESCROW" | "DIRECT" | "CONVERTED";
  mode: "INSTANT" | "PROTECTED";
  /** AUSD already moved by this sender today through Everpiece (from the relayer's records). */
  sentToday: bigint;
  /** Provider gate: does the Everpiece settlement contract hold APPROVED_SWAPPER on the pair? */
  agoraWhitelisted: boolean | null;
  kyc: KycState;
};

export interface ComplianceProvider {
  readonly id: string;
  evaluate(ctx: PolicyContext): Promise<ComplianceResult>;
}

export type LocalRulesConfig = {
  maxPerPayment: bigint;
  maxPerSenderPerDay: bigint;
  /** 0 = no review threshold. Above it, the decision is REVIEW (not executed automatically). */
  reviewAbove: bigint;
  denylist: ReadonlySet<string>;
};

export const LOCAL_RULES_VERSION = "local-rules/2026-10-03";

export class LocalRulesPolicy implements ComplianceProvider {
  readonly id = "LocalRulesPolicy (TEST: no sanctions or identity screening)";
  private readonly cfg: LocalRulesConfig;
  constructor(cfg: LocalRulesConfig) {
    this.cfg = cfg;
  }

  async evaluate(ctx: PolicyContext): Promise<ComplianceResult> {
    const deny: string[] = [];
    const review: string[] = [];
    const tokens = payableTokens(ctx.chainId);
    if (tokens.length === 0) deny.push("UNSUPPORTED_NETWORK");
    else if (!tokens.some((t) => t.address.toLowerCase() === ctx.sourceToken.toLowerCase())) deny.push("UNSUPPORTED_TOKEN");
    if (ctx.amount <= 0n) deny.push("ZERO_AMOUNT");
    if (ctx.amount > this.cfg.maxPerPayment) deny.push("ABOVE_PAYMENT_LIMIT");
    if (ctx.sentToday + ctx.amount > this.cfg.maxPerSenderPerDay) deny.push("DAILY_LIMIT");
    if (this.cfg.denylist.has(getAddress(ctx.sender))) deny.push("SENDER_DENYLISTED");
    if (ctx.recipient && this.cfg.denylist.has(getAddress(ctx.recipient))) deny.push("RECIPIENT_DENYLISTED");
    if (ctx.route === "AGORA_INSTANT_SETTLEMENT" && ctx.agoraWhitelisted !== true) deny.push("AGORA_NOT_WHITELISTED");
    if (ctx.kyc === "REQUIRED" || ctx.kyc === "PENDING" || ctx.kyc === "REJECTED") deny.push(`KYC_${ctx.kyc}`);
    if (this.cfg.reviewAbove > 0n && ctx.amount > this.cfg.reviewAbove) review.push("ABOVE_REVIEW_THRESHOLD");
    const decision = deny.length ? "DENY" : review.length ? "REVIEW" : "ALLOW";
    return { decision, reasons: deny.length ? deny : review, ruleVersion: LOCAL_RULES_VERSION, provider: this.id };
  }
}

/** Fail closed: if the policy can't be evaluated, nothing moves. */
export async function decide(p: ComplianceProvider, ctx: PolicyContext): Promise<ComplianceResult> {
  try {
    return await p.evaluate(ctx);
  } catch {
    return { decision: "DENY", reasons: ["POLICY_UNAVAILABLE"], ruleVersion: "n/a", provider: p.id };
  }
}
