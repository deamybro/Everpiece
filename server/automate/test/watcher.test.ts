// The trigger watcher against a fake Envio GraphQL endpoint: an instant payment and a claimed protected payment to an
// owner with a rule each plan once; re-polling the same facts plans nothing new; strangers' payments are ignored.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { automationRuleTyped, ruleToJson, type AutomationRule } from "@everpiece/shared";
import { AutomateService } from "../src/service.ts";
import { loadConfig } from "../src/config.ts";
import { startWatcher } from "../src/watcher.ts";
import { setLogSink } from "../src/log.ts";

const DOMAIN = "0x6305d15C7718ec139255024E071F55061793eA08";
const NOW = 1_791_331_200;
const owner = privateKeyToAccount(`0x${"42".repeat(32)}`);
const DB = join(tmpdir(), `automate-watch-${process.pid}.sqlite`);
let indexer: Server;
const queries: Record<string, unknown>[] = [];
after(() => {
  indexer?.close();
  rmSync(DB, { force: true });
});

test("watcher: payments to rule owners plan once, re-polls are idempotent, others are ignored", async () => {
  setLogSink(() => {}, "alert");
  rmSync(DB, { force: true });
  indexer = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    queries.push(JSON.parse(body).variables);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: {
      instant: [{ id: `0x${"a1".repeat(32)}`, recipient: owner.address, amount: "10000000", timestamp: NOW + 5 }],
      claimed: [{ id: `0x${"b2".repeat(32)}`, recipient: owner.address, amount: "4000000", settledAt: NOW + 6 }],
    } }));
  });
  await new Promise<void>((r) => indexer.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(indexer.address() as AddressInfo).port}/v1/graphql`;

  const cfg = loadConfig({ DIRECTORY_DOMAIN_ADDRESS: DOMAIN, AUTOMATE_INTERNAL_KEY: "k".repeat(40), AUTOMATE_DB: DB, EXPECTED_CHAIN_ID: "10143" });
  const svc = new AutomateService(cfg, { balance: async () => 50_000_000n, reserved: async () => 0n, harvestable: async () => 0n }, { availability: () => ({ status: "AVAILABLE" }) }, { verify: async () => "MISMATCH" }, () => NOW + 10);
  const rule: AutomationRule = {
    version: 1, id: `0x${"01".padStart(64, "0")}` as Hex, owner: owner.address, enabled: true, createdAt: BigInt(NOW), updatedAt: BigInt(NOW),
    name: "Split", trigger: { kind: "PAYMENT_RECEIVED", minAmount: 0n },
    actions: [{ kind: "KEEP_BALANCE", bps: 7000 }, { kind: "DEPOSIT_YIELD", bps: 3000, opportunityId: "test-vault" }],
    limits: { maxPerExecution: 100_000_000n, maxPerDay: 100_000_000n, maxPerMonth: 500_000_000n, expiresAt: BigInt(NOW + 86_400) }, authorization: "CONFIRM_EACH",
  };
  assert.equal((await svc.putRule({ rule: ruleToJson(rule), signature: await owner.signTypedData(automationRuleTyped(DOMAIN, rule, 10143)) })).httpStatus, 200);

  let t = NOW;
  const stop = startWatcher(svc, { indexerUrl: url, pollMs: 50, checkEverySec: 600, now: () => t });
  await new Promise((r) => setTimeout(r, 400)); // several polls of the same facts
  stop();
  const execs = (svc.executions(owner.address).body as { executions: { eventId: string; moving: string; legs: { amount: string }[] }[] }).executions;
  assert.deepEqual(execs.map((e) => e.eventId).sort(), [`claimed:0x${"b2".repeat(32)}`, `paid:0x${"a1".repeat(32)}`]);
  assert.deepEqual(execs.find((e) => e.eventId.startsWith("paid"))!.legs.map((l) => l.amount), ["0", "3000000"]); // 30% of $10
  // the watcher only asked about owners with enabled rules, checksummed like the indexer stores them
  assert.deepEqual(queries[0], { owners: [owner.address], since: NOW });
  svc.store.close();
});
