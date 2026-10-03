// Offline: the policy engine (owner mandate §23/§36) and the strict EverpiecePay / quote request parsers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import { AUSD_TESTNET_ADDRESS, CTK_TESTNET_ADDRESS, MONAD_TESTNET_CHAIN_ID } from "@everpiece/shared";
import { LocalRulesPolicy, decide, type ComplianceProvider, type PolicyContext } from "../src/policy.ts";
import { ValidationError, parsePayAusd, parsePayToken, parseQuote } from "../src/validate.ts";

const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const BAD = getAddress("0x00000000000000000000000000000000000000ff");
const policy = new LocalRulesPolicy({ maxPerPayment: 500_000_000n, maxPerSenderPerDay: 1_000_000_000n, reviewAbove: 300_000_000n, denylist: new Set([BAD]) });
const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  chainId: MONAD_TESTNET_CHAIN_ID, sender: A, recipient: B, amount: 25_000_000n, sourceToken: AUSD_TESTNET_ADDRESS,
  route: "DIRECT_AUSD", mode: "INSTANT", sentToday: 0n, agoraWhitelisted: null, kyc: "NOT_REQUIRED", ...over,
});
const verdict = async (over: Partial<PolicyContext>) => policy.evaluate(ctx(over));

test("ALLOW a normal payment; the result names the rule set and says it's test logic", async () => {
  const r = await verdict({});
  assert.equal(r.decision, "ALLOW");
  assert.deepEqual(r.reasons, []);
  assert.match(r.ruleVersion, /^local-rules\//);
  assert.match(r.provider, /TEST: no sanctions or identity screening/);
});

test("DENY: denylisted sender or recipient, unsupported token or network, zero, above limit, velocity", async () => {
  assert.deepEqual((await verdict({ sender: BAD })).reasons, ["SENDER_DENYLISTED"]);
  assert.deepEqual((await verdict({ recipient: BAD })).reasons, ["RECIPIENT_DENYLISTED"]);
  assert.deepEqual((await verdict({ sourceToken: getAddress("0x0000000000000000000000000000000000000001") })).reasons, ["UNSUPPORTED_TOKEN"]);
  assert.ok((await verdict({ chainId: 1 })).reasons.includes("UNSUPPORTED_NETWORK"));
  assert.ok((await verdict({ amount: 0n })).reasons.includes("ZERO_AMOUNT"));
  assert.ok((await verdict({ amount: 500_000_001n })).reasons.includes("ABOVE_PAYMENT_LIMIT"));
  assert.deepEqual((await verdict({ sentToday: 990_000_000n })).reasons, ["DAILY_LIMIT"]);
  for (const k of ["REQUIRED", "PENDING", "REJECTED"] as const) assert.deepEqual((await verdict({ kyc: k })).reasons, [`KYC_${k}`]);
  for (const over of [{ sender: BAD }, { amount: 0n }, { sentToday: 990_000_000n }]) assert.equal((await verdict(over)).decision, "DENY");
});

test("Agora route needs the settlement contract whitelisted (APPROVED_SWAPPER), else DENY", async () => {
  const agora = { route: "AGORA_INSTANT_SETTLEMENT" as const, sourceToken: CTK_TESTNET_ADDRESS };
  assert.equal((await verdict({ ...agora, agoraWhitelisted: true })).decision, "ALLOW");
  assert.deepEqual((await verdict({ ...agora, agoraWhitelisted: false })).reasons, ["AGORA_NOT_WHITELISTED"]);
  assert.deepEqual((await verdict({ ...agora, agoraWhitelisted: null })).reasons, ["AGORA_NOT_WHITELISTED"]); // unknown = not allowed
});

test("REVIEW above the review threshold (not executed automatically); DENY wins over REVIEW", async () => {
  const r = await verdict({ amount: 400_000_000n });
  assert.equal(r.decision, "REVIEW");
  assert.deepEqual(r.reasons, ["ABOVE_REVIEW_THRESHOLD"]);
  assert.equal((await verdict({ amount: 400_000_000n, sender: BAD })).decision, "DENY");
});

test("fail closed: a provider that throws means DENY POLICY_UNAVAILABLE", async () => {
  const broken: ComplianceProvider = { id: "broken", evaluate: async () => { throw new Error("down"); } };
  assert.deepEqual(await decide(broken, ctx()), { decision: "DENY", reasons: ["POLICY_UNAVAILABLE"], ruleVersion: "n/a", provider: "broken" });
});

test("pay request parsers: exact field sets, canonical decimals, 65-byte signatures", () => {
  const payment = { ref: `0x${"11".repeat(32)}`, sender: A, recipient: B, amount: "25000000", sourceToken: AUSD_TESTNET_ADDRESS, maxSourceAmount: "25000000", deadline: "1790700600" };
  const sig = `0x${"22".repeat(65)}`;
  assert.equal(parsePayAusd({ payment, ausdSignature: sig }).payment.amount, 25_000_000n);
  for (const bad of [{ payment, ausdSignature: sig, extra: 1 }, { payment: { ...payment, amount: 25 }, ausdSignature: sig }, { payment: { ...payment, amount: "0x10" }, ausdSignature: sig },
    { payment: { ...payment, recipient: "0x1" }, ausdSignature: sig }, { payment, ausdSignature: "0x1234" }]) {
    assert.throws(() => parsePayAusd(bad), ValidationError);
  }
  const permit = { deadline: "1790700600", v: 27, r: `0x${"33".repeat(32)}`, s: `0x${"44".repeat(32)}` };
  assert.equal(parsePayToken({ payment, payerSignature: sig, permit }).permit.v, 27);
  assert.throws(() => parsePayToken({ payment, payerSignature: sig, permit: { ...permit, v: 1 } }), ValidationError);
  assert.throws(() => parseQuote({ sellToken: CTK_TESTNET_ADDRESS, buyAmount: "1.5", recipient: B, sender: A }), ValidationError);
  assert.equal(parseQuote({ sellToken: CTK_TESTNET_ADDRESS, buyAmount: "1500000", recipient: B, sender: A as Address }).buyAmount, 1_500_000n);
});
