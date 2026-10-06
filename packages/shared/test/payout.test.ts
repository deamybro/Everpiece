import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  bankAccountHash, formatNaira, nextPayoutState, parseNaira, payoutAccountHashOf, payoutAccountProblem, payoutAccountTyped,
  payoutRequestProblem, payoutRequestTyped, payoutStateOf, stableNeededFor, PAYOUT_REQUEST_LINK, type PayoutAccount, type PayoutRequest,
} from "../src/index.ts";

const DOMAIN = "0x6305d15C7718ec139255024E071F55061793eA08";
const maris = privateKeyToAccount(`0x${"42".repeat(32)}`);

test("naira: parse and format, kobo exact", () => {
  assert.equal(parseNaira("50000"), 5_000_000n);
  assert.equal(parseNaira("₦50,000.5"), 5_000_050n);
  for (const bad of ["", "0", "-5", "1.234", "1e5", "abc", "50 000"]) assert.equal(parseNaira(bad), null, bad);
  assert.equal(formatNaira(5_000_000n), "₦50,000");
  assert.equal(formatNaira(5_000_050n), "₦50,000.50");
});

test("at least ₦X: stablecoin needed always rounds UP, plus the buffer", () => {
  // ₦50,000 at ₦1,500/unit = 33.333333… → 33.333334 (6 dp), never 33.333333
  assert.equal(stableNeededFor(5_000_000n, "1500", 0), 33_333_334n);
  // + 0.5% buffer, also rounded up
  assert.equal(stableNeededFor(5_000_000n, "1500", 50), 33_333_334n + 166_667n);
  // decimal rates as the provider returns them
  assert.equal(stableNeededFor(5_000_000n, "1532.25", 0), 32_631_751n); // 50000 / 1532.25 = 32.6317507… → up
  // whatever the rate, the bank gets at least the amount: units × rate ≥ naira
  for (const rate of ["1", "1499.99", "1532.25", "1600.123456"]) {
    const units = stableNeededFor(5_000_000n, rate, 0);
    const [i, f = ""] = rate.split(".");
    const scale = 10n ** BigInt(f.length);
    const r = BigInt(i) * scale + BigInt(f || "0");
    assert.ok(units * r * 100n >= 5_000_000n * scale * 1_000_000n, rate);
  }
  assert.throws(() => stableNeededFor(1n, "0", 0));
  assert.throws(() => stableNeededFor(1n, "abc", 0));
});

test("provider states: mapped, unknown refused, only forward, finals stick", () => {
  assert.equal(payoutStateOf("initiated"), "AWAITING_PAYMENT");
  assert.equal(payoutStateOf("payment_order.deposited"), "PAYOUT_FUNDED");
  assert.equal(payoutStateOf("pending"), "BANK_PROCESSING");
  assert.equal(payoutStateOf("payment_order.validated"), "DELIVERED");
  assert.equal(payoutStateOf("settled"), "DELIVERED");
  assert.equal(payoutStateOf("payment_order.refunding"), "REFUNDING");
  assert.equal(payoutStateOf("refunded"), "REFUNDED");
  assert.equal(payoutStateOf("expired"), "EXPIRED");
  assert.equal(payoutStateOf("payment_order.compliance_hold"), null);
  assert.equal(payoutStateOf("done"), null);
  assert.equal(nextPayoutState("BANK_PROCESSING", "AWAITING_PAYMENT"), "BANK_PROCESSING"); // late event ignored
  assert.equal(nextPayoutState("DELIVERED", "REFUNDING"), "DELIVERED");
  assert.equal(nextPayoutState("REFUNDING", "DELIVERED"), "REFUNDING");
  assert.equal(nextPayoutState("REFUNDING", "REFUNDED"), "REFUNDED");
  assert.equal(nextPayoutState("EXPIRED", "PAYOUT_FUNDED"), "EXPIRED");
});

test("signed destination: only the account owner's signature, and requests bind that exact destination", async () => {
  const salt = `0x${"ab".repeat(32)}` as Hex;
  const a: PayoutAccount = {
    account: maris.address, currency: "NGN", institution: "GTBINGLA", accountHash: bankAccountHash(salt, "GTBINGLA", "0123456789"),
    accountName: "MARIS OKAFOR", last4: "6789", deadline: 2_000_000_000n,
  };
  assert.equal(payoutAccountProblem(a, 1_800_000_000n), null);
  assert.notEqual(bankAccountHash(salt, "GTBINGLA", "0123456789"), bankAccountHash(`0x${"cd".repeat(32)}`, "GTBINGLA", "0123456789"));
  const sig = await maris.signTypedData(payoutAccountTyped(DOMAIN, a, 10143));
  assert.equal(await recoverTypedDataAddress({ ...payoutAccountTyped(DOMAIN, a, 10143), signature: sig }), maris.address);
  // a swapped account name or hash recovers someone else
  assert.notEqual(await recoverTypedDataAddress({ ...payoutAccountTyped(DOMAIN, { ...a, accountName: "EVE" }, 10143), signature: sig }), maris.address);
  const r: PayoutRequest = {
    version: 1, requestId: `0x${"11".repeat(32)}`, recipient: maris.address, currency: "NGN", fiatAmount: 5_000_000n,
    payoutAccountHash: payoutAccountHashOf(DOMAIN, a, 10143), expiresAt: 2_000_000_000n,
  };
  assert.equal(payoutRequestProblem(r, 1_800_000_000n), null);
  assert.notEqual(payoutAccountHashOf(DOMAIN, { ...a, last4: "0000" }, 10143), r.payoutAccountHash);
  const rs = await maris.signTypedData(payoutRequestTyped(DOMAIN, r, 10143));
  assert.equal(await recoverTypedDataAddress({ ...payoutRequestTyped(DOMAIN, r, 10143), signature: rs }), maris.address);
  assert.equal(payoutRequestProblem({ ...r, fiatAmount: 9_999n }, 1_800_000_000n), "INVALID_AMOUNT");
  assert.equal(payoutRequestProblem({ ...r, expiresAt: 1n }, 1_800_000_000n), "REQUEST_EXPIRED");
  assert.equal(payoutAccountProblem({ ...a, institution: "x" }, 1n), "INVALID_INSTITUTION");
  assert.ok(PAYOUT_REQUEST_LINK.test(`/payout/0x${"ab".repeat(32)}`));
});
