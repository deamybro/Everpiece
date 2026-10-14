import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopilotProposal, proposalToRuleSpec, COPILOT_MAX_INPUT_CHARS, type CopilotContext } from "../src/index.ts";

const ctx: CopilotContext = { nowSec: 1_800_000_000n, earnOpportunityId: "aave-v3-usdc", stocksAvailable: false };
const j = (o: unknown) => JSON.stringify(o);

test("a clear request becomes a CONFIRM_EACH draft with exact amounts and stated assumptions", () => {
  const r = parseCopilotProposal(j({ understood: true, name: "Save half", trigger: { type: "payment_received", min_dollars: 10 }, split: [{ to: "keep", percent: 50 }, { to: "earn", percent: 50 }], limits: {} }));
  assert.ok(r.ok);
  const s = proposalToRuleSpec((r as any).proposal, ctx);
  assert.ok(s.ok);
  assert.equal((s as any).spec.authorization, "CONFIRM_EACH");
  assert.deepEqual((s as any).spec.trigger, { kind: "PAYMENT_RECEIVED", minAmount: 10_000_000n });
  assert.deepEqual((s as any).spec.actions, [{ kind: "KEEP_BALANCE", bps: 5000 }, { kind: "DEPOSIT_YIELD", bps: 5000, opportunityId: "aave-v3-usdc" }]);
  assert.equal((s as any).spec.limits.maxPerExecution, 50_000_000n);
  assert.equal((s as any).assumed.length, 4); // the owner is told every default that was assumed
});

test("code fences and chatter around the JSON are tolerated; the shape is not", () => {
  const body = j({ understood: true, name: "x", trigger: { type: "balance_above", keep_dollars: 100 }, split: [{ to: "earn", percent: 100 }] });
  assert.ok(parseCopilotProposal("Sure!\n```json\n" + body + "\n```").ok);
  assert.equal(parseCopilotProposal("no json at all").ok, false);
  assert.equal(parseCopilotProposal("{not json}").ok, false);
});

test("refusals and unsupported things are plain sentences, not rules", () => {
  assert.equal(parseCopilotProposal(j({ understood: false, reason: "That is not about money rules." })).ok, false);
  assert.equal(parseCopilotProposal(j({ understood: true, name: "x", trigger: { type: "send_to_friend" }, split: [{ to: "earn", percent: 100 }] })).ok, false);
  assert.equal(parseCopilotProposal(j({ understood: true, name: "x", trigger: { type: "payment_received" }, split: [{ to: "wire_everything_to_0xabc", percent: 100 }] })).ok, false);
});

test("percentages must add to 100, stocks are refused while parked, nothing-moves is refused", () => {
  const mk = (split: unknown) => parseCopilotProposal(j({ understood: true, name: "x", trigger: { type: "payment_received", min_dollars: 0 }, split }));
  const a = mk([{ to: "keep", percent: 60 }, { to: "earn", percent: 30 }]);
  assert.ok(a.ok);
  assert.equal(proposalToRuleSpec((a as any).proposal, ctx).ok, false);
  const b = mk([{ to: "stocks", percent: 100 }]);
  assert.equal(proposalToRuleSpec((b as any).proposal, ctx).ok, false);
  assert.equal(proposalToRuleSpec((b as any).proposal, { ...ctx, stocksAvailable: true }).ok, true);
  const c = mk([{ to: "keep", percent: 100 }]);
  assert.equal(proposalToRuleSpec((c as any).proposal, ctx).ok, false); // NOTHING_MOVES
});

test("no Earn available means no Earn rule; absurd numbers are refused", () => {
  const p = parseCopilotProposal(j({ understood: true, name: "x", trigger: { type: "payment_received" }, split: [{ to: "earn", percent: 100 }] }));
  assert.equal(proposalToRuleSpec((p as any).proposal, { ...ctx, earnOpportunityId: undefined }).ok, false);
  assert.equal(parseCopilotProposal(j({ understood: true, name: "x", trigger: { type: "balance_above", keep_dollars: 1e12 }, split: [{ to: "earn", percent: 100 }] })).ok, false);
  assert.equal(parseCopilotProposal(j({ understood: true, name: "x", trigger: { type: "payment_received" }, split: [{ to: "earn", percent: -5 }] })).ok, false);
});

test("a name cannot carry markup or control characters, and inconsistent limits are refused", () => {
  const p = parseCopilotProposal(j({ understood: true, name: "<script>x</script>\u0007Save", trigger: { type: "payment_received" }, split: [{ to: "earn", percent: 100 }], limits: { per_run_dollars: 500, per_day_dollars: 100, per_month_dollars: 1000 } }));
  assert.ok(p.ok);
  assert.ok(!/[<>\u0007]/.test((p as any).proposal.name));
  assert.equal(proposalToRuleSpec((p as any).proposal, ctx).ok, false);
  assert.ok(COPILOT_MAX_INPUT_CHARS <= 300);
});
