import { hexToSignature, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import {
  automationRuleTyped,
  grantIdOf,
  grantProblem,
  revokeTyped,
  settlementAsset,
  type Grant,
  type EarnOpportunity,
  legReportTyped,
  ruleToJson,
  AUTOMATE_VERSION,
  LegOutcome,
  type Action,
  type AutomationRule,
  type RuleSpec,
  type TargetStatus,
} from "@everpiece/shared";
import { config, flags } from "./config";
import { chainTime, client } from "./chain";
import { relayer, waitForRequest, type RelayStatus } from "./api";
import { randomBytes32 } from "./link";
import { withSigner, type Account } from "./mera";
import { PayError } from "./pay";
import { deposit, earnAvailable, opportunities, opportunity } from "./earn";

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

/** Copilot (optional): turns a sentence into a PROPOSED rule. It never creates or signs anything; the owner reviews it. */
export async function copilotAvailable(): Promise<boolean> {
  if (!automateAvailable()) return false;
  const r = await call("/v1/automate/copilot").catch(() => null);
  return r?.status === 200 && r.body?.available === true;
}
export async function askCopilot(text: string): Promise<{ proposal: unknown } | { refusal: string }> {
  const r = await call("/v1/automate/copilot/propose", { text }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status === 429) throw new PayError("COPILOT_BUSY");
  if (r.status !== 200) throw new PayError("COPILOT_UNAVAILABLE");
  return r.body;
}

/** Where each action can run right now, for the preview (the service re-checks at run time). */
export function targetStatus(a: Exclude<Action, { kind: "KEEP_BALANCE" }>): { status: TargetStatus; reason: string } {
  if (a.kind === "DEPOSIT_YIELD") {
    const o = opportunities().find((x) => x.id === a.opportunityId);
    return earnAvailable() && o ? { status: "AVAILABLE", reason: o.simulated ? "Test vault (simulated yield)" : o.name } : { status: "UNAVAILABLE", reason: "Earn isn't available here" };
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

// ── Runs within limits without asking (BOUNDED_MODULE: EverpieceAutomate grant) ─────────────────────────────────────

/** Available when the module is deployed and switched on: otherwise every run is confirmed with a fingerprint. */
export const boundedAvailable = () => Boolean(config.automate && config.automateExecutor) && flags.AUTOMATE_ENABLED;

const permitAbi = parseAbi(["function nonces(address owner) view returns (uint256)"]);

/**
 * Authorize a BOUNDED_MODULE rule: ONE passkey prompt signs (1) the on-chain grant — only Everpiece's executor, only
 * into this Earn vault in your name, at most the rule's per-run and per-day caps and its monthly cap in total, until
 * the rule expires — and (2) a permit for exactly that total. The relayer activates it (no gas for you), then the
 * Automate service links it after checking it on-chain. Revoke any time with `revokeRule`.
 */
export async function authorizeRule(account: Account, rule: AutomationRule, o: EarnOpportunity, onStatus: (s: RelayStatus | "SIGNING") => void): Promise<Hex> {
  if (!boundedAvailable()) throw new PayError("AUTHORIZATION_NOT_AVAILABLE");
  const asset = settlementAsset(config.chainId, o.asset);
  if (!asset) throw new PayError("UNSUPPORTED_ASSET");
  const grant: Grant = {
    ruleId: rule.id, owner: account.address, executor: config.automateExecutor, vault: o.vault,
    maxPerExecution: rule.limits.maxPerExecution, maxPerDay: rule.limits.maxPerDay, total: rule.limits.maxPerMonth, expiresAt: rule.limits.expiresAt,
  };
  const now = await chainTime();
  const problem = grantProblem(grant, now);
  if (problem) throw new PayError(problem);
  const grantId = grantIdOf(config.automate, config.chainId, grant);
  const nonce = await client.readContract({ address: asset.address, abi: permitAbi, functionName: "nonces", args: [account.address] });
  const deadline = now + 3600n;
  onStatus("SIGNING");
  const { ownerSignature, permitSig } = await withSigner(account, async (signer) => ({
    // raw signature over the EIP-712 grant digest (the contract recovers it with ECDSA over grantIdOf)
    ownerSignature: await (signer.sign ?? (() => { throw new PayError("SIGNER_UNSUPPORTED"); }))({ hash: grantId }),
    permitSig: await signer.signTypedData({
      domain: { name: asset.eip712.name, version: asset.eip712.version, chainId: config.chainId, verifyingContract: asset.address },
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
      message: { owner: account.address, spender: config.automate, value: grant.total, nonce, deadline },
    }),
  }));
  const { r: pr, s: ps, v } = hexToSignature(permitSig);
  const r = await relayer("/v1/automate/grants/activate", { grant, ownerSignature, permit: { deadline, v: Number(v), r: pr, s: ps } });
  if (r.status !== 202 && r.status !== 200) throw new PayError(r.body.error ?? "TRANSACTION_REVERTED");
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new PayError(done.error ?? "TRANSACTION_REVERTED");
  // the service checks the grant on-chain at finality; retry briefly while it catches up
  for (let i = 0; i < 10; i++) {
    const l = await call("/v1/automate/grants", { ruleId: rule.id, grant });
    if (l.status === 200) return grantId;
    if (l.body.error !== "GRANT_NOT_ACTIVE") throw new PayError(l.body.error ?? "PROVIDER_UNAVAILABLE");
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new PayError("GRANT_NOT_ACTIVE");
}

/** Stop a bounded rule's on-chain permission at once (gasless; the owner's signature). */
export async function revokeRule(account: Account, grantId: Hex, onStatus: (s: RelayStatus | "SIGNING") => void): Promise<void> {
  onStatus("SIGNING");
  const ownerSignature = await withSigner(account, (signer) => signer.signTypedData(revokeTyped(config.automate, config.chainId, grantId)));
  const r = await relayer("/v1/automate/grants/revoke", { grantId, ownerSignature });
  if (r.status !== 202 && r.status !== 200) throw new PayError(r.body.error ?? "TRANSACTION_REVERTED");
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new PayError(done.error ?? "TRANSACTION_REVERTED");
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
    const o = opportunities().find((x) => leg.action.kind === "DEPOSIT_YIELD" && x.id === leg.action.opportunityId) ?? opportunity();
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
