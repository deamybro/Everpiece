import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  automationRuleTyped, describeRule, idempotencyKey, outcomeOf, plan, ruleFromJson, ruleSpecProblem, ruleToJson, specHashOf,
  type AutomationRule, type PlanContext, type RuleSpec, type TriggerEvent,
} from "../src/index.ts";

/** dollars → AUSD base units (test helper only; the engine never sees a float) */
const $ = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;
const NOW = 1_791_331_200n; // 2026-10-07T00:00:00Z
const DOMAIN = "0x6305d15C7718ec139255024E071F55061793eA08";
const stella = privateKeyToAccount(`0x${"42".repeat(32)}`);
const OWNER = stella.address;
const RULE_ID = `0x${"ab".repeat(32)}` as Hex;

const split: RuleSpec = {
  name: "Split my income",
  trigger: { kind: "PAYMENT_RECEIVED", minAmount: 0n },
  actions: [{ kind: "KEEP_BALANCE", bps: 5000 }, { kind: "DEPOSIT_YIELD", bps: 3000, opportunityId: "test-vault" }, { kind: "BUY_STOCK", bps: 2000, assetId: "aNVDA" }],
  limits: { maxPerExecution: $(500), maxPerDay: $(1000), maxPerMonth: $(5000), expiresAt: NOW + 30n * 86_400n },
  authorization: "CONFIRM_EACH",
};
const rule = (s: RuleSpec, over: Partial<AutomationRule> = {}): AutomationRule =>
  ({ ...s, version: 1, id: RULE_ID, owner: OWNER, enabled: true, createdAt: NOW, updatedAt: NOW, ...over });
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  nowSec: NOW, balance: $(1000), reserved: 0n, harvestable: {}, usedToday: 0n, usedThisMonth: 0n,
  availability: () => ({ status: "AVAILABLE" }), ...over,
});
const paid = (amount: bigint, id = "0xtx:1", recipient: Address = OWNER): TriggerEvent =>
  ({ kind: "PAYMENT_RECEIVED", id, recipient, amount, at: NOW, origin: "EXTERNAL" });

test("validation: allocation must be exactly 100%, limits ordered, expiry bounded, reserved kinds refused", () => {
  assert.equal(ruleSpecProblem(split, NOW), null);
  assert.equal(ruleSpecProblem({ ...split, actions: [{ kind: "KEEP_BALANCE", bps: 5000 }, { kind: "BUY_STOCK", bps: 4000, assetId: "aNVDA" }] }, NOW), "ALLOCATION_NOT_100");
  assert.equal(ruleSpecProblem({ ...split, actions: [{ kind: "KEEP_BALANCE", bps: 10_000 }] }, NOW), "NOTHING_MOVES");
  assert.equal(ruleSpecProblem({ ...split, actions: [{ kind: "BUY_STOCK", bps: 5000, assetId: "aNVDA" }, { kind: "BUY_STOCK", bps: 5000, assetId: "aNVDA" }] }, NOW), "DUPLICATE_ACTION");
  assert.equal(ruleSpecProblem({ ...split, actions: [{ kind: "SEND", bps: 10_000 } as never] }, NOW), "ACTION_NOT_SUPPORTED");
  assert.equal(ruleSpecProblem({ ...split, trigger: { kind: "STREAM_ACCRUAL" } as never }, NOW), "TRIGGER_NOT_SUPPORTED");
  assert.equal(ruleSpecProblem({ ...split, limits: { ...split.limits, maxPerExecution: $(2000) } }, NOW), "INVALID_LIMITS");
  assert.equal(ruleSpecProblem({ ...split, limits: { ...split.limits, expiresAt: NOW } }, NOW), "RULE_EXPIRED");
  assert.equal(ruleSpecProblem({ ...split, limits: { ...split.limits, expiresAt: NOW + 400n * 86_400n } }, NOW), "EXPIRY_TOO_FAR");
  assert.equal(ruleSpecProblem({ ...split, authorization: "BOUNDED_MODULE" }, NOW), "AUTHORIZATION_NOT_AVAILABLE");
  assert.equal(ruleSpecProblem({ ...split, actions: [{ kind: "BUY_STOCK", bps: 0, assetId: "aNVDA" }, { kind: "KEEP_BALANCE", bps: 10_000 }] }, NOW), "INVALID_ALLOCATION");
});

