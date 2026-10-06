// The payout server end to end against the SIMULATED Paycrest (scripts/paycrest-sim.mjs, Paycrest's API shapes):
// signed bank destination, signed ₦ request, live quote, order, deposit → bank → DELIVERED; refunds; security.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { payoutAccountHashOf, payoutAccountTyped, payoutRequestTyped, stableNeededFor, type PayoutAccount, type PayoutRequest } from "@everpiece/shared";
import { PayoutService } from "../src/service.ts";
import { createPayoutServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";

const DOMAIN = "0x6305d15C7718ec139255024E071F55061793eA08";
const CHAIN = 10143;
const KEY = "sim-api-key-123";
const SECRET = "sim-api-secret-456";
const maris = privateKeyToAccount(`0x${"42".repeat(32)}`);
const eve = privateKeyToAccount(`0x${"66".repeat(32)}`);
const SENDER = "0x1111111111111111111111111111111111111111";
const INSTITUTIONS = [{ name: "Guaranty Trust Bank", code: "GTBINGLA", type: "bank" }, { name: "Access Bank", code: "ABNGNGLA", type: "bank" }];

const balances = new Map<string, bigint>();
const refunds: [string, bigint][] = [];
const logs: string[] = [];
let sim: Server, payout: Server, svc: PayoutService, base: string;

before(async () => {
  setLogSink((l) => logs.push(l), "debug");
  // @ts-expect-error plain .mjs script
  const { startPaycrestSimulator } = await import("../../../scripts/paycrest-sim.mjs");
  const cfg = loadConfig({
    DIRECTORY_DOMAIN_ADDRESS: DOMAIN, EXPECTED_CHAIN_ID: String(CHAIN), PAYCREST_API_KEY: KEY, PAYCREST_API_SECRET: SECRET,
    PAYOUT_BANK_ENC_KEY: `0x${"ab".repeat(32)}`, PAYOUT_DB_PATH: ":memory:", PAYOUT_SOURCE_NETWORK: "sim-monad-testnet", PAYOUT_SOURCE_CURRENCY: "AUSD",
    PAYOUT_RATE_BUFFER_BPS: "100", PAYOUT_SIMULATED: "1", PORT: "0",
  });
  svc = new PayoutService(cfg);
  payout = createPayoutServer(svc);
  await new Promise<void>((r) => payout.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(payout.address() as AddressInfo).port}`;
  sim = startPaycrestSimulator({
    port: 0, apiKey: KEY, apiSecret: SECRET, webhookUrl: `${base}/v1/payout/webhooks/paycrest`, rate: "1500", institutions: INSTITUTIONS,
    feeUnits: 50_000n, stepMs: 150, balanceOf: async (a: string) => balances.get(a.toLowerCase()) ?? 0n,
    refund: async (to: string, u: bigint) => (refunds.push([to, u]), "0xrefund"),
  });
  await new Promise((r) => sim.once("listening", r));
  (svc as unknown as { provider: { base: string } }).provider.base = `http://127.0.0.1:${(sim.address() as AddressInfo).port}`;
});
after(() => {
  sim.close();
  payout.close();
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const big = (r: Record<string, any>): PayoutAccount => ({ ...r, deadline: BigInt(r.deadline) }) as PayoutAccount;

async function addBank(owner: typeof maris, accountNumber: string) {
  const prep = await call("POST", "/v1/payout/accounts/prepare", { account: owner.address, institution: "GTBINGLA", accountNumber });
  if (prep.status !== 200) return { prep };
  const record = big(prep.body.record);
  const sig = await owner.signTypedData(payoutAccountTyped(DOMAIN, record, CHAIN));
  const saved = await call("POST", "/v1/payout/accounts", { prepareId: prep.body.prepareId, record: prep.body.record, sig });
  return { prep, record, saved };
}
async function request(owner: typeof maris, record: PayoutAccount, kobo: bigint, id: string) {
  const r: PayoutRequest = {
    version: 1, requestId: `0x${id.repeat(32)}`, recipient: owner.address, currency: "NGN", fiatAmount: kobo,
    payoutAccountHash: payoutAccountHashOf(DOMAIN, record, CHAIN), expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  };
  const sig = await owner.signTypedData(payoutRequestTyped(DOMAIN, r, CHAIN));
  return { r, sig, res: await call("POST", "/v1/payout/requests", { request: JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), sig }) };
}
const waitFor = async (orderId: string, state: string) => {
  for (let i = 0; i < 60; i++) {
    const o = await call("GET", `/v1/payout/orders/${orderId}`);
    if (o.body.order?.state === state) return o.body.order;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`never reached ${state}`);
};

test("bank destination: verified name, signed by the owner, number never exposed", async () => {
  const banks = await call("GET", "/v1/payout/institutions?currency=NGN");
  assert.deepEqual(banks.body.institutions.map((b: { code: string }) => b.code), ["GTBINGLA", "ABNGNGLA"]);
  const { prep, saved } = await addBank(maris, "0123456789");
  assert.equal(prep.body.record.accountName, "TEST ACCOUNT 6789 (SIMULATED)");
  assert.equal(prep.body.record.last4, "6789");
  assert.equal(saved!.status, 201);
  const pub = await call("GET", `/v1/payout/accounts/${maris.address}`);
  assert.equal(pub.body.institutionName, "Guaranty Trust Bank");
  assert.ok(!JSON.stringify(pub.body).includes("0123456789"), "the public record never has the account number");
  assert.ok(!logs.join("\n").includes("0123456789"), "nor do the logs");
});

test("bank destination: someone else's signature, a changed record, unknown banks and bad numbers are refused", async () => {
  const prep = await call("POST", "/v1/payout/accounts/prepare", { account: maris.address, institution: "GTBINGLA", accountNumber: "0123456780" });
  const record = big(prep.body.record);
  const eveSig = await eve.signTypedData(payoutAccountTyped(DOMAIN, record, CHAIN));
  assert.equal((await call("POST", "/v1/payout/accounts", { prepareId: prep.body.prepareId, record: prep.body.record, sig: eveSig })).body.error, "InvalidSignature");
  const prep2 = await call("POST", "/v1/payout/accounts/prepare", { account: maris.address, institution: "GTBINGLA", accountNumber: "0123456780" });
  const forged = { ...prep2.body.record, accountName: "EVE" };
  const sig = await maris.signTypedData(payoutAccountTyped(DOMAIN, big(forged), CHAIN));
  assert.equal((await call("POST", "/v1/payout/accounts", { prepareId: prep2.body.prepareId, record: forged, sig })).body.error, "RECORD_MISMATCH");
  assert.equal((await call("POST", "/v1/payout/accounts/prepare", { account: maris.address, institution: "NOPE1234", accountNumber: "0123456789" })).body.error, "UNKNOWN_BANK");
  assert.equal((await call("POST", "/v1/payout/accounts/prepare", { account: maris.address, institution: "GTBINGLA", accountNumber: "12345" })).body.error, "INVALID_ACCOUNT_NUMBER");
  assert.equal((await call("POST", "/v1/payout/accounts/prepare", { account: maris.address, institution: "GTBINGLA", accountNumber: "0000000000" })).body.error, "ACCOUNT_NOT_FOUND");
  assert.equal((await call("POST", "/v1/payout/accounts/prepare", { account: maris.address, institution: "GTBINGLA", accountNumber: "1111111111" })).body.error, "ACCOUNT_NAME_UNAVAILABLE");
});

test("₦50,000 request → live quote → order → deposit → bank → DELIVERED (only on the provider's confirmation)", async () => {
  const { record } = await addBank(maris, "0123456789");
  const { res: created, r } = await request(maris, record!, 5_000_000n, "a1");
  assert.equal(created.status, 201);
  const q = await call("POST", "/v1/payout/quote", { requestId: r.requestId });
  assert.equal(q.body.rate, "1500");
  assert.equal(q.body.stableAmount, stableNeededFor(5_000_000n, "1500", 100).toString()); // at least ₦50,000 + 1% buffer
  const o1 = await call("POST", "/v1/payout/orders", { requestId: r.requestId, sender: SENDER });
  assert.equal(o1.status, 201);
  const order = o1.body.order;
  assert.equal(order.state, "AWAITING_PAYMENT");
  assert.equal(BigInt(order.amountToTransferUnits), BigInt(q.body.stableAmount) + 50_000n); // + the provider's fee
  // asking again returns the same live order (one per request)
  assert.equal((await call("POST", "/v1/payout/orders", { requestId: r.requestId, sender: SENDER })).body.order.orderId, order.orderId);
  // the sender pays: the deposit reaches the provider's address
  balances.set(order.receiveAddress.toLowerCase(), BigInt(order.amountToTransferUnits));
  await waitFor(order.orderId, "DELIVERED");
  const view = await call("GET", `/v1/payout/requests/${r.requestId}`);
  assert.equal(view.body.order.state, "DELIVERED");
  assert.equal(view.body.account.record.last4, "6789");
  assert.equal((await call("POST", "/v1/payout/orders", { requestId: r.requestId, sender: SENDER })).body.error, "REQUEST_ALREADY_PAID");
});

test("a failed bank payout is refunded to the sender's own address; never 'Delivered'", async () => {
  const { record } = await addBank(eve, "2222222222");
  const { r } = await request(eve, record!, 1_000_000n, "b2");
  const order = (await call("POST", "/v1/payout/orders", { requestId: r.requestId, sender: SENDER })).body.order;
  balances.set(order.receiveAddress.toLowerCase(), BigInt(order.amountToTransferUnits));
  await waitFor(order.orderId, "REFUNDED");
  assert.deepEqual(refunds.at(-1), [SENDER, BigInt(order.amountToTransferUnits)]);
});

test("requests: only the recipient may sign; bound to the exact signed destination; forged webhooks refused", async () => {
  const { record } = await addBank(maris, "0123456789");
  const r: PayoutRequest = {
    version: 1, requestId: `0x${"c3".repeat(32)}`, recipient: maris.address, currency: "NGN", fiatAmount: 2_000_000n,
    payoutAccountHash: payoutAccountHashOf(DOMAIN, record!, CHAIN), expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const wire = JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.equal((await call("POST", "/v1/payout/requests", { request: wire, sig: await eve.signTypedData(payoutRequestTyped(DOMAIN, r, CHAIN)) })).body.error, "InvalidSignature");
  const stale = { ...r, payoutAccountHash: `0x${"00".repeat(32)}` as const };
  const staleWire = { ...wire, payoutAccountHash: stale.payoutAccountHash };
  assert.equal((await call("POST", "/v1/payout/requests", { request: staleWire, sig: await maris.signTypedData(payoutRequestTyped(DOMAIN, stale, CHAIN)) })).body.error, "ACCOUNT_CHANGED");
  // webhooks need Paycrest's HMAC
  const body = JSON.stringify({ event: "payment_order.validated", data: { id: "x" } });
  const forged = await fetch(`${base}/v1/payout/webhooks/paycrest`, { method: "POST", headers: { "x-paycrest-signature": "00".repeat(32) }, body });
  assert.equal(forged.status, 401);
  const real = await fetch(`${base}/v1/payout/webhooks/paycrest`, { method: "POST", headers: { "x-paycrest-signature": createHmac("sha256", SECRET).update(body).digest("hex") }, body });
  assert.equal(real.status, 200);
});
