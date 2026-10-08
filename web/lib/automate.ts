import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  automationRuleTyped,
  legReportTyped,
  ruleToJson,
  AUTOMATE_VERSION,
  LegOutcome,
  type Action,
  type AutomationRule,
  type RuleSpec,
  type TargetStatus,
} from "@everpiece/shared";
import { config } from "./config";
import { chainTime } from "./chain";
import { type RelayStatus } from "./api";
import { randomBytes32 } from "./link";
import { withSigner, type Account } from "./mera";
import { PayError } from "./pay";
import { deposit, earnAvailable, opportunity } from "./earn";

/**
 * Automate (docs/AUTOMATE.md): rules the owner signs; the service plans runs within their limits; each run is
 * confirmed here with one fingerprint (CONFIRM_EACH: Mera has no scoped keys), executed leg by leg, and every leg is
 * reported signed and proven on-chain by the service. Nothing moves without the owner.
 */
export const automateAvailable = () => config.automateUrl !== "";

async function call(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${config.automateUrl}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Where each action can run right now, for the preview (the service re-checks at run time). */
export function targetStatus(a: Exclude<Action, { kind: "KEEP_BALANCE" }>): { status: TargetStatus; reason: string } {
  if (a.kind === "DEPOSIT_YIELD") {
    const o = opportunity();
    return earnAvailable() && o && o.id === a.opportunityId ? { status: "AVAILABLE", reason: o.simulated ? "Test vault (simulated yield)" : o.name } : { status: "UNAVAILABLE", reason: "Earn isn't available here" };
  }
  return { status: "UNAVAILABLE", reason: "No stock route meets Everpiece's price-quality rules yet" };
}

export type RuleView = { rule: Record<string, any>; state: string; targets: { action: Action; status: TargetStatus; reason?: string }[]; lastExecution: ExecutionView | null };
export type ExecutionView = {
  executionId: Hex; ruleId: Hex; eventId: string; state: string; base: string; moving: string; keptInBalance: string; source: string;
  createdAt: number; expiresAt: number; history: { state: string; at: number }[];
  legs: { index: number; action: Action; allocated: string; amount: string; leftInBalance: string; status: string; reason: string | null; txHash: string | null; idempotencyKey: string }[];
};

export async function listRules(owner: Address): Promise<RuleView[]> {
  const r = await call(`/v1/automate/rules/${owner}`);
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  return r.body.rules;
}
export async function listExecutions(owner: Address): Promise<ExecutionView[]> {
  const r = await call(`/v1/automate/executions/by-owner/${owner}`);
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  return r.body.executions;
}

async function put(account: Account, rule: AutomationRule) {
  const signature = await withSigner(account, (signer) => signer.signTypedData(automationRuleTyped(config.directoryDomain, rule, config.chainId)));
  const r = await call("/v1/automate/rules", { rule: ruleToJson(rule), signature });
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  return r.body.rule as RuleView;
}

/** Create a rule: the owner signs every field (limits as their own fields, the rest through the spec hash). */
export async function createRule(account: Account, spec: RuleSpec): Promise<RuleView> {
  const now = await chainTime();
  return put(account, { ...spec, version: AUTOMATE_VERSION, id: randomBytes32(), owner: account.address, enabled: true, createdAt: now, updatedAt: now });
}

/** Pause or resume = a newer signed version of the same rule (older versions can't be replayed). */
export async function setEnabled(account: Account, rule: AutomationRule, enabled: boolean): Promise<RuleView> {
  const now = await chainTime();
  return put(account, { ...rule, enabled, updatedAt: now > rule.updatedAt ? now : rule.updatedAt + 1n });
}

async function report(account: Account, executionId: Hex, legIndex: number, outcome: 1 | 2, txHash: Hex) {
  const rep = { executionId, legIndex, outcome, txHash };
  const signature = await withSigner(account, (signer) => signer.signTypedData(legReportTyped(config.directoryDomain, rep, config.chainId)));
  for (let i = 0; i < 10; i++) {
    const r = await call("/v1/automate/legs", { report: rep, signature });
    if (r.status === 200) return r.body.execution as ExecutionView;
    if (r.status !== 202) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
    await new Promise((res) => setTimeout(res, 2_000)); // not final yet
  }
  throw new PayError("NOT_FINAL");
}

/**
 * Run a READY execution: each leg that still has money to move, in order. A leg that fails is reported FAILED and its
 * money stays in the balance; the next legs still run. Returns the final view (COMPLETED / PARTIALLY_COMPLETED / …).
 */
export async function runExecution(account: Account, e: ExecutionView, onStatus: (s: RelayStatus | "SIGNING", leg: number) => void): Promise<ExecutionView> {
  let view = e;
  for (const leg of e.legs) {
    if (!(BigInt(leg.amount) > 0n && (leg.status === "PENDING" || leg.status === "LIMITED"))) continue;
    if (leg.action.kind !== "DEPOSIT_YIELD") continue; // no other provider is executable yet; the service shows them as unavailable
    const o = opportunity();
    if (!o) continue;
    try {
      // the leg's idempotency key becomes the on-chain ref, so the same leg can never be deposited twice
      const ref = keccak256(toHex(leg.idempotencyKey));
      const r = await deposit(account, o, BigInt(leg.amount), (s) => onStatus(s, leg.index), ref);
      view = await report(account, e.executionId, leg.index, LegOutcome.DONE, r.txHash ?? (`0x${"0".repeat(64)}` as Hex));
    } catch (err) {
      if (err instanceof PayError && (err.code === "AlreadySettled" || err.code === "DuplicateRequest")) throw err;
      view = await report(account, e.executionId, leg.index, LegOutcome.FAILED, keccak256(toHex(`${leg.idempotencyKey}:failed:${randomBytes32()}`)));
    }
  }
  return view;
}