test("payment split 50/30/20: exact base units, rounding remainder stays in the balance", () => {
  const p = plan(rule(split), paid(1_000_001n), ctx());
  assert.ok(p.ok);
  assert.deepEqual(p.legs.map((l) => [l.status, l.amount, l.leftInBalance]), [
    ["KEPT", 0n, 500_001n], // 500_000 + remainder 1
    ["PENDING", 300_000n, 0n],
    ["PENDING", 200_000n, 0n],
  ]);
  assert.equal(p.moving + p.keptInBalance, p.base);
  assert.equal(p.legs[2].idempotencyKey, idempotencyKey(RULE_ID, "0xtx:1", 2));
});

test("unavailable provider: its 20% stays in the balance, never redistributed; outcome is PARTIALLY_COMPLETED, not COMPLETED", () => {
  const p = plan(rule(split), paid($(100)), ctx({ availability: (a) => (a.kind === "BUY_STOCK" ? { status: "UNAVAILABLE", reason: "INVESTMENT_ROUTE_UNAVAILABLE" } : { status: "AVAILABLE" }) }));
  assert.ok(p.ok);
  assert.equal(p.legs[1].amount, $(30)); // Earn did not grow
  assert.deepEqual([p.legs[2].status, p.legs[2].amount, p.legs[2].leftInBalance, p.legs[2].reason], ["UNAVAILABLE", 0n, $(20), "INVESTMENT_ROUTE_UNAVAILABLE"]);
  assert.equal(p.keptInBalance, $(70));
  const after = p.legs.map((l) => (l.index === 1 ? { ...l, status: "DONE" as const } : l));
  assert.equal(outcomeOf(after), "PARTIALLY_COMPLETED");
  // everything unavailable: nothing moves at all → FAILED, and all of it is still in the balance
  const none = plan(rule(split), paid($(100)), ctx({ availability: () => ({ status: "UNAVAILABLE" }) }));
  assert.ok(none.ok);
  assert.equal(none.moving, 0n);
  assert.equal(outcomeOf(none.legs), "FAILED");
});

test("a failed leg (provider broke mid-run) → PARTIALLY_COMPLETED; all legs done → COMPLETED", () => {
  const p = plan(rule(split), paid($(100)), ctx());
  assert.ok(p.ok);
  assert.equal(outcomeOf(p.legs), "EXECUTING");
  assert.equal(outcomeOf(p.legs.map((l) => ({ ...l, status: l.action.kind === "BUY_STOCK" ? "FAILED" as const : l.status === "PENDING" ? "DONE" as const : l.status }))), "PARTIALLY_COMPLETED");
  assert.equal(outcomeOf(p.legs.map((l) => ({ ...l, status: l.status === "PENDING" ? "DONE" as const : l.status }))), "COMPLETED");
});

test("daily and monthly limits cap the moving total pro-rata; the cut stays in the balance", () => {
  // $1,000 received: wants $500 moving, but only $100 left today
  const p = plan(rule(split), paid($(1000)), ctx({ usedToday: $(900) }));
  assert.ok(p.ok);
  assert.equal(p.moving, $(100));
  assert.deepEqual(p.legs.slice(1).map((l) => [l.status, l.amount, l.reason]), [["LIMITED", $(60), "LIMIT"], ["LIMITED", $(40), "LIMIT"]]);
  assert.equal(p.moving + p.keptInBalance, p.base);
  assert.equal(outcomeOf(p.legs.map((l) => ({ ...l, status: l.status === "LIMITED" ? "DONE" as const : l.status }))), "PARTIALLY_COMPLETED");
  // month exhausted → no run at all
  assert.deepEqual(plan(rule(split), paid($(10)), ctx({ usedThisMonth: $(5000) })), { ok: false, reason: "LIMIT_REACHED" });
  // per-execution cap
  const big = plan(rule(split), paid($(10_000)), ctx({ balance: $(20_000) }));
  assert.ok(big.ok);
  assert.equal(big.moving, $(500));
});

