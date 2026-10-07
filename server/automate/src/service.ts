import { timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  automationRuleTyped, dayOf, executionIdOf, legReportTyped, legRunnable, LegOutcome, monthOf, outcomeOf, plan, ruleFromJson,
  ruleSpecProblem, ruleToJson, AUTOMATE_VERSION, type Action, type AutomationRule, type ExecutionState, type LegReport, type LegStatus,
  type PlanLeg, type TargetStatus, type TriggerEvent,
} from "@everpiece/shared";
import type { AutomateConfig } from "./config.ts";
import { AutomateStore, type ExecutionRow, type LegRow } from "./store.ts";
import { log } from "./log.ts";

export type Result = { httpStatus: number; body: unknown };
const ok = (body: unknown): Result => ({ httpStatus: 200, body });
const bad = (error: string, httpStatus = 400): Result => ({ httpStatus, body: { error } });

/** Trusted reads of the world (chain at finality, Earn provider accounting, the payout server). */
export interface WorldReader {
  /** AUSD balance of the account. */
  balance(owner: Address): Promise<bigint>;
  /** Committed to pending bank payouts etc.: never spendable by a rule. */
  reserved(owner: Address): Promise<bigint>;
  /** Harvestable yield of one Earn position (never principal; docs/EARN.md). */
  harvestable(owner: Address, positionId: string): Promise<bigint>;
}
/** Current executability of a provider target (docs/INVEST.md, docs/EARN.md). Unknown → UNAVAILABLE. */
export interface TargetRegistry {
  availability(a: Exclude<Action, { kind: "KEEP_BALANCE" }>): { status: TargetStatus; reason?: string };
}
/** Proves a reported transaction did exactly this leg (receipt success, expected event, owner as beneficiary, final). */
export interface LegVerifier {
  verify(owner: Address, action: Action, amount: bigint, txHash: Hex): Promise<"OK" | "NOT_FINAL" | "MISMATCH">;
}

