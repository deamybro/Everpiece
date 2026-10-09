// BOUNDED_MODULE (docs/AUTOMATE.md §5): a rule with a verified on-chain grant runs WITHOUT the owner. The fake
// ModuleExecutor stands in for EverpieceAutomate + the relayer (both fork-tested in contracts/test/fork). What this
// proves: grants are verified before they count; runs are idempotent; a failed leg leaves its money in the balance and
// says so; a leg not yet final is never reported failed and completes on the next sweep.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { automationRuleTyped, ruleToJson, type AutomationRule, type Grant, type RuleSpec } from "@everpiece/shared";
import { AutomateService, type ModuleExecutor } from "../src/service.ts";
import { loadConfig } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";

const DOMAIN = "0x6305d15C7718ec139255024E071F55061793eA08";
const CHAIN = 143;
const VAULT = "0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2" as Address; // Aave waMonUSDC (aave-v3-usdc)
const RELAYER = "0x00000000000000000000000000000000000E0E0E" as Address;
let owner = privateKeyToAccount(`0x${"42".repeat(32)}`);
let ownerN = 0x42;
/** A fresh owner per test: a payment triggers every enabled rule of its owner. */
const freshOwner = () => { owner = privateKeyToAccount(`0x${(++ownerN).toString(16).padStart(2, "0").repeat(32)}`); };
const $ = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;
const DB = join(tmpdir(), `automate-bounded-${process.pid}.sqlite`);
let now = 1_791_331_200;
let svc: AutomateService;

// fake chain + relayer
const executed = new Map<string, Hex>(); // legKey → tx
let nextOutcome: "ok" | "fail" | "pending" = "ok";
let grantState: "ok" | "revoked" | "missing" = "ok";
const module: ModuleExecutor = {
  async verifyGrant(rule, grant) {
    if (grant.executor.toLowerCase() !== RELAYER.toLowerCase()) return { problem: "WRONG_EXECUTOR" };
    if (grant.ruleId.toLowerCase() !== rule.id.toLowerCase()) return { problem: "GRANT_DOES_NOT_MATCH_RULE" };
    if (grantState === "missing") return { problem: "GRANT_NOT_ACTIVE" };
    if (grantState === "revoked") return { problem: "GRANT_REVOKED" };
    return { grantId: ("0x9a" + rule.id.slice(4)) as Hex, vault: grant.vault };
  },
  async execute(_grantId, legKey) {
    if (executed.has(legKey)) return { ok: true, txHash: executed.get(legKey)! }; // idempotent on-chain
    if (nextOutcome === "fail") return { ok: false, reason: "GRANT_LIMIT" };
    const tx = `0x${(executed.size + 1).toString(16).padStart(64, "0")}` as Hex;
    if (nextOutcome === "pending") {
      executed.set(legKey, tx); // lands later
      return { ok: false, reason: "EXECUTION_STILL_PENDING" };
    }
    executed.set(legKey, tx);
    return { ok: true, txHash: tx };
  },
};

before(() => {
  setLogSink(() => {}, "alert");
  rmSync(DB, { force: true });
  const cfg = loadConfig({ DIRECTORY_DOMAIN_ADDRESS: DOMAIN, AUTOMATE_INTERNAL_KEY: "k".repeat(40), AUTOMATE_DB: DB, EXPECTED_CHAIN_ID: String(CHAIN) });
  svc = new AutomateService(
    cfg,
    { balance: async () => $(1_000), reserved: async () => 0n, harvestable: async () => 0n },
    { availability: () => ({ status: "AVAILABLE" }) },
    { verify: async () => "MISMATCH" },
    () => now,
    module,
  );
});
after(() => {
  svc.store.close();
  rmSync(DB, { force: true });
});

const spec: RuleSpec = {
  name: "Keep half, earn the rest",
  trigger: { kind: "PAYMENT_RECEIVED", minAmount: 0n },
  actions: [{ kind: "KEEP_BALANCE", bps: 5000 }, { kind: "DEPOSIT_YIELD", bps: 5000, opportunityId: "aave-v3-usdc" }],
  limits: { maxPerExecution: $(50), maxPerDay: $(80), maxPerMonth: $(500), expiresAt: BigInt(now + 30 * 86_400) },
  authorization: "BOUNDED_MODULE",
};
let n = 0;
async function putRule(): Promise<AutomationRule> {
  const rule: AutomationRule = { ...spec, version: 1, id: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, owner: owner.address, enabled: true, createdAt: BigInt(now), updatedAt: BigInt(now) };
  const r = await svc.putRule({ rule: ruleToJson(rule), signature: await owner.signTypedData(automationRuleTyped(DOMAIN, rule, CHAIN)) });
  assert.equal(r.httpStatus, 200, JSON.stringify(r.body));
  return rule;
}
const grantFor = (rule: AutomationRule, over: Partial<Grant> = {}) => {
  const g = { ruleId: rule.id, owner: owner.address, executor: RELAYER, vault: VAULT, maxPerExecution: $(50), maxPerDay: $(80), total: $(500), expiresAt: rule.limits.expiresAt, ...over };
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
};
const paid = (id: string, amount: bigint) => ({ event: { kind: "PAYMENT_RECEIVED", id, recipient: owner.address, amount: amount.toString(), at: String(now), origin: "EXTERNAL" } });
const execOf = async (id: string) => (svc.execution(id).body as { execution: { state: string; legs: { status: string; amount: string; reason: string | null; txHash: string | null }[] } }).execution;

