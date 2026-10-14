// Everpiece Automate (docs/AUTOMATE.md): a deterministic rules engine. A rule is data the owner signs; the engine turns
// (rule, trigger event, context) into a plan of legs. Nothing here moves money: execution happens elsewhere, one leg at a
// time, under the idempotency key computed here. Copilot may only PROPOSE a RuleSpec; it never reaches this engine
// unsigned. All amounts are bigint base units of AUSD (6 dp); no floats anywhere.
import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { directoryDomain } from "./directory.ts";

export const AUTOMATE_VERSION = 1;
export const BPS = 10_000n;
/** A rule lives at most a year; the owner renews it deliberately. */
export const MAX_RULE_LIFETIME_SEC = 366n * 86_400n;

// ── triggers / actions ──────────────────────────────────────────────────────────────────────────────────────────────

export type TriggerKind = "PAYMENT_RECEIVED" | "BALANCE_ABOVE" | "SCHEDULE" | "YIELD_THRESHOLD";
/** Designed, not executable yet: a rule using one is refused with TRIGGER_NOT_SUPPORTED. */
export const RESERVED_TRIGGERS = ["STREAM_ACCRUAL", "PROTECTED_PAYMENT_CLAIMED"] as const;

export type Trigger =
  /** Money arrived in the owner's account (an instant payment, a claimed protected payment, a top-up). */
  | { kind: "PAYMENT_RECEIVED"; minAmount: bigint }
  /** Spendable balance (balance − reserved for pending payouts) is above `keep`: the excess is the base. */
  | { kind: "BALANCE_ABOVE"; keep: bigint }
  /** Every `everySec` from `startAt`. Each period runs at most once. */
  | { kind: "SCHEDULE"; everySec: bigint; startAt: bigint; amount: bigint }
  /** Harvestable yield on one Earn position reached `threshold`: the yield (never principal) is the base. */
  | { kind: "YIELD_THRESHOLD"; positionId: string; threshold: bigint };

export type ActionKind = "KEEP_BALANCE" | "DEPOSIT_YIELD" | "BUY_STOCK";
export const RESERVED_ACTIONS = ["SEND", "PAYOUT", "REINVEST_YIELD"] as const;

export type Action =
  | { kind: "KEEP_BALANCE"; bps: number }
  | { kind: "DEPOSIT_YIELD"; bps: number; opportunityId: string }
  | { kind: "BUY_STOCK"; bps: number; assetId: string };

export type Limits = {
  /** Most the rule may move (everything except KEEP_BALANCE) in one execution. */
  maxPerExecution: bigint;
  maxPerDay: bigint;
  maxPerMonth: bigint;
  /** Unix seconds. Required: no rule runs forever. */
  expiresAt: bigint;
};

/** How executions are authorized. Mera 0.2 has no scoped/session keys (docs/AUTOMATE.md §Authorization). */
export type AuthorizationMode =
  /** Every execution is prepared automatically and confirmed by the owner with one fingerprint. Works today. */
  | "CONFIRM_EACH"
  /** An on-chain module enforces this rule's caps, expiry and targets; the relayer executes. Not deployed. */
  | "BOUNDED_MODULE";

export type RuleSpec = {
  name: string;
  trigger: Trigger;
  actions: Action[];
  limits: Limits;
  authorization: AuthorizationMode;
};

export type AutomationRule = RuleSpec & {
  version: number;
  id: Hex;
  owner: Address;
  enabled: boolean;
  createdAt: bigint;
  updatedAt: bigint;
};

// ── validation ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type RuleProblem =
  | "UNKNOWN_VERSION" | "INVALID_RULE" | "INVALID_NAME" | "TRIGGER_NOT_SUPPORTED" | "ACTION_NOT_SUPPORTED" | "NO_ACTIONS"
  | "TOO_MANY_ACTIONS" | "INVALID_ALLOCATION" | "ALLOCATION_NOT_100" | "DUPLICATE_ACTION" | "INVALID_LIMITS" | "RULE_EXPIRED"
  | "EXPIRY_TOO_FAR" | "INVALID_TRIGGER" | "NOTHING_MOVES" | "AUTHORIZATION_NOT_AVAILABLE";

