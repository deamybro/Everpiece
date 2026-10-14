// Everpiece Copilot (docs/AUTOMATE.md): turns a sentence into a PROPOSED RuleSpec. It has no authority: the proposal is a
// draft the owner reads on the preview screen and signs (or discards). Everything the model says is untrusted text; this
// module accepts only a small, fixed JSON shape, converts it with exact arithmetic, and the result still goes through
// `ruleSpecProblem` and the owner's signature like any other rule. No floats reach the rule: dollars and percents are
// rounded to cents / basis points here.
import { ruleSpecProblem, type Action, type RuleSpec, type Trigger } from "./automate.ts";

export const COPILOT_MAX_INPUT_CHARS = 300;

export type CopilotProposal = {
  name: string;
  trigger:
    | { type: "payment_received"; minDollars: number }
    | { type: "balance_above"; keepDollars: number }
    | { type: "earnings_reach"; thresholdDollars: number };
  split: { to: "keep" | "earn" | "stocks"; percent: number }[];
  limits: { perRunDollars?: number; perDayDollars?: number; perMonthDollars?: number; days?: number };
};
export type CopilotResult = { ok: true; proposal: CopilotProposal } | { ok: false; reason: string };

/** The system prompt for any model. It asks for the fixed shape and tells the model to refuse rather than guess. */
export const COPILOT_SYSTEM_PROMPT = `You turn a short request about automating money into ONE JSON object. Reply with JSON only.
Allowed shape:
{"understood":true,"name":"short title","trigger":{"type":"payment_received","min_dollars":0},"split":[{"to":"keep","percent":50},{"to":"earn","percent":50}],"limits":{"per_run_dollars":50,"per_day_dollars":200,"per_month_dollars":1000,"days":30}}
trigger.type is one of: payment_received (min_dollars), balance_above (keep_dollars), earnings_reach (threshold_dollars).
split[].to is one of: keep (stay in the balance), earn (deposit into Earn), stocks. Percents must add up to 100 and at least one must not be keep.
If the request is not about splitting incoming money, keeping a balance, or moving earnings, or you are unsure, reply {"understood":false,"reason":"one short sentence"}.
Never invent amounts the user did not give; leave limits out if they were not mentioned. Never output anything except the JSON.`;

const num = (v: unknown, max: number): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) throw new Error("range");
  return v;
};
const cents = (n: number) => BigInt(Math.round(n * 100)) * 10_000n; // dollars → 6-dp base units, via whole cents

/** Parse the model's text into a CopilotProposal or a plain-language refusal. Never throws. */
export function parseCopilotProposal(text: string): CopilotResult {
  try {
    const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end < start) return { ok: false, reason: "I couldn't read that." };
    const o = JSON.parse(t.slice(start, end + 1)) as Record<string, any>;
    if (o.understood === false) return { ok: false, reason: typeof o.reason === "string" ? o.reason.slice(0, 160) : "I couldn't turn that into a rule." };
    if (o.understood !== true || !o.trigger || typeof o.trigger !== "object" || !Array.isArray(o.split)) return { ok: false, reason: "I couldn't turn that into a rule." };
    const tr = o.trigger;
    let trigger: CopilotProposal["trigger"];
    if (tr.type === "payment_received") trigger = { type: "payment_received", minDollars: num(tr.min_dollars ?? 0, 1_000_000) ?? 0 };
    else if (tr.type === "balance_above") {
      const keep = num(tr.keep_dollars, 1_000_000);
      if (keep === undefined) return { ok: false, reason: "How much should stay available?" };
      trigger = { type: "balance_above", keepDollars: keep };
    } else if (tr.type === "earnings_reach") {
      const th = num(tr.threshold_dollars, 1_000_000);
      if (!th) return { ok: false, reason: "At what amount of earnings should it run?" };
      trigger = { type: "earnings_reach", thresholdDollars: th };
    } else return { ok: false, reason: "That kind of rule isn't supported yet." };
    if (o.split.length === 0 || o.split.length > 4) return { ok: false, reason: "I couldn't work out how to split it." };
    const split = o.split.map((s: any) => {
      if (!s || !["keep", "earn", "stocks"].includes(s.to)) throw new Error("to");
      const p = num(s.percent, 100);
      if (!p || p <= 0) throw new Error("percent");
      return { to: s.to as "keep" | "earn" | "stocks", percent: p };
    });
    const l = (o.limits && typeof o.limits === "object" ? o.limits : {}) as Record<string, unknown>;
    const proposal: CopilotProposal = {
      name: String(o.name ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 60) || "My rule",
      trigger,
      split,
      limits: { perRunDollars: num(l.per_run_dollars, 1_000_000), perDayDollars: num(l.per_day_dollars, 1_000_000), perMonthDollars: num(l.per_month_dollars, 1_000_000), days: num(l.days, 366) },
    };
    return { ok: true, proposal };
  } catch {
    return { ok: false, reason: "I couldn't turn that into a safe rule." };
  }
}