test("disabled, expired, wrong recipient, own movements and below-minimum payments never run", () => {
  assert.deepEqual(plan(rule(split, { enabled: false }), paid($(10)), ctx()), { ok: false, reason: "RULE_DISABLED" });
  assert.deepEqual(plan(rule(split), paid($(10)), ctx({ nowSec: split.limits.expiresAt })), { ok: false, reason: "RULE_EXPIRED" });
  assert.deepEqual(plan(rule(split), paid($(10), "x", "0x000000000000000000000000000000000000dEaD"), ctx()), { ok: false, reason: "NOT_OWNER" });
  assert.deepEqual(plan(rule(split), { ...paid($(10)), origin: "AUTOMATION" } as TriggerEvent, ctx()), { ok: false, reason: "SELF_TRIGGERED" });
  assert.deepEqual(plan(rule({ ...split, trigger: { kind: "PAYMENT_RECEIVED", minAmount: $(5) } }), paid($(4.99)), ctx()), { ok: false, reason: "BELOW_MINIMUM" });
  assert.deepEqual(plan(rule(split), { kind: "BALANCE_CHECK", id: "b", owner: OWNER, at: NOW }, ctx()), { ok: false, reason: "TRIGGER_MISMATCH" });
});

test("duplicate trigger: the same event yields the same idempotency keys (the store refuses the second run)", () => {
  const a = plan(rule(split), paid($(10), "0xabc:7"), ctx());
  const b = plan(rule(split), paid($(10), "0xabc:7"), ctx());
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.legs.map((l) => l.idempotencyKey), b.legs.map((l) => l.idempotencyKey));
  const c = plan(rule(split), paid($(10), "0xabc:8"), ctx());
  assert.ok(c.ok);
  assert.notEqual(c.legs[1].idempotencyKey, a.legs[1].idempotencyKey);
});

test("keep $100, earn the rest: only the excess of SPENDABLE balance moves; pending payouts are never touched", () => {
  const keep: RuleSpec = { ...split, name: "Keep $100, earn the rest", trigger: { kind: "BALANCE_ABOVE", keep: $(100) }, actions: [{ kind: "DEPOSIT_YIELD", bps: 10_000, opportunityId: "test-vault" }] };
  const ev: TriggerEvent = { kind: "BALANCE_CHECK", id: "bal:111", owner: OWNER, at: NOW };
  const p = plan(rule(keep), ev, ctx({ balance: $(250) }));
  assert.ok(p.ok);
  assert.equal(p.moving, $(150));
  // $120 is reserved for a pending bank payout: spendable $130 → only $30 above the $100
  const r = plan(rule(keep), ev, ctx({ balance: $(250), reserved: $(120) }));
  assert.ok(r.ok);
  assert.equal(r.moving, $(30));
  assert.deepEqual(plan(rule(keep), ev, ctx({ balance: $(250), reserved: $(150) })), { ok: false, reason: "NOTHING_ABOVE_KEEP" });
});