const TRIGGERS: readonly string[] = ["PAYMENT_RECEIVED", "BALANCE_ABOVE", "SCHEDULE", "YIELD_THRESHOLD"];
const ACTIONS: readonly string[] = ["KEEP_BALANCE", "DEPOSIT_YIELD", "BUY_STOCK"];
const ID = /^[a-z0-9][a-z0-9:._-]{0,63}$/i;

/** Structural checks, before any signature or provider check. `null` = acceptable. */
export function ruleSpecProblem(s: RuleSpec, nowSec: bigint): RuleProblem | null {
  if (!s || typeof s !== "object" || !s.trigger || !Array.isArray(s.actions) || !s.limits) return "INVALID_RULE";
  if (typeof s.name !== "string" || s.name.trim().length === 0 || s.name.length > 60) return "INVALID_NAME";
  if (!TRIGGERS.includes(s.trigger.kind)) return "TRIGGER_NOT_SUPPORTED";
  const t = s.trigger;
  switch (t.kind) {
    case "PAYMENT_RECEIVED": if (t.minAmount < 0n) return "INVALID_TRIGGER"; break;
    case "BALANCE_ABOVE": if (t.keep < 0n) return "INVALID_TRIGGER"; break;
    case "SCHEDULE": if (t.everySec < 3_600n || t.startAt <= 0n || t.amount <= 0n) return "INVALID_TRIGGER"; break;
    case "YIELD_THRESHOLD": if (!ID.test(t.positionId) || t.threshold <= 0n) return "INVALID_TRIGGER"; break;
  }
  if (s.actions.length === 0) return "NO_ACTIONS";
  if (s.actions.length > 6) return "TOO_MANY_ACTIONS";
  let sum = 0;
  const seen = new Set<string>();
  for (const a of s.actions) {
    if (!ACTIONS.includes(a.kind)) return "ACTION_NOT_SUPPORTED";
    if (!Number.isInteger(a.bps) || a.bps <= 0 || a.bps > 10_000) return "INVALID_ALLOCATION";
    const key = a.kind === "DEPOSIT_YIELD" ? `Y:${a.opportunityId}` : a.kind === "BUY_STOCK" ? `S:${a.assetId}` : "K";
    if (a.kind === "DEPOSIT_YIELD" && !ID.test(a.opportunityId)) return "INVALID_RULE";
    if (a.kind === "BUY_STOCK" && !ID.test(a.assetId)) return "INVALID_RULE";
    if (seen.has(key)) return "DUPLICATE_ACTION";
    seen.add(key);
    sum += a.bps;
  }
  if (sum !== 10_000) return "ALLOCATION_NOT_100";
  if (!s.actions.some((a) => a.kind !== "KEEP_BALANCE")) return "NOTHING_MOVES";
  const l = s.limits;
  if (l.maxPerExecution <= 0n || l.maxPerDay <= 0n || l.maxPerMonth <= 0n) return "INVALID_LIMITS";
  if (l.maxPerExecution > l.maxPerDay || l.maxPerDay > l.maxPerMonth) return "INVALID_LIMITS";
  if (l.expiresAt <= nowSec) return "RULE_EXPIRED";
  if (l.expiresAt - nowSec > MAX_RULE_LIFETIME_SEC) return "EXPIRY_TOO_FAR";
  if (s.authorization !== "CONFIRM_EACH" && s.authorization !== "BOUNDED_MODULE") return "INVALID_RULE";
  return null;
}

// ── canonical form + owner signature ───────────────────────────────────────────────────────────────────────────────

/** Deterministic JSON: sorted keys, bigint as decimal strings. The signed hash covers exactly this. */
export function canonicalSpec(s: RuleSpec): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm({ name: s.name, trigger: s.trigger, actions: s.actions, limits: s.limits, authorization: s.authorization }));
}
export const specHashOf = (s: RuleSpec): Hex => keccak256(toHex(canonicalSpec(s)));

