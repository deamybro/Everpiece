// Link-payment message v1 (src/voice.ts): round trip, binding to the payment, tamper and wrong-key failures,
// header checks the voice store relies on, and a fixed vector so the format can't drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import { bytesToHex, keccak256, type Hex } from "viem";
import {
  MAX_ENVELOPE_BYTES,
  MAX_VOICE_MS,
  MessageError,
  TAG_METADATA_V1,
  audioTypeOf,
  envelopeCommitment,
  messageLocator,
  messageSalt,
  metadataCommitment,
  openMessage,
  parseEnvelopeHeader,
  sealMessage,
} from "../src/index.ts";

const ROOT: Hex = `0x${"11".repeat(32)}`;
const OTHER: Hex = `0x${"22".repeat(32)}`;
const IV = new Uint8Array(12).fill(7);
const audio = new Uint8Array(5000).map((_, i) => i % 251);
const msg = { note: "For October ❤️", audio: { bytes: audio, type: "audio/webm" as const, durationMs: 4200 } };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof MessageError ? e.code : `other: ${String(e)}`;
  }
  return "no error";
};

test("round trip: note + voice, note only", async () => {
  const s = await sealMessage(ROOT, msg);
  const m = await openMessage(ROOT, s.envelope, s.commitment);
  assert.equal(m.note, msg.note);
  assert.deepEqual([...m.audio!.bytes], [...audio]);
  assert.equal(m.audio!.type, "audio/webm");
  assert.equal(m.audio!.durationMs, 4200);

  const t = await sealMessage(ROOT, { note: "hi" });
  assert.deepEqual(await openMessage(ROOT, t.envelope, t.commitment), { note: "hi" });
  assert.deepEqual(parseEnvelopeHeader(t.envelope), { version: 1, audioType: null, durationMs: 0 });
});

test("the commitment binds the exact envelope to the payment (ESCROW_SPEC §3.2 formula)", async () => {
  const s = await sealMessage(ROOT, msg, IV);
  assert.equal(s.envelopeHash, keccak256(s.envelope));
  assert.equal(s.commitment, metadataCommitment(s.envelopeHash, messageSalt(ROOT)));
  assert.equal(envelopeCommitment(ROOT, s.envelope), s.commitment);
  assert.ok(TAG_METADATA_V1);
  // a different, valid message for the same link is refused: it isn't the one the sender signed
  const other = await sealMessage(ROOT, { note: "swapped" });
  assert.equal(await code(openMessage(ROOT, other.envelope, s.commitment)), "MessageNotForThisPayment");
});

test("tampering: any changed byte fails, even with a recomputed commitment", async () => {
  const s = await sealMessage(ROOT, msg);
  for (const i of [1, 3, 8, 30, s.envelope.length - 1]) {
    const bad = new Uint8Array(s.envelope);
    bad[i] ^= 1;
    // the store can't make a matching commitment (it's on-chain), but check the AES-GCM layer on its own too
    const r = await code(openMessage(ROOT, bad, envelopeCommitment(ROOT, bad)));
    assert.ok(r === "MessageTampered" || r === "MessageMalformed", `byte ${i}: ${r}`);
    assert.equal(await code(openMessage(ROOT, bad, s.commitment)), r === "MessageMalformed" ? "MessageMalformed" : "MessageNotForThisPayment");
  }
});

test("wrong link secret can't open it, and the locator reveals nothing shared with the key", async () => {
  const s = await sealMessage(ROOT, msg);
  assert.equal(await code(openMessage(OTHER, s.envelope, envelopeCommitment(OTHER, s.envelope))), "MessageTampered");
  assert.notEqual(messageLocator(ROOT), messageLocator(OTHER));
  assert.notEqual(messageLocator(ROOT), messageSalt(ROOT));
  assert.equal(s.locator, messageLocator(ROOT));
});

