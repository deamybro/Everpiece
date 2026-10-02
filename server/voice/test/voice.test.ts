// Offline: the store accepts only well-formed ciphertext envelopes, first write wins, limits hold, old messages
// are deleted, and the HTTP layer serves opaque bytes. It never needs (or gets) a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { MAX_ENVELOPE_BYTES, NO_METADATA, PaymentStatus, messageSalt, openMessage, sealMessage } from "@everpiece/shared";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceService, VoiceStore, createVoiceServer, setLogSink, type OnchainPayment, type VoiceConfig } from "../src/index.ts";

setLogSink(() => {});
const ROOT: Hex = `0x${"ab".repeat(32)}`;
const cfg: VoiceConfig = {
  rpcUrl: "http://127.0.0.1:1", expectedChainId: 143, escrow: "0x00000000000000000000000000000000000000E5",
  port: 0, host: "127.0.0.1", dbPath: ":memory:", allowedOrigin: "http://localhost:3000",
  perIpPerMinute: 1000, uploadsPerIpPerDay: 3, maxTotalBytes: 1_000_000, unboundHours: 24, keepAfterExpiryDays: 15,
};
/** In-memory chain: paymentId → on-chain payment. */
const chain = new Map<string, OnchainPayment>();
let clock = Date.UTC(2026, 9, 2);
const service = (over: Partial<VoiceConfig> = {}, store = new VoiceStore(":memory:")) =>
  new VoiceService({ ...cfg, ...over }, {
    store, now: () => clock,
    readPayment: async (id) => chain.get(id) ?? { status: PaymentStatus.NONE, metadataCommitment: NO_METADATA, expiresAt: 0n },
  });
const sealed = (note = "For October ❤️", root = ROOT) =>
  sealMessage(root, { note, audio: { bytes: new Uint8Array(3000).fill(9), type: "audio/webm", durationMs: 2500 } });

test("store and read back the exact ciphertext; the recipient can open it", async () => {
  const s = service();
  const m = await sealed();
  assert.equal(s.put(m.locator, m.envelope, "ip1").httpStatus, 201);
  const r = s.get(m.locator, "ip2");
  assert.equal(r.httpStatus, 200);
  assert.deepEqual([...r.bytes!], [...m.envelope]);
  assert.equal((await openMessage(ROOT, r.bytes!, m.commitment)).note, "For October ❤️");
  assert.equal(s.get(`0x${"00".repeat(32)}`, "ip2").httpStatus, 404);
});

test("first write wins: a retry is fine, a different message can't replace it", async () => {
  const s = service();
  const m = await sealed();
  const other = await sealed("not what the sender said");
  assert.equal(s.put(m.locator, m.envelope, "ip1").httpStatus, 201);
  assert.equal(s.put(m.locator, m.envelope, "ip1").httpStatus, 200);
  assert.equal(s.put(m.locator, other.envelope, "ip9").body?.error, "MessageExists");
  assert.deepEqual([...s.get(m.locator, "ip1").bytes!], [...m.envelope]);
});

test("refuses what isn't a v1 envelope, bad locators and oversize uploads", async () => {
  const s = service();
  const m = await sealed();
  const v2 = new Uint8Array(m.envelope);
  v2[0] = 2;
  assert.equal(s.put(m.locator, v2, "ip1").httpStatus, 400);
  assert.equal(s.put(m.locator, new TextEncoder().encode("plain audio? no"), "ip1").httpStatus, 400);
  assert.equal(s.put("0x1234", m.envelope, "ip1").body?.error, "BadLocator");
  assert.equal(s.put(m.locator, new Uint8Array(MAX_ENVELOPE_BYTES + 1), "ip1").httpStatus, 413);
});

test("abuse controls: uploads per IP per day, total storage, per-minute rate", async () => {
  const s = service();
  for (let i = 0; i < 3; i++) {
    const m = await sealed(`n${i}`, `0x${String(i).padStart(64, "0")}`);
    assert.equal(s.put(m.locator, m.envelope, "ip1").httpStatus, 201);
  }
  const fourth = await sealed("n3", `0x${"3".padStart(64, "0")}`);
  assert.equal(s.put(fourth.locator, fourth.envelope, "ip1").body?.error, "DailyLimit");
  assert.equal(s.put(fourth.locator, fourth.envelope, "ip2").httpStatus, 201);

  const tiny = service({ maxTotalBytes: 4000 });
  const a = await sealed("a", `0x${"a".padStart(64, "0")}`);
  const b = await sealed("b", `0x${"b".padStart(64, "0")}`);
  assert.equal(tiny.put(a.locator, a.envelope, "ip1").httpStatus, 201);
  assert.equal(tiny.put(b.locator, b.envelope, "ip1").body?.error, "StorageFull");

  const slow = service({ perIpPerMinute: 2 });
  slow.get(a.locator, "ip1");
  slow.get(a.locator, "ip1");
  assert.equal(slow.get(a.locator, "ip1").body?.error, "RateLimited");
});