/** The limits are signed as their own fields (a wallet shows them), and the whole spec through `specHash`. */
export const automationTypes = {
  AutomationRule: [
    { name: "version", type: "uint8" },
    { name: "ruleId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "specHash", type: "bytes32" },
    { name: "maxPerExecution", type: "uint256" },
    { name: "maxPerDay", type: "uint256" },
    { name: "maxPerMonth", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "enabled", type: "bool" },
    { name: "updatedAt", type: "uint256" },
  ],
} as const;

export const automationRuleTyped = (domainAddress: Address, r: AutomationRule, chainId: number) => ({
  domain: directoryDomain(domainAddress, chainId),
  types: automationTypes,
  primaryType: "AutomationRule" as const,
  message: {
    version: r.version, ruleId: r.id, owner: r.owner, specHash: specHashOf(r),
    maxPerExecution: r.limits.maxPerExecution, maxPerDay: r.limits.maxPerDay, maxPerMonth: r.limits.maxPerMonth,
    expiresAt: r.limits.expiresAt, enabled: r.enabled, updatedAt: r.updatedAt,
  },
});
export const automationRuleHash = (domainAddress: Address, r: AutomationRule, chainId: number): Hex =>
  hashTypedData(automationRuleTyped(domainAddress, r, chainId));

/**
 * The owner reporting what happened to one leg they executed (CONFIRM_EACH). A DONE report is still proven on-chain by
 * the server (receipt status + expected event at finality) before it counts; the signature only stops others from
 * reporting legs of someone else's execution.
 */
export const LegOutcome = { DONE: 1, FAILED: 2 } as const;
export const legReportTypes = {
  AutomationLegReport: [
    { name: "executionId", type: "bytes32" },
    { name: "legIndex", type: "uint8" },
    { name: "outcome", type: "uint8" },
    { name: "txHash", type: "bytes32" },
  ],
} as const;
export type LegReport = { executionId: Hex; legIndex: number; outcome: (typeof LegOutcome)[keyof typeof LegOutcome]; txHash: Hex };
export const legReportTyped = (domainAddress: Address, r: LegReport, chainId: number) =>
  ({ domain: directoryDomain(domainAddress, chainId), types: legReportTypes, primaryType: "AutomationLegReport" as const, message: r });
export const executionIdOf = (ruleId: Hex, eventId: string): Hex => keccak256(toHex(`${ruleId.toLowerCase()}|${eventId}`));

/** JSON transport (bigint → string) and back, with type checks on the way in. */
export function ruleToJson(r: AutomationRule): Record<string, unknown> {
  return JSON.parse(canonicalRuleJson(r));
}
function canonicalRuleJson(r: AutomationRule): string {
  return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
const big = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^\d{1,40}$/.test(v)) throw new Error("INVALID_RULE");
  return BigInt(v);
};
export function ruleFromJson(j: unknown): AutomationRule {
  const o = j as Record<string, any>;
  if (!o || typeof o !== "object" || !o.trigger || !o.limits || !Array.isArray(o.actions)) throw new Error("INVALID_RULE");
  const t = o.trigger;
  const trigger: Trigger =
    t.kind === "PAYMENT_RECEIVED" ? { kind: t.kind, minAmount: big(t.minAmount) }
    : t.kind === "BALANCE_ABOVE" ? { kind: t.kind, keep: big(t.keep) }
    : t.kind === "SCHEDULE" ? { kind: t.kind, everySec: big(t.everySec), startAt: big(t.startAt), amount: big(t.amount) }
    : t.kind === "YIELD_THRESHOLD" ? { kind: t.kind, positionId: String(t.positionId), threshold: big(t.threshold) }
    : (() => { throw new Error("TRIGGER_NOT_SUPPORTED"); })();
  const actions: Action[] = o.actions.map((a: Record<string, unknown>) =>
    a.kind === "KEEP_BALANCE" ? { kind: a.kind, bps: Number(a.bps) }
    : a.kind === "DEPOSIT_YIELD" ? { kind: a.kind, bps: Number(a.bps), opportunityId: String(a.opportunityId) }
    : a.kind === "BUY_STOCK" ? { kind: a.kind, bps: Number(a.bps), assetId: String(a.assetId) }
    : (() => { throw new Error("ACTION_NOT_SUPPORTED"); })());
  if (!/^0x[0-9a-f]{64}$/i.test(o.id) || !/^0x[0-9a-f]{40}$/i.test(o.owner)) throw new Error("INVALID_RULE");
  return {
    version: Number(o.version), id: o.id, owner: o.owner, enabled: o.enabled === true, name: String(o.name), trigger, actions,
    limits: { maxPerExecution: big(o.limits.maxPerExecution), maxPerDay: big(o.limits.maxPerDay), maxPerMonth: big(o.limits.maxPerMonth), expiresAt: big(o.limits.expiresAt) },
    authorization: o.authorization, createdAt: big(o.createdAt), updatedAt: big(o.updatedAt),
  };
}