test("a grant counts only once verified on-chain (executor, rule, active)", async () => {
  const rule = await putRule();
  assert.equal(((await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule, { executor: owner.address }) })).body as { error?: string }).error, "WRONG_EXECUTOR");
  grantState = "missing";
  assert.equal(((await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule) })).body as { error?: string }).error, "GRANT_NOT_ACTIVE");
  grantState = "revoked";
  assert.equal(((await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule) })).body as { error?: string }).error, "GRANT_REVOKED");
  grantState = "ok";
  assert.equal((await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule) })).httpStatus, 200);
  // the same on-chain grant can't be attached to a second rule
  const other = await putRule();
  const reuse = { ...grantFor(other) };
  const fakeSameId: ModuleExecutor = { ...module, verifyGrant: async () => ({ grantId: ("0x9a" + rule.id.slice(4)) as Hex, vault: VAULT }) };
  const saved = (svc as unknown as { module: ModuleExecutor }).module;
  (svc as unknown as { module: ModuleExecutor }).module = fakeSameId;
  assert.equal(((await svc.linkGrant({ ruleId: other.id, grant: reuse })).body as { error?: string }).error, "GRANT_ALREADY_LINKED");
  (svc as unknown as { module: ModuleExecutor }).module = saved;
});

test("without the owner: a payment arrives, the Earn leg runs through the grant, the run completes; same event never runs twice", async () => {
  freshOwner();
  const rule = await putRule();
  await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule) });
  nextOutcome = "ok";
  const r = await svc.trigger(paid("paid:0xaa", $(60)));
  const id = (r.body as { results: { executionId: string }[] }).results[0].executionId;
  const e = await execOf(id);
  assert.equal(e.state, "COMPLETED");
  const leg = e.legs.find((l) => l.status === "DONE")!;
  assert.equal(leg.amount, $(30).toString()); // 50% of 60
  assert.ok(leg.txHash);
  const again = await svc.trigger(paid("paid:0xaa", $(60)));
  assert.equal((again.body as { results: { reason: string }[] }).results[0].reason, "DUPLICATE_EVENT");
});

test("an executor failure leaves the money in the balance and says so (never COMPLETED)", async () => {
  now += 86_400;
  freshOwner();
  const rule = await putRule();
  await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule) });
  nextOutcome = "fail";
  const r = await svc.trigger(paid("paid:0xbb", $(40)));
  const e = await execOf((r.body as { results: { executionId: string }[] }).results[0].executionId);
  assert.equal(e.state, "FAILED");
  assert.equal(e.legs.find((l) => l.status === "FAILED")?.reason, "GRANT_LIMIT");
});

test("a leg not final in time stays EXECUTING (not FAILED) and completes on the next sweep, idempotently", async () => {
  now += 86_400;
  freshOwner();
  const rule = await putRule();
  await svc.linkGrant({ ruleId: rule.id, grant: grantFor(rule) });
  nextOutcome = "pending";
  const before = executed.size;
  const r = await svc.trigger(paid("paid:0xcc", $(20)));
  const id = (r.body as { results: { executionId: string }[] }).results[0].executionId;
  let e = await execOf(id);
  assert.equal(e.state, "EXECUTING");
  assert.ok(e.legs.some((l) => l.status === "EXECUTING"));
  nextOutcome = "ok";
  await svc.sweepBounded();
  e = await execOf(id);
  assert.equal(e.state, "COMPLETED");
  assert.equal(executed.size, before + 1); // the pending leg ran once on-chain, not twice
});

test("a BOUNDED rule without a linked grant waits for the owner instead of running", async () => {
  now += 86_400;
  freshOwner();
  await putRule();
  nextOutcome = "ok";
  const before = executed.size;
  const r = await svc.trigger(paid("paid:0xdd", $(10)));
  const e = await execOf((r.body as { results: { executionId: string }[] }).results.at(-1)!.executionId);
  assert.equal(e.state, "READY");
  assert.equal(executed.size, before);
});
