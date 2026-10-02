// Username-payment message keys (src/messageKey.ts). The HPKE library is checked against RFC 9180's own published
// vector (Appendix A.1.1, copied from https://www.rfc-editor.org/rfc/rfc9180.txt), then our wrap: round trip,
// bound to the payment and to the recipient, and the account-signed key registration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Aes128Gcm, CipherSuite } from "@hpke/core";
import { DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/dhkem-x25519";
import {
  MESSAGE_WRAP_BYTES,
  deriveEverpieceInboxKeyV1,
  deriveEverpieceMessageSeedV1,
  messageKeyRegistration,
  messagePublicKey,
  openMessage,
  sealMessage,
  unwrapMessageSecret,
  wrapMessageSecret,
  messageLocator,
} from "../src/index.ts";

const h = (s: string) => hexToBytes(`0x${s.replace(/\s+/g, "")}`);
const A11 = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  ikmE: "7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234",
  pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  ikmR: "6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037",
  pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  aad0: "436f756e742d30",
  ct0: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
};

test("RFC 9180 A.1.1 (DHKEM X25519, HKDF-SHA256, AES-128-GCM, base mode) through the pinned library", async () => {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const r = await suite.kem.deriveKeyPair(h(A11.ikmR));
  assert.equal(bytesToHex(new Uint8Array(await suite.kem.serializePublicKey(r.publicKey))), `0x${A11.pkRm}`);
  assert.equal(bytesToHex(new Uint8Array(await suite.kem.serializePrivateKey(r.privateKey))), `0x${A11.skRm}`);
  const e = await suite.kem.deriveKeyPair(h(A11.ikmE));
  const sender = await suite.createSenderContext({ recipientPublicKey: r.publicKey, info: h(A11.info), ekm: e });
  assert.equal(bytesToHex(new Uint8Array(sender.enc)), `0x${A11.pkEm}`);
  assert.equal(bytesToHex(new Uint8Array(await sender.seal(h(A11.pt), h(A11.aad0)))), `0x${A11.ct0}`);
  const opened = await suite.open({ recipientKey: r, enc: h(A11.pkEm), info: h(A11.info) }, h(A11.ct0), h(A11.aad0));
  assert.equal(bytesToHex(new Uint8Array(opened)), `0x${A11.pt}`);
});

const PRF = new Uint8Array(32).fill(5);
const PAYMENT: Hex = `0x${"12".repeat(32)}`;
const OTHER_PAYMENT: Hex = `0x${"34".repeat(32)}`;

test("message key: own domain (≠ inbox key), deterministic, 32-byte public key", async () => {
  const seed = bytesToHex(deriveEverpieceMessageSeedV1(PRF));
  assert.notEqual(seed, bytesToHex(deriveEverpieceInboxKeyV1(PRF)));
  assert.equal(seed, bytesToHex(deriveEverpieceMessageSeedV1(PRF)));
  const pub = await messagePublicKey(seed);
  assert.match(pub, /^0x[0-9a-f]{64}$/);
  assert.equal(pub, await messagePublicKey(seed));
  assert.throws(() => deriveEverpieceMessageSeedV1(new Uint8Array(31)));
});

test("wrap: only the recipient opens it, only for this payment; end to end with a sealed message", async () => {
  const seed = bytesToHex(deriveEverpieceMessageSeedV1(PRF));
  const otherSeed = bytesToHex(deriveEverpieceMessageSeedV1(new Uint8Array(32).fill(6)));
  const pub = await messagePublicKey(seed);
  const secret: Hex = `0x${"9a".repeat(32)}`;
  const wrap = await wrapMessageSecret(pub, PAYMENT, secret);
  assert.equal(hexToBytes(wrap).length, MESSAGE_WRAP_BYTES);
  assert.notEqual(wrap, await wrapMessageSecret(pub, PAYMENT, secret)); // fresh ephemeral key each time
  assert.equal(await unwrapMessageSecret(seed, PAYMENT, wrap), secret);
  await assert.rejects(unwrapMessageSecret(otherSeed, PAYMENT, wrap));
  await assert.rejects(unwrapMessageSecret(seed, OTHER_PAYMENT, wrap));
  const bad = hexToBytes(wrap);
  bad[50] ^= 1;
  await assert.rejects(unwrapMessageSecret(seed, PAYMENT, bytesToHex(bad)));
  await assert.rejects(unwrapMessageSecret(seed, PAYMENT, "0x1234"));

  const sealed = await sealMessage(secret, { note: "Happy birthday" });
  const opened = await unwrapMessageSecret(seed, PAYMENT, wrap);
  assert.equal(messageLocator(opened), sealed.locator);
  assert.equal((await openMessage(opened, sealed.envelope, sealed.commitment)).note, "Happy birthday");
});

test("low-order X25519 public keys are refused (RFC 9180 §7.1.4 all-zero shared secret check)", async () => {
  const secret: Hex = `0x${"9a".repeat(32)}`;
  for (const k of [`0x${"00".repeat(32)}`, `0x01${"00".repeat(31)}`, "0xe0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"] as Hex[]) {
    await assert.rejects(wrapMessageSecret(k, PAYMENT, secret));
  }
});

test("MessageKeyRegistration is signed by the account (directory can't substitute a key)", async () => {
  const signer = privateKeyToAccount(`0x${"01".padStart(64, "0")}`);
  const escrow = "0x00000000000000000000000000000000000000E5" as const;
  const m = { account: signer.address, messageKey: await messagePublicKey(bytesToHex(deriveEverpieceMessageSeedV1(PRF))), deadline: 1_800_000_000n };
  const sig = await signer.signTypedData(messageKeyRegistration(escrow, m, 10143));
  assert.equal(await recoverTypedDataAddress({ ...messageKeyRegistration(escrow, m, 10143), signature: sig }), signer.address);
  const swapped = { ...m, messageKey: `0x${"ff".repeat(32)}` as Hex };
  assert.notEqual(await recoverTypedDataAddress({ ...messageKeyRegistration(escrow, swapped, 10143), signature: sig }), signer.address);
});
