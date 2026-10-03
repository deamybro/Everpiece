// Payment requests in the directory: only the recipient's own signature creates one, and "paid" needs an on-chain
// proof that the directory recomputes itself (instant: EverpiecePay id + settled; protected: escrow id + commitment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUSD_ADDRESS, PaymentMode, PaymentStatus, RequestMode, instantPaymentId, paymentIdOf, paymentRequestTyped, recipientCommitment, usernameRegistration,
  type PaymentRequest,
} from "@everpiece/shared";
import { DirectoryService, DirectoryStore, setLogSink, type DirectoryConfig, type OnchainPayment } from "../src/index.ts";

setLogSink(() => {});
const V = JSON.parse(readFileSync(new URL("../../../packages/shared/vectors.json", import.meta.url), "utf8"));
const D = V.directory;
const ESCROW = V.escrow as Address;
const PAY = "0x2222222222222222222222222222222222222222" as Address;
const NOW = (Number(D.deadline) - 300) * 1000;
const pk = (n: number) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}` as Hex);
const maris = pk(2);

const cfg: DirectoryConfig = {
  rpcUrl: "http://127.0.0.1:1", expectedChainId: 143, escrow: ESCROW, domainAddress: ESCROW, payAddress: PAY, port: 0, host: "127.0.0.1", dbPath: ":memory:",
  requestDeadlineMaxSec: 600, perIpPerMinute: 1000, registrationsPerIpPerDay: 10, inboxPageSize: 100, allowedOrigin: "http://localhost:3000", maxBodyBytes: 4096,
};

function setup(chain: { settled?: Set<string>; payments?: Map<string, OnchainPayment> } = {}) {
  const s = new DirectoryService(cfg, {
    store: new DirectoryStore(":memory:"),
    now: () => NOW,
    readSettled: async (id) => chain.settled?.has(id) ?? false,
    readPayment: async (id) => chain.payments?.get(id) ?? { status: PaymentStatus.NONE, mode: 0, recipientCommitment: `0x${"00".repeat(32)}` },
  });
  return s;
}
async function registerMaris(s: DirectoryService) {
  const deadline = BigInt(D.deadline);
  const sig = await maris.signTypedData(usernameRegistration(ESCROW, { username: "maris", account: maris.address, displayName: "Maris", inboxKeyHash: D.inboxKeyHash, deadline }));
  assert.equal((await s.register({ username: "maris", account: maris.address, displayName: "Maris", inboxKeyHash: D.inboxKeyHash, deadline: deadline.toString(), sig }, "ip")).httpStatus, 201);
}
const req = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  version: 1, requestId: `0x${"ab".repeat(32)}`, recipient: maris.address, asset: AUSD_ADDRESS, amount: 25_000_000n, mode: RequestMode.INSTANT,
  expiresAt: BigInt(NOW / 1000 + 3600), memoHash: `0x${"00".repeat(32)}`, ...over,
});
const wire = (r: PaymentRequest) => ({ ...r, amount: r.amount.toString(), expiresAt: r.expiresAt.toString() });
const signed = async (r: PaymentRequest, signer = maris) => ({ request: wire(r), sig: await signer.signTypedData(paymentRequestTyped(ESCROW, r, 143)) });

test("create: signed by the recipient, who has a username; tampering and wrong assets refused; idempotent", async () => {
  const s = setup();
  assert.equal((await s.createRequest(await signed(req()), "ip")).body.error, "NoUsername");
  await registerMaris(s);
  const ok = await signed(req());
  const r = await s.createRequest(ok, "ip");
  assert.equal(r.httpStatus, 201);
  assert.equal((r.body.recipientRecord as { username: string }).username, "maris");
  assert.equal((await s.createRequest(ok, "ip")).body.idempotent, true);
  // "Pay Maris 25" re-signed by someone else, or edited to 250 after signing
  assert.equal((await s.createRequest({ ...(await signed(req({ requestId: `0x${"cd".repeat(32)}` }), pk(9))) }, "ip")).body.error, "InvalidSignature");
  const tampered = await signed(req({ requestId: `0x${"ef".repeat(32)}` }));
  tampered.request.amount = "250000000";
  assert.equal((await s.createRequest(tampered, "ip")).body.error, "InvalidSignature");
  assert.equal((await s.createRequest(await signed(req({ requestId: `0x${"01".repeat(32)}`, asset: pk(5).address })), "ip")).body.error, "UNSUPPORTED_NETWORK");
  assert.equal((await s.createRequest(await signed(req({ requestId: `0x${"02".repeat(32)}`, expiresAt: BigInt(NOW / 1000) })), "ip")).body.error, "REQUEST_EXPIRED");
  assert.equal((await s.createRequest(await signed(req({ requestId: `0x${"03".repeat(32)}`, amount: 0n })), "ip")).body.error, "INVALID_AMOUNT");
  assert.equal((await s.createRequest({ request: { ...wire(req()), version: 2 }, sig: ok.sig }, "ip")).httpStatus, 400);
  assert.equal((await s.getRequest({ requestId: req().requestId }, "ip")).httpStatus, 200);
  assert.equal((await s.getRequest({ requestId: `0x${"99".repeat(32)}` }, "ip")).body.error, "UnknownRequest");
});

test("paid (instant): only an EverpiecePay payment with this ref, recipient and amount that settled on-chain", async () => {
  const settled = new Set<string>();
  const s = setup({ settled });
  await registerMaris(s);
  await s.createRequest(await signed(req()), "ip");
  const payment = { ref: req().requestId, sender: pk(1).address, recipient: maris.address, amount: 25_000_000n, sourceToken: AUSD_ADDRESS, maxSourceAmount: 25_000_000n, deadline: 1_900_000_000n };
  const w = (p: typeof payment) => ({ ...p, amount: p.amount.toString(), maxSourceAmount: p.maxSourceAmount.toString(), deadline: p.deadline.toString() });
  const id = instantPaymentId(PAY, payment, 143);
  const proof = { requestId: req().requestId, kind: "instant", payment: w(payment) };
  assert.equal((await s.requestPaid(proof, "ip")).body.error, "PaymentNotFinalized");
  assert.equal((await s.requestPaid({ ...proof, payment: w({ ...payment, amount: 2_500_000n }) }, "ip")).body.error, "NotThisRequest");
  assert.equal((await s.requestPaid({ ...proof, payment: w({ ...payment, recipient: pk(9).address }) }, "ip")).body.error, "NotThisRequest");
  assert.equal((await s.requestPaid({ ...proof, payment: w({ ...payment, ref: `0x${"77".repeat(32)}` }) }, "ip")).body.error, "NotThisRequest");
  settled.add(id);
  const done = await s.requestPaid(proof, "ip");
  assert.deepEqual(done.body.paid, { paymentId: id, kind: "instant", at: NOW });
  assert.equal((await s.requestPaid(proof, "ip")).body.idempotent, true);
  assert.equal((await s.requestPaid({ requestId: req().requestId, kind: "protected", intent: {}, recipientSalt: "0x" }, "ip")).httpStatus, 200); // already paid: idempotent answer, nothing changes
});

test("paid (protected): an escrow payment whose salt is the request id and whose commitment opens to the recipient", async () => {
  const payments = new Map<string, OnchainPayment>();
  const s = setup({ payments });
  await registerMaris(s);
  const r = req({ requestId: `0x${"5e".repeat(32)}`, mode: RequestMode.PROTECTED });
  await s.createRequest(await signed(r), "ip");
  const rsalt = `0x${"44".repeat(32)}` as Hex;
  const intent = {
    sender: pk(1).address, mode: PaymentMode.USERNAME, recipientCommitment: recipientCommitment(PaymentMode.USERNAME, maris.address, rsalt), metadataCommitment: `0x${"00".repeat(32)}` as Hex,
    approver: "0x0000000000000000000000000000000000000000" as Address, amount: 25_000_000n, expiresAt: 1_900_000_000n, validAfter: 0n, validBefore: 1_890_000_000n, salt: r.requestId,
  };
  const w = (i: typeof intent) => ({ ...i, amount: i.amount.toString(), expiresAt: i.expiresAt.toString(), validAfter: i.validAfter.toString(), validBefore: i.validBefore.toString() });
  const proof = { requestId: r.requestId, kind: "protected", intent: w(intent), recipientSalt: rsalt };
  assert.equal((await s.requestPaid(proof, "ip")).body.error, "PaymentNotFinalized");
  payments.set(paymentIdOf(ESCROW, intent, 143), { status: PaymentStatus.ACTIVE, mode: PaymentMode.USERNAME, recipientCommitment: intent.recipientCommitment });
  assert.equal((await s.requestPaid({ ...proof, recipientSalt: `0x${"45".repeat(32)}` }, "ip")).body.error, "NotThisRequest");
  assert.equal((await s.requestPaid({ ...proof, intent: w({ ...intent, salt: `0x${"46".repeat(32)}` }) }, "ip")).body.error, "NotThisRequest");
  assert.equal((await s.requestPaid({ ...proof, kind: "instant", payment: {} }, "ip")).httpStatus, 400);
  assert.equal((await s.requestPaid(proof, "ip")).httpStatus, 200);
  assert.equal(((await s.getRequest({ requestId: r.requestId }, "ip")).body.paid as { kind: string }).kind, "protected");
});
