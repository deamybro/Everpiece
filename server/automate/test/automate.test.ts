// The Automate service over HTTP: owner-signed rules (create, tamper, replay, pause), trusted trigger intake, idempotent
// planning, limits across executions, unavailable providers, on-chain-proven leg reports, lapsing. Fakes stand in for
// the chain, the provider registry and the receipt verifier.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { automationRuleTyped, legReportTyped, ruleToJson, LegOutcome, type Action, type AutomationRule, type RuleSpec } from "@everpiece/shared";
import { AutomateService } from "../src/service.ts";
import { createAutomateServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";

const DOMAIN = "0x6305d15C7718ec139255024E071F55061793eA08";
const CHAIN = 10143;
const KEY = "k".repeat(40);
const stella = privateKeyToAccount(`0x${"42".repeat(32)}`);
const eve = privateKeyToAccount(`0x${"66".repeat(32)}`);
const $ = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;

let now = 1_791_331_200; // 2026-10-07T00:00:00Z
const balances = new Map<string, bigint>();
const unavailable = new Set<string>(); // assetIds / opportunityIds
const proofs = new Map<string, "OK" | "NOT_FINAL" | "MISMATCH">(); // txHash → verifier answer
const DB = join(tmpdir(), `automate-test-${process.pid}.sqlite`);
let server: Server;
let base: string;
let svc: AutomateService;

before(async () => {
  setLogSink(() => {}, "alert");
  rmSync(DB, { force: true });
  const cfg = loadConfig({ DIRECTORY_DOMAIN_ADDRESS: DOMAIN, AUTOMATE_INTERNAL_KEY: KEY, AUTOMATE_DB: DB, EXPECTED_CHAIN_ID: String(CHAIN), CONFIRM_WINDOW_SEC: "3600" });
  svc = new AutomateService(
    cfg,
    { balance: async (o) => balances.get(o.toLowerCase()) ?? 0n, reserved: async () => 0n, harvestable: async () => $(12.4) },
    { availability: (a) => (unavailable.has(a.kind === "BUY_STOCK" ? a.assetId : a.opportunityId) ? { status: "UNAVAILABLE", reason: "INVESTMENT_ROUTE_UNAVAILABLE" } : { status: "AVAILABLE" }) },
    { verify: async (_o, _a, _amt, tx) => proofs.get(tx) ?? "MISMATCH" },
    () => now,
  );
  server = createAutomateServer(svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  svc.store.close();
  rmSync(DB, { force: true });
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as any };
};

const split: RuleSpec = {
  name: "Split my income",
  trigger: { kind: "PAYMENT_RECEIVED", minAmount: 0n },
  actions: [{ kind: "KEEP_BALANCE", bps: 5000 }, { kind: "DEPOSIT_YIELD", bps: 3000, opportunityId: "test-vault" }, { kind: "BUY_STOCK", bps: 2000, assetId: "aNVDA" }],
  limits: { maxPerExecution: $(50), maxPerDay: $(60), maxPerMonth: $(500), expiresAt: BigInt(now + 30 * 86_400) },
  authorization: "CONFIRM_EACH",
};
let n = 0;
const makeRule = (spec: RuleSpec, over: Partial<AutomationRule> = {}): AutomationRule => ({
  ...spec, version: 1, id: `0x${(++n).toString(16).padStart(64, "0")}` as Hex, owner: stella.address, enabled: true,
  createdAt: BigInt(now), updatedAt: BigInt(now), ...over,
});
const signed = async (r: AutomationRule, by = stella) => ({ rule: ruleToJson(r), signature: await by.signTypedData(automationRuleTyped(DOMAIN, r, CHAIN)) });
const trigger = (event: Record<string, unknown>, key = KEY) => post("/v1/automate/triggers", { event }, { "x-automate-key": key });
const paid = (id: string, amount: bigint, recipient = stella.address) => ({ kind: "PAYMENT_RECEIVED", id, recipient, amount: amount.toString(), at: String(now), origin: "EXTERNAL" });
const report = async (executionId: Hex, legIndex: number, outcome: 1 | 2, txHash: Hex, by = stella) => {
  const rep = { executionId, legIndex, outcome, txHash };
  return post("/v1/automate/legs", { report: rep, signature: await by.signTypedData(legReportTyped(DOMAIN, rep, CHAIN)) });
};

test("rules: only the owner's signature creates one; tampering, replays and takeovers are refused; pause works", async () => {
  const r = makeRule(split);
  const created = await post("/v1/automate/rules", await signed(r));
  assert.equal(created.status, 200);
  assert.equal(created.body.rule.state, "WAITING_TRIGGER");

  // tampered after signing: 50/30/20 → 10/30/60
  const body = await signed({ ...r, updatedAt: r.updatedAt + 1n });
  body.rule = ruleToJson({ ...r, updatedAt: r.updatedAt + 1n, actions: [{ kind: "KEEP_BALANCE", bps: 1000 }, split.actions[1], { ...split.actions[2], bps: 6000 } as Action] });
  assert.deepEqual((await post("/v1/automate/rules", body)).body, { error: "INVALID_SIGNATURE" });
  // someone else signs a rule for Stella's account
  assert.deepEqual((await post("/v1/automate/rules", await signed(makeRule(split), eve))).body, { error: "INVALID_SIGNATURE" });
  // Eve takes over Stella's rule id with her own account
  assert.equal((await post("/v1/automate/rules", await signed({ ...r, owner: eve.address, updatedAt: r.updatedAt + 5n }, eve))).status, 403);
  // invalid spec
  assert.deepEqual((await post("/v1/automate/rules", await signed(makeRule({ ...split, actions: [{ kind: "BUY_STOCK", bps: 9000, assetId: "aNVDA" }] })))).body, { error: "ALLOCATION_NOT_100" });

  // pause (a newer signed version) → PAUSED; replaying the older enabled version is refused
  const old = await signed(r);
  now += 10;
  const paused = await post("/v1/automate/rules", await signed({ ...r, enabled: false, updatedAt: BigInt(now) }));
  assert.equal(paused.body.rule.state, "PAUSED");
  assert.equal((await post("/v1/automate/rules", old)).status, 409);
  const list = await get(`/v1/automate/rules/${stella.address}`);
  assert.equal(list.body.rules.length, 1);
  assert.equal(list.body.rules[0].state, "PAUSED");
  // paused rules never plan
  balances.set(stella.address.toLowerCase(), $(100));
  assert.deepEqual((await trigger(paid("0xt:0", $(10)))).body.results, []);
  // resume for the next tests
  now += 10;
  assert.equal((await post("/v1/automate/rules", await signed({ ...r, enabled: true, updatedAt: BigInt(now) }))).body.rule.state, "WAITING_TRIGGER");
});

test("triggers: internal key required; a duplicate event plans nothing new; proven legs complete, an unavailable leg makes it PARTIAL", async () => {
  assert.equal((await trigger(paid("0xt:1", $(40)), "wrong".padEnd(40, "x"))).status, 401);
  assert.equal((await post("/v1/automate/triggers", { event: paid("0xt:1", $(40)) })).status, 401);

  unavailable.add("aNVDA");
  balances.set(stella.address.toLowerCase(), $(140));
  const t1 = await trigger(paid("0xt:1", $(40)));
  const res = t1.body.results[0];
  assert.equal(res.planned, true);
  const dup = await trigger(paid("0xt:1", $(40)));
  assert.equal(dup.body.results[0].planned, false);
  assert.equal(dup.body.results[0].reason, "DUPLICATE_EVENT");

  const e = (await get(`/v1/automate/executions/${res.executionId}`)).body.execution;
  assert.equal(e.state, "READY");
  assert.deepEqual(e.legs.map((l: any) => [l.status, l.amount, l.leftInBalance]), [["KEPT", "0", String($(20))], ["PENDING", String($(12)), "0"], ["UNAVAILABLE", "0", String($(8))]]);

  // the stock leg is not runnable; reporting it is refused
  assert.equal((await report(res.executionId, 2, LegOutcome.DONE, `0x${"aa".repeat(32)}`)).status, 409);
  // Eve can't report Stella's legs
  assert.deepEqual((await report(res.executionId, 1, LegOutcome.DONE, `0x${"aa".repeat(32)}`, eve)).body, { error: "INVALID_SIGNATURE" });
  // a transaction that doesn't prove the deposit is refused; one that isn't final yet is "come back later"
  assert.equal((await report(res.executionId, 1, LegOutcome.DONE, `0x${"bb".repeat(32)}`)).body.error, "TX_DOES_NOT_MATCH_LEG");
  proofs.set(`0x${"cc".repeat(32)}`, "NOT_FINAL");
  assert.equal((await report(res.executionId, 1, LegOutcome.DONE, `0x${"cc".repeat(32)}`)).status, 202);
  proofs.set(`0x${"cc".repeat(32)}`, "OK");
  const done = await report(res.executionId, 1, LegOutcome.DONE, `0x${"cc".repeat(32)}`);
  assert.equal(done.body.execution.state, "PARTIALLY_COMPLETED"); // $8 stayed: the investment route was unavailable
  assert.equal(done.body.execution.legs[1].status, "DONE");
  assert.equal(done.body.execution.keptInBalance, String($(28)));
  // a closed execution takes no more reports
  assert.equal((await report(res.executionId, 1, LegOutcome.DONE, `0x${"cc".repeat(32)}`)).status, 409);
});

test("limits hold across executions (daily cap), one tx can't complete two legs, unconfirmed runs lapse and free the limit", async () => {
  unavailable.clear();
  balances.set(stella.address.toLowerCase(), $(500));
  // used today so far: $12 (previous test). Day cap $60 → $48 left; this wants $50 (per-execution cap) → limited to $48
  const t = await trigger(paid("0xt:2", $(200)));
  const e = (await get(`/v1/automate/executions/${t.body.results[0].executionId}`)).body.execution;
  assert.equal(e.moving, String($(48)));
  assert.deepEqual(e.legs.slice(1).map((l: any) => l.status), ["LIMITED", "LIMITED"]);
  // now the day is used up: the next payment plans nothing
  assert.equal((await trigger(paid("0xt:3", $(10)))).body.results[0].reason, "LIMIT_REACHED");

  // the same tx hash can't prove a second leg
  proofs.set(`0x${"cc".repeat(32)}`, "OK");
  assert.equal((await report(e.executionId, 1, LegOutcome.DONE, `0x${"cc".repeat(32)}`)).body.error, "TX_ALREADY_USED");

  // Stella never confirms: after the window the execution lapses, nothing moved, the day's limit is free again
  now += 3601;
  const lapsed = (await get(`/v1/automate/executions/${e.executionId}`)).body.execution;
  assert.equal(lapsed.state, "FAILED");
  assert.deepEqual(lapsed.legs.slice(1).map((l: any) => [l.status, l.reason]), [["FAILED", "NOT_CONFIRMED"], ["FAILED", "NOT_CONFIRMED"]]);
  const again = await trigger(paid("0xt:4", $(20)));
  assert.equal(again.body.results[0].planned, true);
});

test("two rules can't spend the same money: open executions reserve what they will move", async () => {
  const owner = privateKeyToAccount(`0x${"77".repeat(32)}`);
  balances.set(owner.address.toLowerCase(), $(150));
  const keepRule = (name: string): RuleSpec => ({ ...split, name, trigger: { kind: "BALANCE_ABOVE", keep: $(100) }, actions: [{ kind: "DEPOSIT_YIELD", bps: 10_000, opportunityId: "test-vault" }] });
  for (const name of ["A", "B"]) {
    const r = makeRule(keepRule(name), { owner: owner.address });
    assert.equal((await post("/v1/automate/rules", { rule: ruleToJson(r), signature: await owner.signTypedData(automationRuleTyped(DOMAIN, r, CHAIN)) })).status, 200);
  }
  const t = await trigger({ kind: "BALANCE_CHECK", id: "bal:1", owner: owner.address, at: String(now) });
  const planned = t.body.results.filter((x: any) => x.planned);
  assert.equal(planned.length, 1); // the second rule saw the $50 excess already committed
  assert.equal(t.body.results.find((x: any) => !x.planned).reason, "NOTHING_ABOVE_KEEP");
  const execs = (await get(`/v1/automate/executions/by-owner/${owner.address}`)).body.executions;
  assert.equal(execs.length, 1);
  assert.equal(execs[0].moving, String($(50)));
});

test("bad input is refused without side effects", async () => {
  assert.equal((await trigger({ kind: "PAYMENT_RECEIVED", id: "x", recipient: stella.address, amount: "-1", at: "1", origin: "EXTERNAL" })).body.error, "INVALID_EVENT");
  assert.equal((await trigger({ kind: "PAYMENT_RECEIVED", id: "x", recipient: stella.address, amount: "1.5", at: "1", origin: "EXTERNAL" })).body.error, "INVALID_EVENT");
  assert.equal((await post("/v1/automate/rules", { rule: { nope: 1 }, signature: "0x" })).body.error, "INVALID_RULE");
  assert.equal((await get("/v1/automate/rules/0x123")).status, 404);
});