class Limiter {
  private hits = new Map<string, number[]>();
  private perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  hit(key: string, now = Date.now()): boolean {
    const w = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    w.push(now);
    this.hits.set(key, w);
    if (this.hits.size > 50_000) this.hits.clear();
    return w.length > this.perMinute;
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class AutomateService {
  readonly store: AutomateStore;
  readonly cfg: AutomateConfig;
  private world: WorldReader;
  private targets: TargetRegistry;
  private verifier: LegVerifier;
  private clock: () => number;
  private writes: Limiter;
  private reads: Limiter;
  constructor(cfg: AutomateConfig, world: WorldReader, targets: TargetRegistry, verifier: LegVerifier, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.cfg = cfg;
    this.world = world;
    this.targets = targets;
    this.verifier = verifier;
    this.clock = clock;
    this.store = new AutomateStore(cfg.dbPath);
    this.writes = new Limiter(cfg.perIpPerMinute);
    this.reads = new Limiter(cfg.readsPerIpPerMinute);
  }

  health() { return { ok: true, service: "automate", chainId: this.cfg.expectedChainId }; }
  limited(ip: string, read: boolean): Result | null {
    return (read ? this.reads : this.writes).hit(ip) ? bad("RATE_LIMITED", 429) : null;
  }

  // ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Create, update, pause or resume: always a whole, newer, owner-signed rule. */
  async putRule(body: unknown): Promise<Result> {
    const b = body as { rule?: unknown; signature?: unknown };
    let rule: AutomationRule;
    try {
      rule = ruleFromJson(b?.rule);
    } catch (e) {
      return bad((e as Error).message || "INVALID_RULE");
    }
    if (rule.version !== AUTOMATE_VERSION) return bad("UNKNOWN_VERSION");
    if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) return bad("INVALID_SIGNATURE");
    const now = BigInt(this.clock());
    // a rule may always be PAUSED (even an expired one); enabling requires a fully valid spec
    const problem = ruleSpecProblem(rule, now);
    if (rule.enabled && problem) return bad(problem);
    if (!rule.enabled && problem && problem !== "RULE_EXPIRED") return bad(problem);
    if (rule.updatedAt > now + 300n || rule.createdAt > rule.updatedAt) return bad("INVALID_TIMESTAMP");
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ ...automationRuleTyped(this.cfg.domainAddress, rule, this.cfg.expectedChainId), signature: b.signature as Hex });
    } catch {
      return bad("INVALID_SIGNATURE");
    }
    if (signer.toLowerCase() !== rule.owner.toLowerCase()) return bad("INVALID_SIGNATURE");
    const existing = this.store.getRule(rule.id);
    if (existing && existing.owner !== rule.owner.toLowerCase()) return bad("NOT_OWNER", 403);
    if (!existing && this.store.countRules(rule.owner) >= this.cfg.maxRulesPerOwner) return bad("TOO_MANY_RULES");
    const saved = this.store.putRule({
      rule_id: rule.id, owner: rule.owner, record: json(ruleToJson(rule)), sig: b.signature, enabled: rule.enabled ? 1 : 0,
      updated_at: Number(rule.updatedAt), created_at: Number(rule.createdAt),
    });
    if (!saved) return bad("STALE_RULE", 409); // an older or equal version: no replays
    log("info", "rule.saved", { rule: rule.id, owner: rule.owner, enabled: rule.enabled, trigger: rule.trigger.kind });
    return ok({ rule: this.view(rule, now) });
  }

  rules(owner: string): Result {
    if (!isAddress(owner, { strict: false })) return bad("INVALID_ADDRESS");
    const now = BigInt(this.clock());
    return ok({ rules: this.store.rulesOf(owner).map((r) => this.view(ruleFromJson(JSON.parse(r.record)), now)) });
  }

  private view(rule: AutomationRule, now: bigint) {
    const last = this.store.executionsOf(rule.owner, 200).find((e) => e.rule_id === rule.id.toLowerCase());
    const state = !rule.enabled ? "PAUSED" : now >= rule.limits.expiresAt ? "EXPIRED" : "WAITING_TRIGGER";
    const targets = rule.actions.filter((a) => a.kind !== "KEEP_BALANCE").map((a) => ({ action: a, ...this.targets.availability(a as Exclude<Action, { kind: "KEEP_BALANCE" }>) }));
    return { rule: ruleToJson(rule), state, targets, lastExecution: last ? this.execView(last) : null };
  }

  // ── triggers → plans (internal: the indexer watcher) ─────────────────────────────────────────────────────────────

  authorizedInternal(header: string | undefined): boolean {
    if (!header) return false;
    const a = Buffer.from(header), b = Buffer.from(this.cfg.internalKey);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** A trusted event arrived: plan every matching enabled rule of its owner. Duplicate events plan nothing new. */
  async trigger(body: unknown): Promise<Result> {
    let ev: TriggerEvent;
    try {
      ev = parseEvent(body);
    } catch {
      return bad("INVALID_EVENT");
    }
    const owner = getAddress(ev.kind === "PAYMENT_RECEIVED" ? ev.recipient : ev.owner);
    const now = this.clock();
    const matching = this.store.rulesOf(owner).filter((r) => r.enabled === 1).map((r) => ruleFromJson(JSON.parse(r.record)))
      .filter((r) => KIND_FOR[r.trigger.kind] === ev.kind);
    const results: { ruleId: Hex; executionId?: Hex; planned: boolean; reason?: string }[] = [];
    for (const rule of matching) {
      const executionId = executionIdOf(rule.id, ev.id);
      if (this.store.getExecution(executionId)) { results.push({ ruleId: rule.id, executionId, planned: false, reason: "DUPLICATE_EVENT" }); continue; }
      const day = Number(dayOf(BigInt(now))), month = monthOf(BigInt(now));
      const used = this.store.used(rule.id, day, month);
      const [balance, reserved] = await Promise.all([this.world.balance(owner), this.world.reserved(owner)]);
      const harvestable: Record<string, bigint> = {};
      if (rule.trigger.kind === "YIELD_THRESHOLD") harvestable[rule.trigger.positionId] = await this.world.harvestable(owner, rule.trigger.positionId);
      const p = plan(rule, ev, {
        nowSec: BigInt(now), balance, reserved: reserved + this.store.inFlight(owner), harvestable,
        usedToday: used.today, usedThisMonth: used.month, availability: (a) => this.targets.availability(a),
        lastSchedulePeriod: this.store.lastSchedulePeriod(rule.id),
      });
      if (!p.ok) { results.push({ ruleId: rule.id, planned: false, reason: p.reason }); continue; }
      const initial: ExecutionState = p.moving === 0n ? outcomeOf(p.legs) : "READY";
      const inserted = this.store.insertExecution(
        {
          execution_id: executionId.toLowerCase(), rule_id: rule.id.toLowerCase(), owner: owner.toLowerCase(), event_id: ev.id, state: initial,
          base: p.base.toString(), moving: p.moving.toString(), kept: p.keptInBalance.toString(), source: p.source, day, month,
          created_at: now, updated_at: now, expires_at: now + this.cfg.confirmWindowSec,
          history: JSON.stringify([{ state: "TRIGGERED", at: now }, { state: initial, at: now }]),
        },
        p.legs.map((l) => legRow(executionId, l, now)),
      );
      results.push({ ruleId: rule.id, executionId, planned: inserted, reason: inserted ? undefined : "DUPLICATE_EVENT" });
      if (inserted) log("info", "execution.planned", { rule: rule.id, execution: executionId, moving: p.moving.toString(), state: initial });
    }
    return ok({ event: ev.id, results });
  }

  // ── executions ───────────────────────────────────────────────────────────────────────────────────────────────────

  executions(owner: string): Result {
    if (!isAddress(owner, { strict: false })) return bad("INVALID_ADDRESS");
    this.sweep();
    return ok({ executions: this.store.executionsOf(owner).map((e) => this.execView(e)) });
  }
  execution(id: string): Result {
    this.sweep();
    const e = this.store.getExecution(id);
    return e ? ok({ execution: this.execView(e) }) : bad("NOT_FOUND", 404);
  }

  private execView(e: ExecutionRow) {
    return {
      executionId: e.execution_id, ruleId: e.rule_id, owner: e.owner, eventId: e.event_id, state: e.state, base: e.base, moving: e.moving,
      keptInBalance: e.kept, source: e.source, createdAt: e.created_at, expiresAt: e.expires_at, history: JSON.parse(e.history),
      legs: this.store.legsOf(e.execution_id).map((l) => ({
        index: l.leg_index, action: JSON.parse(l.action), allocated: l.allocated, amount: l.amount, leftInBalance: l.left_in_balance,
        status: l.status, reason: l.reason, txHash: l.tx_hash, idempotencyKey: l.idempotency_key,
      })),
    };
  }

  /** The owner reports one leg they executed. DONE counts only once the chain proves it. */
  async reportLeg(body: unknown): Promise<Result> {
    const b = body as { report?: Record<string, unknown>; signature?: unknown };
    const r = b?.report;
    if (!r || typeof b.signature !== "string") return bad("INVALID_REPORT");
    const report: LegReport = { executionId: String(r.executionId) as Hex, legIndex: Number(r.legIndex), outcome: Number(r.outcome) as LegReport["outcome"], txHash: String(r.txHash) as Hex };
    if (!/^0x[0-9a-f]{64}$/i.test(report.executionId) || !/^0x[0-9a-f]{64}$/i.test(report.txHash) || !Number.isInteger(report.legIndex)) return bad("INVALID_REPORT");
    if (report.outcome !== LegOutcome.DONE && report.outcome !== LegOutcome.FAILED) return bad("INVALID_REPORT");
    this.sweep();
    const e = this.store.getExecution(report.executionId);
    if (!e) return bad("NOT_FOUND", 404);
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ ...legReportTyped(this.cfg.domainAddress, report, this.cfg.expectedChainId), signature: b.signature as Hex });
    } catch {
      return bad("INVALID_SIGNATURE");
    }
    if (signer.toLowerCase() !== e.owner) return bad("INVALID_SIGNATURE");
    if (e.state !== "READY" && e.state !== "EXECUTING") return bad("EXECUTION_CLOSED", 409);
    const leg = this.store.legsOf(e.execution_id).find((l) => l.leg_index === report.legIndex);
    if (!leg || !legRunnable({ status: leg.status as LegStatus, amount: BigInt(leg.amount) })) return bad("LEG_NOT_RUNNABLE", 409);
    const now = this.clock();
    if (report.outcome === LegOutcome.FAILED) {
      this.store.setLeg(e.execution_id, leg.leg_index, "FAILED", null, "REPORTED_FAILED", now);
    } else {
      const v = await this.verifier.verify(getAddress(e.owner), JSON.parse(leg.action), BigInt(leg.amount), report.txHash);
      if (v === "NOT_FINAL") return bad("NOT_FINAL", 202);
      if (v === "MISMATCH") return bad("TX_DOES_NOT_MATCH_LEG", 409);
      try {
        this.store.setLeg(e.execution_id, leg.leg_index, "DONE", report.txHash.toLowerCase(), null, now);
      } catch {
        return bad("TX_ALREADY_USED", 409); // one transaction can't complete two legs
      }
    }
    this.refreshState(e.execution_id, now);
    return this.execution(e.execution_id);
  }

  private refreshState(id: string, now: number) {
    const legs = this.store.legsOf(id).map(toPlanLeg);
    const s = outcomeOf(legs);
    this.store.setExecutionState(id, s === "EXECUTING" ? "EXECUTING" : s, now);
  }

  /** Lapse executions the owner didn't confirm in time: their unexecuted legs fail, the money never left the balance. */
  sweep(): void {
    const now = this.clock();
    for (const e of this.store.stale(now)) {
      for (const l of this.store.legsOf(e.execution_id)) {
        if (legRunnable({ status: l.status as LegStatus, amount: BigInt(l.amount) })) this.store.setLeg(e.execution_id, l.leg_index, "FAILED", null, "NOT_CONFIRMED", now);
      }
      this.refreshState(e.execution_id, now);
      log("info", "execution.lapsed", { execution: e.execution_id });
    }
  }
}