export type CopilotContext = {
  nowSec: bigint;
  /** The Earn opportunity a rule may deposit into; absent = Earn isn't available here. */
  earnOpportunityId?: string;
  /** Stocks are parked: false refuses them with a plain sentence. */
  stocksAvailable: boolean;
};
export const COPILOT_DEFAULTS = { perRunDollars: 50, perDayDollars: 200, perMonthDollars: 1000, days: 30 } as const;

/** Convert a proposal into a RuleSpec draft (always CONFIRM_EACH: the owner confirms every run), or refuse in plain words. */
export function proposalToRuleSpec(p: CopilotProposal, ctx: CopilotContext): { ok: true; spec: RuleSpec; assumed: string[] } | { ok: false; reason: string } {
  const assumed: string[] = [];
  let total = 0;
  const actions: Action[] = [];
  for (const s of p.split) {
    const bps = Math.round(s.percent * 100);
    total += bps;
    if (s.to === "keep") actions.push({ kind: "KEEP_BALANCE", bps });
    else if (s.to === "earn") {
      if (!ctx.earnOpportunityId) return { ok: false, reason: "Earn isn't available here yet." };
      actions.push({ kind: "DEPOSIT_YIELD", bps, opportunityId: ctx.earnOpportunityId });
    } else {
      if (!ctx.stocksAvailable) return { ok: false, reason: "Stocks aren't available yet. Try splitting between keeping and Earn." };
      actions.push({ kind: "BUY_STOCK", bps, assetId: "aNVDA" });
    }
  }
  if (total !== 10_000) return { ok: false, reason: "The percentages must add up to 100." };
  const trigger: Trigger =
    p.trigger.type === "payment_received" ? { kind: "PAYMENT_RECEIVED", minAmount: cents(p.trigger.minDollars) }
    : p.trigger.type === "balance_above" ? { kind: "BALANCE_ABOVE", keep: cents(p.trigger.keepDollars) }
    : { kind: "YIELD_THRESHOLD", positionId: ctx.earnOpportunityId ?? "earn", threshold: cents(p.trigger.thresholdDollars) };
  if (p.trigger.type === "earnings_reach" && !ctx.earnOpportunityId) return { ok: false, reason: "Earn isn't available here yet." };

  const pick = (v: number | undefined, d: number, label: string) => {
    if (v === undefined || v <= 0) {
      assumed.push(label);
      return d;
    }
    return v;
  };
  const run = pick(p.limits.perRunDollars, COPILOT_DEFAULTS.perRunDollars, `at most $${COPILOT_DEFAULTS.perRunDollars} per run`);
  const day = pick(p.limits.perDayDollars, Math.max(COPILOT_DEFAULTS.perDayDollars, run), `at most $${Math.max(COPILOT_DEFAULTS.perDayDollars, run)} per day`);
  const month = pick(p.limits.perMonthDollars, Math.max(COPILOT_DEFAULTS.perMonthDollars, day), `at most $${Math.max(COPILOT_DEFAULTS.perMonthDollars, day)} per month`);
  const days = Math.floor(pick(p.limits.days, COPILOT_DEFAULTS.days, `ends after ${COPILOT_DEFAULTS.days} days`));
  const spec: RuleSpec = {
    name: p.name,
    trigger,
    actions,
    limits: { maxPerExecution: cents(run), maxPerDay: cents(day), maxPerMonth: cents(month), expiresAt: ctx.nowSec + BigInt(days) * 86_400n },
    authorization: "CONFIRM_EACH",
  };
  const problem = ruleSpecProblem(spec, ctx.nowSec);
  if (problem) return { ok: false, reason: problem === "INVALID_LIMITS" ? "The per-run, per-day and per-month limits don't fit together." : "I couldn't make a safe rule from that." };
  return { ok: true, spec, assumed };
}
