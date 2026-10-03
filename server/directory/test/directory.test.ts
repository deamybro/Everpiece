// Offline: signature checks, username rules, first-come/immutable registration, self-authenticating inbox
// deliveries and inbox-key reads. The chain is replaced by an in-memory payment reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTypedDataAddress } from "viem";
import { PaymentMode, PaymentStatus, messageKeyRegistration, recipientCommitment, usernameRegistration } from "@everpiece/shared";
import { DirectoryService, DirectoryStore, createDirectoryServer, setLogSink, type DirectoryConfig, type OnchainPayment } from "../src/index.ts";

setLogSink(() => {});
const V = JSON.parse(readFileSync(new URL("../../../packages/shared/vectors.json", import.meta.url), "utf8"));
const D = V.directory;
const ESCROW = V.escrow as Address;
const NOW = (Number(D.deadline) - 300) * 1000;
const pk = (n: number) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}` as Hex);

const cfg: DirectoryConfig = {
  rpcUrl: "http://127.0.0.1:1", expectedChainId: 143, escrow: ESCROW, domainAddress: ESCROW, port: 0, host: "127.0.0.1", dbPath: ":memory:",
  requestDeadlineMaxSec: 600, perIpPerMinute: 1000, registrationsPerIpPerDay: 3, inboxPageSize: 100, allowedOrigin: "http://localhost:3000", maxBodyBytes: 4096,
};

function service(payments: Map<string, OnchainPayment> = new Map()) {
  return new DirectoryService(cfg, {
    store: new DirectoryStore(":memory:"),
    now: () => NOW,
    readPayment: async (id) => payments.get(id) ?? { status: PaymentStatus.NONE, mode: 0, recipientCommitment: `0x${"00".repeat(32)}` },
  });
}

async function reg(signer: ReturnType<typeof pk>, username: string, displayName = "Someone", account: Address = signer.address, inboxKeyHash: Hex = D.inboxKeyHash) {
  const deadline = BigInt(D.deadline);
  const sig = await signer.signTypedData(usernameRegistration(ESCROW, { username, account, displayName, inboxKeyHash, deadline }));
  return { username, account, displayName, inboxKeyHash, deadline: deadline.toString(), sig };
}

test("register: the published vector is accepted; lookups return what was signed", async () => {
  const s = service();
  const body = { username: D.username, account: D.account, displayName: D.displayName, inboxKeyHash: D.inboxKeyHash, deadline: D.deadline, sig: D.sig };
  const r = await s.register(body, "ip1");
  assert.equal(r.httpStatus, 201);
  const l = await s.lookup({ username: "mama" }, "ip1");
  assert.equal(l.httpStatus, 200);
  assert.equal(l.body.account, D.account);
  assert.equal(l.body.sig, D.sig);
  assert.equal((await s.byAccount({ account: D.account.toLowerCase() }, "ip1")).body.username, "mama");
  assert.equal((await s.lookup({ username: "nobody" }, "ip1")).httpStatus, 404);
  assert.equal((await s.register(body, "ip1")).body.idempotent, true);
});

test("register: first come, one name per account, immutable; only the account itself can sign", async () => {
  const s = service();
  assert.equal((await s.register(await reg(pk(2), "mama"), "ip")).httpStatus, 201);
  assert.equal((await s.register(await reg(pk(1), "mama"), "ip")).body.error, "UsernameTaken");
  assert.equal((await s.register(await reg(pk(2), "mama", "Changed"), "ip")).body.error, "UsernameTaken");
  assert.equal((await s.register(await reg(pk(2), "mama2"), "ip")).body.error, "AccountHasUsername");
  // lookalikes of a taken name belong to nobody else
  for (const [i, alike] of ["marna", "mama_", "m_a_m_a"].entries()) {
    assert.equal((await s.register(await reg(pk(30 + i), alike), "ip")).body.error, "UsernameTooSimilar", alike);
  }
  assert.deepEqual((await s.available({ username: "rnama" }, "ip")).body, { available: false, reason: "UsernameTooSimilar" });
  assert.deepEqual((await s.available({ username: "mama" }, "ip")).body, { available: false, reason: "UsernameTaken" });
  assert.deepEqual((await s.available({ username: "adm1n" }, "ip")).body, { available: false, reason: "UsernameReserved" });
  assert.deepEqual((await s.available({ username: "Mama" }, "ip")).body, { available: false, reason: "InvalidUsername" });
  assert.deepEqual((await s.available({ username: "papa" }, "ip")).body, { available: true });
  // pk(1) signs a registration that names pk(3)'s account → refused (can't pin a name on someone else's account)
  assert.equal((await s.register(await reg(pk(1), "victim", "Victim", pk(3).address), "ip")).body.error, "InvalidSignature");
});

test("register: simultaneous sign-ups for one name (or lookalikes) → exactly one wins", async () => {
  const s = service();
  const bodies = await Promise.all(["papa", "papa", "pa_pa", "papa", "p_apa"].map((n, i) => reg(pk(40 + i), n)));
  const out = await Promise.all(bodies.map((b, i) => s.register(b, `ip${i}`)));
  assert.equal(out.filter((r) => r.httpStatus === 201).length, 1);
  for (const r of out.filter((r) => r.httpStatus !== 201)) assert.match(String(r.body.error), /^Username(Taken|TooSimilar)$/);
  assert.equal((s.store.db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c, 1);
});

test("store: the database itself refuses a second holder, even if the service checks were skipped", () => {
  const st = new DirectoryStore(":memory:");
  const u = { username: "papa", skeleton: "papa", account: pk(1).address, display_name: "P", inbox_key_hash: "0x", deadline: "1", sig: "0x", created_at: 1 };
  st.insertUser(u);
  assert.throws(() => st.insertUser({ ...u, skeleton: "other", account: pk(2).address }), /UNIQUE constraint failed: users.username/);
  assert.throws(() => st.insertUser({ ...u, username: "pa_pa", account: pk(2).address }), /UNIQUE constraint failed: users.skeleton/);
  assert.throws(() => st.insertUser({ ...u, username: "mama", skeleton: "mama" }), /UNIQUE constraint failed: users.account/);
  assert.throws(() => st.insertUser({ ...u, username: "PAPA", skeleton: "PAPA", account: pk(3).address }), /CHECK constraint failed/);
});

test("register: invalid, reserved, non-canonical display name, stale/far deadline, per-IP daily cap", async () => {
  const s = service();
  assert.equal((await s.register(await reg(pk(1), "Mama"), "ip")).body.error, "InvalidUsername");
  assert.equal((await s.register(await reg(pk(1), "support"), "ip")).body.error, "UsernameReserved");
  assert.equal((await s.register(await reg(pk(1), "okname", " Padded "), "ip")).body.error, "InvalidDisplayName");
  assert.equal((await s.register(await reg(pk(1), "okname", "Evil‮eman"), "ip")).body.error, "InvalidDisplayName");
  const late = new DirectoryService(cfg, { store: new DirectoryStore(":memory:"), now: () => NOW + 400_000, readPayment: async () => { throw new Error("unused"); } });
  assert.equal((await late.register(await reg(pk(1), "okname"), "ip")).body.error, "BadDeadline");
  const early = new DirectoryService(cfg, { store: new DirectoryStore(":memory:"), now: () => NOW - 400_000, readPayment: async () => { throw new Error("unused"); } });
  assert.equal((await early.register(await reg(pk(1), "okname"), "ip")).body.error, "BadDeadline");
  for (const [i, n] of ["one", "two", "three"].entries()) assert.equal((await s.register(await reg(pk(10 + i), `user_${n}`), "ipX")).httpStatus, 201);
  assert.equal((await s.register(await reg(pk(20), "user_four"), "ipX")).body.error, "TooManyRegistrations");
  assert.equal((await s.register({ ...(await reg(pk(21), "extra")), extra: 1 }, "ip")).body.error, "InvalidRequest");
});

test("inbox: deliveries must open the on-chain USERNAME commitment; reads need the inbox key", async () => {
  const recipient = pk(2).address;
  const salt = `0x${"5a".repeat(32)}` as Hex;
  const pid = `0x${"01".repeat(32)}` as Hex;
  const linkPid = `0x${"02".repeat(32)}` as Hex;
  const claimedPid = `0x${"03".repeat(32)}` as Hex;
  const rc = recipientCommitment(PaymentMode.USERNAME, recipient, salt);
  const payments = new Map<string, OnchainPayment>([
    [pid, { status: PaymentStatus.ACTIVE, mode: PaymentMode.USERNAME, recipientCommitment: rc }],
    [linkPid, { status: PaymentStatus.ACTIVE, mode: PaymentMode.LINK, recipientCommitment: rc }],
    [claimedPid, { status: PaymentStatus.CLAIMED, mode: PaymentMode.USERNAME, recipientCommitment: rc }],
  ]);
  const s = service(payments);
  const deliver = (paymentId: Hex, r: Address = recipient, recipientSalt: Hex = salt) => s.deliver({ paymentId, recipient: r, recipientSalt }, "ip");

  assert.equal((await deliver(`0x${"09".repeat(32)}`)).body.error, "PaymentNotFinalized");
  assert.equal((await deliver(linkPid)).body.error, "NotAUsernamePayment");
  assert.equal((await deliver(claimedPid)).body.error, "PaymentNotActive");
  assert.equal((await deliver(pid, pk(1).address)).body.error, "RecipientMismatch");
  assert.equal((await deliver(pid, recipient, `0x${"5b".repeat(32)}`)).body.error, "RecipientMismatch");
  assert.equal((await deliver(pid)).httpStatus, 201);
  assert.equal((await deliver(pid)).body.idempotent, true);
  assert.equal((await deliver(pid, pk(1).address)).body.error, "AlreadyDelivered");

  // the recipient has no username yet → no inbox key on file → unauthorized, same as a wrong key
  assert.equal((await s.inbox({ account: recipient, inboxKey: D.inboxKey }, "ip")).httpStatus, 401);
  assert.equal((await s.register(await reg(pk(2), "mama"), "ip")).httpStatus, 201);
  assert.equal((await s.inbox({ account: recipient, inboxKey: `0x${"11".repeat(32)}` }, "ip")).httpStatus, 401);
  const ok = await s.inbox({ account: recipient, inboxKey: D.inboxKey }, "ip");
  assert.equal(ok.httpStatus, 200);
  assert.deepEqual(ok.body.items, [{ paymentId: pid, recipientSalt: salt, deliveredAt: NOW }]);
});

test("message keys: signed by the account, one per account, returned with lookups", async () => {
  const s = service();
  const mama = pk(2);
  const key = `0x${"4e".repeat(32)}` as Hex;
  const deadline = BigInt(D.deadline);
  const signed = async (signer: ReturnType<typeof pk>, messageKey: Hex, account: Address = signer.address) => ({
    account, messageKey, deadline: deadline.toString(),
    sig: await signer.signTypedData(messageKeyRegistration(ESCROW, { account, messageKey, deadline }, 143)),
  });
  // needs a username first; only the account itself can sign for it
  assert.equal((await s.registerMessageKey(await signed(mama, key), "ip")).body.error, "NoUsername");
  assert.equal((await s.register(await reg(mama, "mama"), "ip")).httpStatus, 201);
  assert.equal((await s.lookup({ username: "mama" }, "ip")).body.messageKey, null);
  assert.equal((await s.registerMessageKey(await signed(pk(3), key, mama.address), "ip")).body.error, "InvalidSignature");
  assert.equal((await s.registerMessageKey(await signed(mama, key), "ip")).httpStatus, 201);
  assert.equal((await s.registerMessageKey(await signed(mama, key), "ip")).body.idempotent, true);
  assert.equal((await s.registerMessageKey(await signed(mama, `0x${"4f".repeat(32)}`), "ip")).body.error, "MessageKeyExists");
  const looked = (await s.lookup({ username: "mama" }, "ip")).body.messageKey as { messageKey: Hex; deadline: string; sig: Hex };
  assert.equal(looked.messageKey, key);
  assert.deepEqual((await s.byAccount({ account: mama.address }, "ip")).body.messageKey, looked);
  // what a sender's client checks: the record recovers to the account
  const typed = messageKeyRegistration(ESCROW, { account: mama.address, messageKey: looked.messageKey, deadline: BigInt(looked.deadline) }, 143);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature: looked.sig }), mama.address);
  const stale = { ...(await signed(mama, key)), deadline: String(Number(D.deadline) + 10_000) };
  assert.equal((await s.registerMessageKey(stale, "ip")).body.error, "BadDeadline");
});

test("inbox: an optional message wrap travels with the delivery, opaque and exact-length", async () => {
  const recipient = pk(2).address;
  const salt = `0x${"5a".repeat(32)}` as Hex;
  const pid = `0x${"01".repeat(32)}` as Hex;
  const payments = new Map<string, OnchainPayment>([[pid, { status: PaymentStatus.ACTIVE, mode: PaymentMode.USERNAME, recipientCommitment: recipientCommitment(PaymentMode.USERNAME, recipient, salt) }]]);
  const s = service(payments);
  const wrap = `0x${"77".repeat(80)}` as Hex;
  assert.equal((await s.deliver({ paymentId: pid, recipient, recipientSalt: salt, messageWrap: "0x1234" }, "ip")).httpStatus, 400);
  assert.equal((await s.deliver({ paymentId: pid, recipient, recipientSalt: salt, messageWrap: wrap }, "ip")).httpStatus, 201);
  assert.equal((await s.deliver({ paymentId: pid, recipient, recipientSalt: salt, messageWrap: wrap }, "ip")).body.idempotent, true);
  assert.equal((await s.deliver({ paymentId: pid, recipient, recipientSalt: salt }, "ip")).body.error, "AlreadyDelivered");
  await s.register(await reg(pk(2), "mama"), "ip");
  assert.deepEqual((await s.inbox({ account: recipient, inboxKey: D.inboxKey }, "ip")).body.items, [{ paymentId: pid, recipientSalt: salt, deliveredAt: NOW, messageWrap: wrap }]);
});

test("store: an inbox table from before messages is migrated in place (existing entries keep working)", () => {
  const path = join(mkdtempSync(join(tmpdir(), "dir-")), "d.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE inbox (payment_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, recipient_salt TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO inbox VALUES ('0xold', '0xR', '0xS', 1);`);
  old.close();
  const st = new DirectoryStore(path);
  assert.deepEqual({ ...st.getInbox("0xold") }, { payment_id: "0xold", recipient: "0xR", recipient_salt: "0xS", created_at: 1, message_wrap: null });
  st.close();
});

test("http: routes, CORS origin, method and body checks", async () => {
  const srv = createDirectoryServer(service());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const post = (path: string, body: unknown, ct = "application/json") => fetch(base + path, { method: "POST", headers: { "content-type": ct }, body: JSON.stringify(body) });
    const r = await post("/v1/usernames/lookup", { username: "nobody" });
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base + "/v1/usernames/lookup")).status, 405);
    assert.equal((await post("/v1/usernames/lookup", { username: "x" }, "text/plain")).status, 415);
    assert.equal((await post("/v1/nope", {})).status, 404);
    assert.equal((await fetch(base + "/v1/usernames/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(5000) })).status, 413);
    assert.equal((await fetch(base + "/healthz")).status, 200);
  } finally {
    srv.close();
  }
});