const KIND_FOR = { PAYMENT_RECEIVED: "PAYMENT_RECEIVED", BALANCE_ABOVE: "BALANCE_CHECK", SCHEDULE: "SCHEDULE_TICK", YIELD_THRESHOLD: "YIELD_CHECK" } as const;

function legRow(executionId: Hex, l: PlanLeg, now: number): LegRow {
  return {
    execution_id: executionId.toLowerCase(), leg_index: l.index, idempotency_key: l.idempotencyKey, action: json(l.action),
    allocated: l.allocated.toString(), amount: l.amount.toString(), left_in_balance: l.leftInBalance.toString(), status: l.status,
    reason: l.reason ?? null, tx_hash: null, updated_at: now,
  };
}
function toPlanLeg(l: LegRow) {
  return { action: JSON.parse(l.action) as Action, status: l.status as LegStatus, amount: BigInt(l.amount), leftInBalance: BigInt(l.left_in_balance) };
}

const u = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{1,40}$/.test(v)) throw new Error("bad");
  return BigInt(v);
};
const addr = (v: unknown) => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error("bad");
  return getAddress(v);
};
const evId = (v: unknown) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9:_.-]{1,140}$/.test(v)) throw new Error("bad");
  return v;
};
export function parseEvent(body: unknown): TriggerEvent {
  const e = (body as { event?: Record<string, unknown> })?.event;
  if (!e) throw new Error("bad");
  switch (e.kind) {
    case "PAYMENT_RECEIVED":
      if (e.origin !== "EXTERNAL" && e.origin !== "AUTOMATION") throw new Error("bad");
      return { kind: e.kind, id: evId(e.id), recipient: addr(e.recipient), amount: u(e.amount), at: u(e.at), origin: e.origin };
    case "BALANCE_CHECK": case "SCHEDULE_TICK":
      return { kind: e.kind, id: evId(e.id), owner: addr(e.owner), at: u(e.at) };
    case "YIELD_CHECK":
      return { kind: e.kind, id: evId(e.id), owner: addr(e.owner), positionId: evId(e.positionId), at: u(e.at) };
    default:
      throw new Error("bad");
  }
}