test("Earn → Invest: runs only at the threshold, uses earnings only — principal is never touched, whatever the limits", () => {
  const e2i: RuleSpec = {
    ...split, name: "Earn → Invest", trigger: { kind: "YIELD_THRESHOLD", positionId: "test-vault", threshold: $(10) },
    actions: [{ kind: "BUY_STOCK", bps: 4000, assetId: "aNVDA" }, { kind: "BUY_STOCK", bps: 3000, assetId: "aAAPL" }, { kind: "BUY_STOCK", bps: 3000, assetId: "aMSFT" }],
  };
  const ev: TriggerEvent = { kind: "YIELD_CHECK", id: "yield:111", owner: OWNER, positionId: "test-vault", at: NOW };
  assert.deepEqual(plan(rule(e2i), ev, ctx({ harvestable: { "test-vault": $(9.99) } })), { ok: false, reason: "BELOW_THRESHOLD" });
  const p = plan(rule(e2i), ev, ctx({ harvestable: { "test-vault": $(12.4) }, balance: 0n }));
  assert.ok(p.ok);
  assert.equal(p.source, "YIELD");
  assert.equal(p.base, $(12.4)); // the earnings, not the principal
  assert.ok(p.moving <= $(12.4));
  // only aNVDA executable: Apple/Microsoft shares stay as earnings, not redistributed to NVIDIA
  const only = plan(rule(e2i), ev, ctx({ harvestable: { "test-vault": $(10) }, availability: (a) => (a.kind === "BUY_STOCK" && a.assetId === "aNVDA" ? { status: "AVAILABLE" } : { status: "UNAVAILABLE" }) }));
  assert.ok(only.ok);
  assert.equal(only.moving, $(4));
  assert.equal(only.keptInBalance, $(6));
  // a huge limit can't reach principal: the ceiling is the harvestable yield
  const capped = plan(rule({ ...e2i, limits: { ...e2i.limits, maxPerExecution: $(1000), maxPerDay: $(1000) } }), ev, ctx({ harvestable: { "test-vault": $(10) } }));
  assert.ok(capped.ok);
  assert.equal(capped.moving, $(10));
});

test("SCHEDULE: once per period, never early, no forged future ticks", () => {
  const sched: RuleSpec = { ...split, trigger: { kind: "SCHEDULE", everySec: 604_800n, startAt: NOW, amount: $(20) } };
  const tick = (period: bigint): TriggerEvent => ({ kind: "SCHEDULE_TICK", id: `sched:${period}`, owner: OWNER, at: NOW });
  assert.deepEqual(plan(rule(sched), tick(0n), ctx({ nowSec: NOW - 1n })), { ok: false, reason: "NOT_DUE" });
  assert.ok(plan(rule(sched), tick(0n), ctx()).ok);
  assert.deepEqual(plan(rule(sched), tick(0n), ctx({ lastSchedulePeriod: 0n })), { ok: false, reason: "ALREADY_RAN_THIS_PERIOD" });
  assert.deepEqual(plan(rule(sched), tick(1n), ctx()), { ok: false, reason: "TRIGGER_MISMATCH" });
});

test("signed rule: the signature covers every spec field (a tampered allocation fails); JSON round-trip is exact", async () => {
  const r = rule(split);
  const sig = await stella.signTypedData(automationRuleTyped(DOMAIN, r, 10143));
  assert.equal(await recoverTypedDataAddress({ ...automationRuleTyped(DOMAIN, r, 10143), signature: sig }), OWNER);
  const tampered: AutomationRule = { ...r, actions: [{ kind: "KEEP_BALANCE", bps: 1000 }, { kind: "DEPOSIT_YIELD", bps: 3000, opportunityId: "test-vault" }, { kind: "BUY_STOCK", bps: 6000, assetId: "aNVDA" }] };
  assert.notEqual(specHashOf(tampered), specHashOf(r));
  assert.notEqual(await recoverTypedDataAddress({ ...automationRuleTyped(DOMAIN, tampered, 10143), signature: sig }), OWNER);
  const roundTrip = ruleFromJson(JSON.parse(JSON.stringify(ruleToJson(r))));
  assert.deepEqual(roundTrip, r);
  assert.equal(specHashOf(roundTrip), specHashOf(r));
  assert.throws(() => ruleFromJson({ ...ruleToJson(r), limits: { ...ruleToJson(r).limits as object, maxPerDay: "1e9" } }));
});

test("preview is human-readable and honest about authorization", () => {
  const d = describeRule(split, { opportunity: () => "Test vault (simulated)", asset: (id) => id, position: (id) => id });
  assert.equal(d.when, "When money arrives");
  assert.deepEqual(d.then, ["50% stays in your balance", "30% goes into Earn: Test vault (simulated)", "20% buys aNVDA"]);
  assert.equal(d.limits[0], "At most $500.00 each time, $1,000.00 a day, $5,000.00 a month");
  assert.equal(d.limits[2], "You confirm each run with your fingerprint");
});