test("lifecycle: an upload no payment claims is gone after 24 h", async () => {
  const s = service();
  const m = await sealed();
  s.put(m.locator, m.envelope, "ip1");
  clock += 23 * 3_600_000;
  assert.equal(s.sweep(), 0);
  clock += 2 * 3_600_000;
  assert.equal(s.sweep(), 1);
  assert.equal(s.get(m.locator, "ip1").httpStatus, 404);
});

test("bind: the store checks the on-chain commitment itself, then keeps the message until 15 days after expiry", async () => {
  const s = service();
  const m = await sealed();
  const salt = messageSalt(ROOT);
  const pid = `0x${"c1".repeat(32)}`;
  s.put(m.locator, m.envelope, "ip1");
  const bind = (body: Record<string, unknown>, locator = m.locator) => s.bind(locator, body, "ip1");

  assert.equal((await bind({ paymentId: pid, metadataSalt: salt })).body?.error, "PaymentNotFinalized");
  const expiresAt = BigInt(Math.floor(clock / 1000) + 30 * 86_400);
  chain.set(pid, { status: PaymentStatus.ACTIVE, metadataCommitment: m.commitment, expiresAt });
  assert.equal((await bind({ paymentId: pid, metadataSalt: `0x${"00".repeat(32)}` })).body?.error, "NotThisPaymentsMessage");
  const other = `0x${"c2".repeat(32)}`;
  chain.set(other, { status: PaymentStatus.ACTIVE, metadataCommitment: `0x${"ee".repeat(32)}`, expiresAt });
  assert.equal((await bind({ paymentId: other, metadataSalt: salt })).body?.error, "NotThisPaymentsMessage");
  assert.equal((await bind({ paymentId: pid })).body?.error, "InvalidRequest");
  assert.equal((await bind({ paymentId: pid, metadataSalt: salt }, `0x${"00".repeat(32)}`)).body?.error, "NotFound");

  assert.equal((await bind({ paymentId: pid, metadataSalt: salt })).httpStatus, 200);
  assert.equal((await bind({ paymentId: pid.toUpperCase().replace("0X", "0x"), metadataSalt: salt })).body?.idempotent, true); // sender and recipient both bind
  assert.equal((await bind({ paymentId: other, metadataSalt: salt })).body?.error, "BoundToAnotherPayment");
  assert.deepEqual({ ...s.health() }, { ok: true, messages: 1, bound: 1, bytes: m.envelope.length });

  clock += 44 * 86_400_000; // past expiry + 14 days: still kept
  assert.equal(s.sweep(), 0);
  clock += 2 * 86_400_000;
  assert.equal(s.sweep(), 1);
});

test("bind: an RPC failure is a retryable 503, never a deletion", async () => {
  const m = await sealed();
  const s = new VoiceService(cfg, { store: new VoiceStore(":memory:"), now: () => clock, readPayment: async () => { throw new Error("429"); } });
  s.put(m.locator, m.envelope, "ip1");
  assert.equal((await s.bind(m.locator, { paymentId: `0x${"c1".repeat(32)}`, metadataSalt: messageSalt(ROOT) }, "ip1")).httpStatus, 503);
  assert.equal(s.get(m.locator, "ip1").httpStatus, 200);
});

test("store: a table from before binding is migrated in place and keeps the old 45-day lifetime", () => {
  const path = join(mkdtempSync(join(tmpdir(), "voice-")), "v.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE messages (locator TEXT PRIMARY KEY, envelope BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO messages VALUES ('0xold', x'01', 1, 1000);`);
  old.close();
  const st = new VoiceStore(path);
  const row = st.get("0xold")!;
  assert.equal(row.payment_id, null);
  assert.equal(row.delete_after, 1000 + 45 * 86_400_000);
  st.close();
});

test("HTTP: PUT/GET bytes, CORS for the web origin, content-type checks", async () => {
  const s = service();
  const server = createVoiceServer(s).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const m = await sealed();
    const url = `${base}/v1/messages/${m.locator}`;
    const pre = await fetch(url, { method: "OPTIONS" });
    assert.equal(pre.headers.get("access-control-allow-methods"), "GET, PUT, POST");
    assert.equal((await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 415);
    const put = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(m.envelope) as Uint8Array<ArrayBuffer> });
    assert.equal(put.status, 201);
    assert.equal(put.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const got = await fetch(url);
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
    assert.equal(got.headers.get("cache-control"), "no-store");
    assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [...m.envelope]);
    assert.equal((await fetch(`${base}/v1/messages/nope`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    server.close();
  }
});