// ── trigger events ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A fact observed from a trusted source (indexer at finality, an on-chain read), never from the client. `id` must be
 * globally unique and stable (tx hash + log index, or a period number): it is half of every idempotency key.
 */
export type TriggerEvent =
  | { kind: "PAYMENT_RECEIVED"; id: string; recipient: Address; amount: bigint; at: bigint; origin: "EXTERNAL" | "AUTOMATION" }
  | { kind: "BALANCE_CHECK"; id: string; owner: Address; at: bigint }
  | { kind: "SCHEDULE_TICK"; id: string; owner: Address; at: bigint }
  | { kind: "YIELD_CHECK"; id: string; owner: Address; positionId: string; at: bigint };

/** What the engine needs to know about the world at planning time. All values from trusted reads. */
export type PlanContext = {
  nowSec: bigint;
  /** AUSD balance of the owner's account. Protected payments sit in escrow and are never part of it. */
  balance: bigint;
  /** Committed elsewhere (pending bank payouts, executions in flight): never spendable by a rule. */
  reserved: bigint;
  /** Harvestable yield per Earn position id (from the provider's accounting, docs/EARN.md). */
  harvestable: Record<string, bigint>;
  /** Already moved by this rule in the current UTC day / calendar month (from the execution log). */
  usedToday: bigint;
  usedThisMonth: bigint;
  /** Availability of each provider target right now. Anything not `AVAILABLE` is not executed. */
  availability: (a: Exclude<Action, { kind: "KEEP_BALANCE" }>) => { status: TargetStatus; reason?: string };
  /** Period number of the last SCHEDULE execution of this rule, if any. */
  lastSchedulePeriod?: bigint;
};

export type TargetStatus = "AVAILABLE" | "LOW_LIQUIDITY" | "UNAVAILABLE" | "COMING_SOON" | "RESTRICTED";

// ── plan ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LegStatus =
  /** Ready to quote/execute. */
  | "PENDING"
  /** KEEP_BALANCE: nothing to do, the money simply stays. */
  | "KEPT"
  /** The provider is not executable now: this leg's money stays in the balance (it is never redistributed). */
  | "UNAVAILABLE"
  /** Cut by a limit: the cut part stays in the balance. */
  | "LIMITED"
  | "EXECUTING" | "DONE" | "FAILED";

export type PlanLeg = {
  index: number;
  action: Action;
  /** Allocation before limits. */
  allocated: bigint;
  /** What will actually move (0 when kept/unavailable). */
  amount: bigint;
  /** Stays in the balance because of a limit or an unavailable provider. */
  leftInBalance: bigint;
  status: LegStatus;
  reason?: string;
  idempotencyKey: string;
};

export type PlanResult =
  | { ok: false; reason: NoRunReason }
  | { ok: true; ruleId: Hex; eventId: string; base: bigint; legs: PlanLeg[]; moving: bigint; keptInBalance: bigint; source: "BALANCE" | "YIELD" };