test("limits: 30 s voice, 200-character note, envelope size, empty message", async () => {
  assert.equal(await code(sealMessage(ROOT, { note: "" })), "MessageMalformed");
  assert.equal(await code(sealMessage(ROOT, { note: "x".repeat(201) })), "MessageTooLarge");
  assert.equal(await code(sealMessage(ROOT, { note: "", audio: { ...msg.audio, durationMs: MAX_VOICE_MS + 1 } })), "MessageMalformed");
  assert.equal(await code(sealMessage(ROOT, { note: "", audio: { ...msg.audio, bytes: new Uint8Array(MAX_ENVELOPE_BYTES) } })), "MessageTooLarge");
  assert.equal(await code(sealMessage(ROOT, { note: "", audio: { ...msg.audio, type: "audio/wav" as never } })), "MessageMalformed");
  await sealMessage(ROOT, { note: "", audio: { ...msg.audio, durationMs: MAX_VOICE_MS } }); // exactly 30 s is fine
});

test("header checks the store can do without the key", async () => {
  const s = await sealMessage(ROOT, msg);
  assert.deepEqual(parseEnvelopeHeader(s.envelope), { version: 1, audioType: "audio/webm", durationMs: 4200 });
  const v2 = new Uint8Array(s.envelope);
  v2[0] = 2;
  assert.throws(() => parseEnvelopeHeader(v2), MessageError);
  const badType = new Uint8Array(s.envelope);
  badType[1] = 9;
  assert.throws(() => parseEnvelopeHeader(badType), MessageError);
  const long = new Uint8Array(s.envelope);
  new DataView(long.buffer).setUint32(2, MAX_VOICE_MS + 1);
  assert.throws(() => parseEnvelopeHeader(long), MessageError);
  assert.throws(() => parseEnvelopeHeader(new Uint8Array(20)), MessageError);
});

test("recorded formats map to the v1 audio types", () => {
  assert.equal(audioTypeOf("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(audioTypeOf("audio/mp4; codecs=mp4a.40.2"), "audio/mp4");
  assert.equal(audioTypeOf("audio/ogg;codecs=opus"), "audio/ogg");
  assert.equal(audioTypeOf("audio/wav"), null);
  assert.equal(audioTypeOf(""), null);
});

test("fixed vector (format v1), re-derived independently with node:crypto HKDF + AES-256-GCM", async () => {
  const s = await sealMessage(ROOT, { note: "hi", audio: { bytes: new Uint8Array([1, 2, 3]), type: "audio/mp4", durationMs: 1000 } }, IV);
  // Pinned: any format change must bump MESSAGE_VERSION and this vector.
  assert.equal(bytesToHex(s.envelope), "0x0102000003e8070707070707070707070707f26a693096d55fa4bb0a20bc4b018b9e0dc38ad76e6064");
  assert.equal(s.locator, "0x17298e2277022c4caf8662e2dec114e58b6e61f39a5fcd157c597d3724293b7b");
  assert.equal(s.commitment, "0x10ec9fcb33db326eb6dce7722547987c2789320ddbd151846557f49b129826c3");

  const root = Buffer.from(ROOT.slice(2), "hex");
  const hk = (info: string) => Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), info, 32));
  assert.equal(`0x${hk("everpiece.link.voice.v1.locator").toString("hex")}`, s.locator);
  const header = Buffer.from("0102000003e8", "hex");
  const c = createCipheriv("aes-256-gcm", hk("everpiece.link.voice.v1.key"), Buffer.from(IV));
  c.setAAD(header);
  const ct = Buffer.concat([c.update(Buffer.from([0, 2, 0x68, 0x69, 1, 2, 3])), c.final(), c.getAuthTag()]);
  assert.equal(`0x${Buffer.concat([header, Buffer.from(IV), ct]).toString("hex")}`, bytesToHex(s.envelope));
  const salt = `0x${hk("everpiece.link.voice.v1.metadata-salt").toString("hex")}` as Hex;
  assert.equal(metadataCommitment(keccak256(s.envelope), salt), s.commitment);
});