export type NoRunReason =
  | "RULE_DISABLED" | "RULE_EXPIRED" | "TRIGGER_MISMATCH" | "NOT_OWNER" | "BELOW_MINIMUM" | "NOTHING_ABOVE_KEEP"
  | "BELOW_THRESHOLD" | "SELF_TRIGGERED" | "NOT_DUE" | "ALREADY_RAN_THIS_PERIOD" | "LIMIT_REACHED" | "INSUFFICIENT_BALANCE";

export const idempotencyKey = (ruleId: Hex, eventId: string, actionIndex: number) => `${ruleId.toLowerCase()}:${eventId}:${actionIndex}`;
export const dayOf = (sec: bigint) => sec / 86_400n;
export function monthOf(sec: bigint): string {
  const d = new Date(Number(sec) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The engine. Pure and deterministic: same inputs → same plan. Rules of allocation:
 * 1. base = the trigger's amount (payment received / excess over `keep` / scheduled amount / harvestable yield);
 * 2. each action gets floor(base × bps / 10000); the rounding remainder goes to KEEP_BALANCE if present, else stays in
 *    the balance unallocated (never to a moving action);
 * 3. moving legs whose target isn't AVAILABLE move nothing — their share stays in the balance, never redistributed;
 * 4. the movable total is capped by min(maxPerExecution, maxPerDay − usedToday, maxPerMonth − usedThisMonth), and by
 *    the spendable balance (or by harvestable yield for YIELD_THRESHOLD: principal is never touched); the cap scales
 *    the moving legs down pro-rata (floored); what's cut stays in the balance.
 */
export function plan(rule: AutomationRule, ev: TriggerEvent, ctx: PlanContext): PlanResult {
  if (!rule.enabled) return { ok: false, reason: "RULE_DISABLED" };
  if (ctx.nowSec >= rule.limits.expiresAt) return { ok: false, reason: "RULE_EXPIRED" };
  const owner = rule.owner.toLowerCase();
  const spendable = ctx.balance > ctx.reserved ? ctx.balance - ctx.reserved : 0n;
  let base: bigint;
  let source: "BALANCE" | "YIELD" = "BALANCE";
  let ceiling: bigint; // what the money source can give at most

  const t = rule.trigger;
  switch (t.kind) {
    case "PAYMENT_RECEIVED":
      if (ev.kind !== "PAYMENT_RECEIVED") return { ok: false, reason: "TRIGGER_MISMATCH" };
      if (ev.recipient.toLowerCase() !== owner) return { ok: false, reason: "NOT_OWNER" };
      if (ev.origin === "AUTOMATION") return { ok: false, reason: "SELF_TRIGGERED" }; // e.g. an Earn withdrawal
      if (ev.amount < t.minAmount || ev.amount === 0n) return { ok: false, reason: "BELOW_MINIMUM" };
      base = ev.amount;
      ceiling = spendable;
      break;
    case "BALANCE_ABOVE":
      if (ev.kind !== "BALANCE_CHECK") return { ok: false, reason: "TRIGGER_MISMATCH" };
      if (ev.owner.toLowerCase() !== owner) return { ok: false, reason: "NOT_OWNER" };
      if (spendable <= t.keep) return { ok: false, reason: "NOTHING_ABOVE_KEEP" };
      base = spendable - t.keep;
      ceiling = base; // never dips into what the owner asked to keep
      break;
    case "SCHEDULE": {
      if (ev.kind !== "SCHEDULE_TICK") return { ok: false, reason: "TRIGGER_MISMATCH" };
      if (ev.owner.toLowerCase() !== owner) return { ok: false, reason: "NOT_OWNER" };
      if (ctx.nowSec < t.startAt) return { ok: false, reason: "NOT_DUE" };
      const period = (ctx.nowSec - t.startAt) / t.everySec;
      if (ctx.lastSchedulePeriod !== undefined && ctx.lastSchedulePeriod >= period) return { ok: false, reason: "ALREADY_RAN_THIS_PERIOD" };
      if (ev.id !== `sched:${period}`) return { ok: false, reason: "TRIGGER_MISMATCH" };
      base = t.amount;
      ceiling = spendable;
      break;
    }
    case "YIELD_THRESHOLD": {
      if (ev.kind !== "YIELD_CHECK") return { ok: false, reason: "TRIGGER_MISMATCH" };
      if (ev.owner.toLowerCase() !== owner || ev.positionId !== t.positionId) return { ok: false, reason: "NOT_OWNER" };
      const y = ctx.harvestable[t.positionId] ?? 0n;
      if (y < t.threshold) return { ok: false, reason: "BELOW_THRESHOLD" };
      base = y;
      ceiling = y; // principal protection: never more than the harvestable yield
      source = "YIELD";
      break;
    }
  }

  // 1–2: allocation
  const legs: PlanLeg[] = rule.actions.map((a, index) => {
    const allocated = (base * BigInt(a.bps)) / BPS;
    return { index, action: a, allocated, amount: 0n, leftInBalance: 0n, status: "PENDING" as LegStatus, idempotencyKey: idempotencyKey(rule.id, ev.id, index) };
  });
  const remainder = base - legs.reduce((s, l) => s + l.allocated, 0n);
  const keep = legs.find((l) => l.action.kind === "KEEP_BALANCE");
  if (keep) keep.allocated += remainder;

  // 3: availability
  for (const l of legs) {
    if (l.action.kind === "KEEP_BALANCE") { l.status = "KEPT"; l.leftInBalance = l.allocated; continue; }
    const a = ctx.availability(l.action);
    if (a.status !== "AVAILABLE") {
      l.status = "UNAVAILABLE";
      l.leftInBalance = l.allocated;
      l.reason = a.reason ?? a.status;
    } else {
      l.amount = l.allocated;
    }
  }

  // 4: limits and money-source ceiling
  const wanted = legs.reduce((s, l) => s + l.amount, 0n);
  const dayLeft = rule.limits.maxPerDay > ctx.usedToday ? rule.limits.maxPerDay - ctx.usedToday : 0n;
  const monthLeft = rule.limits.maxPerMonth > ctx.usedThisMonth ? rule.limits.maxPerMonth - ctx.usedThisMonth : 0n;
  const limitCap = min(rule.limits.maxPerExecution, dayLeft, monthLeft);
  const cap = min(limitCap, ceiling);
  if (wanted > 0n && cap === 0n) return { ok: false, reason: limitCap === 0n ? "LIMIT_REACHED" : "INSUFFICIENT_BALANCE" };
  if (wanted > cap) {
    for (const l of legs) {
      if (l.amount === 0n) continue;
      const scaled = (l.amount * cap) / wanted;
      l.leftInBalance += l.amount - scaled;
      l.amount = scaled;
      l.status = "LIMITED";
      l.reason = limitCap <= ceiling ? "LIMIT" : source === "YIELD" ? "PRINCIPAL_PROTECTED" : "INSUFFICIENT_BALANCE";
    }
  }
  const moving = legs.reduce((s, l) => s + l.amount, 0n);
  const keptInBalance = base - moving;
  return { ok: true, ruleId: rule.id, eventId: ev.id, base, legs, moving, keptInBalance, source };
}

const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

// ── execution state machine ────────────────────────────────────────────────────────────────────────────────────────

export type RuleState = "CREATED" | "AUTHORIZED" | "WAITING_TRIGGER" | "PAUSED" | "EXPIRED";
export type ExecutionState =
  | "TRIGGERED" | "QUOTING" | "READY" | "EXECUTING" | "PARTIALLY_COMPLETED" | "COMPLETED" | "FAILED";

const NEXT_EXEC: Record<ExecutionState, readonly ExecutionState[]> = {
  TRIGGERED: ["QUOTING", "READY", "FAILED", "COMPLETED", "PARTIALLY_COMPLETED"],
  QUOTING: ["READY", "FAILED", "PARTIALLY_COMPLETED"],
  READY: ["EXECUTING", "FAILED", "QUOTING"],
  EXECUTING: ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"],
  PARTIALLY_COMPLETED: [],
  COMPLETED: [],
  FAILED: [],
};
export const canMoveExecution = (from: ExecutionState, to: ExecutionState) => NEXT_EXEC[from].includes(to);

/** A leg the executor still has to run: something to move and not finished. */
export const legRunnable = (l: Pick<PlanLeg, "status" | "amount">) => l.amount > 0n && (l.status === "PENDING" || l.status === "LIMITED");

/**
 * The overall outcome from the legs (accuracy over appearance): COMPLETED only if every moving leg is DONE and no part
 * of a moving leg stayed behind — for any reason, a limit included. Some money moved but not all → PARTIALLY_COMPLETED;
 * nothing moved → FAILED. KEEP_BALANCE is the owner's own choice and never a shortfall.
 */
export function outcomeOf(legs: readonly Pick<PlanLeg, "action" | "status" | "amount" | "leftInBalance">[]): ExecutionState {
  const moving = legs.filter((l) => l.action.kind !== "KEEP_BALANCE");
  if (moving.some((l) => legRunnable(l) || l.status === "EXECUTING")) return "EXECUTING";
  const anyMoved = moving.some((l) => l.status === "DONE" && l.amount > 0n);
  const shortfall = moving.some((l) => l.status === "FAILED" || l.leftInBalance > 0n || (l.status !== "DONE" && l.amount > 0n));
  if (!shortfall) return "COMPLETED";
  return anyMoved ? "PARTIALLY_COMPLETED" : "FAILED";
}

// ── human-readable description (the preview the owner approves) ─────────────────────────────────────────────────────

export function formatUnits6(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "−" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}
const pct = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2)}%`;

export type Names = { opportunity: (id: string) => string; asset: (id: string) => string; position: (id: string) => string };

export function describeRule(s: RuleSpec, names: Names): { when: string; then: string[]; limits: string[] } {
  const t = s.trigger;
  const when =
    t.kind === "PAYMENT_RECEIVED" ? `When money arrives${t.minAmount > 0n ? ` (${formatUnits6(t.minAmount)} or more)` : ""}`
    : t.kind === "BALANCE_ABOVE" ? `Whenever your balance is above ${formatUnits6(t.keep)} (the extra)`
    : t.kind === "SCHEDULE" ? `Every ${humanPeriod(t.everySec)}, ${formatUnits6(t.amount)}`
    : `When earnings on ${names.position(t.positionId)} reach ${formatUnits6(t.threshold)} (earnings only; your deposit is never touched)`;
  const then = s.actions.map((a) =>
    a.kind === "KEEP_BALANCE" ? `${pct(a.bps)} stays in your balance`
    : a.kind === "DEPOSIT_YIELD" ? `${pct(a.bps)} goes into Earn: ${names.opportunity(a.opportunityId)}`
    : `${pct(a.bps)} buys ${names.asset(a.assetId)}`);
  const l = s.limits;
  return {
    when,
    then,
    limits: [
      `At most ${formatUnits6(l.maxPerExecution)} each time, ${formatUnits6(l.maxPerDay)} a day, ${formatUnits6(l.maxPerMonth)} a month`,
      `Ends ${new Date(Number(l.expiresAt) * 1000).toISOString().slice(0, 10)}`,
      s.authorization === "CONFIRM_EACH" ? "You confirm each run with your fingerprint" : "Runs within these limits without asking",
    ],
  };
}
function humanPeriod(sec: bigint): string {
  if (sec % 2_592_000n === 0n && sec >= 2_592_000n) return sec === 2_592_000n ? "30 days" : `${sec / 86_400n} days`;
  if (sec % 604_800n === 0n) return sec === 604_800n ? "week" : `${sec / 604_800n} weeks`;
  if (sec % 86_400n === 0n) return sec === 86_400n ? "day" : `${sec / 86_400n} days`;
  return `${sec / 3_600n} hours`;
}
