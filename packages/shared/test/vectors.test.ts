// Independent TypeScript (viem) re-derivation of every shared vector. A 4th implementation next to cast,
// Solidity (forge) and the live contract. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  domainSeparator,
  getAddress,
  hashStruct,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUSD_ADDRESS,
  PaymentMode,
  TAG_METADATA_V1,
  TAG_RECIPIENT_V1,
  ausdDomain,
  cancelIntent,
  claimApproval,
  claimIntent,
  deriveEverpieceAccountV1,
  escrowDomain,
  escrowTypes,
  fundingAuthorization,
  linkClaimIntent,
  metadataCommitment,
  paymentIdOf,
  recipientCommitment,
  type PaymentIntent,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(new URL("../vectors.json", import.meta.url), "utf8"));
const ESCROW = V.escrow as Address;
const C = V.common;
const key = (n: string) => privateKeyToAccount(V.keys[n].privateKey as Hex);
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

const usernameIntent = (): PaymentIntent => ({
  sender: V.keys.sender.address,
  mode: PaymentMode.USERNAME,
  recipientCommitment: V.username.recipientCommitment,
  metadataCommitment: V.metadata.metadataCommitment,
  approver: "0x0000000000000000000000000000000000000000",
  amount: BigInt(C.amount),
  expiresAt: BigInt(C.expiresAt),
  validAfter: BigInt(C.validAfter),
  validBefore: BigInt(C.validBefore),
  salt: V.username.salt,
});

const linkIntent = (): PaymentIntent => ({
  ...usernameIntent(),
  mode: PaymentMode.LINK,
  recipientCommitment: V.link.recipientCommitment,
  approver: V.keys.approver.address,
  salt: V.link.salt,
});

test("keys and addresses", () => {
  for (const n of ["sender", "recipient", "approver", "claimKey", "approver2"]) {
    assert.equal(key(n).address, getAddress(V.keys[n].address));
  }
  assert.equal(AUSD_ADDRESS, V.ausd);
});

test("constants: tags, typehash-bearing domain separators", () => {
  assert.equal(TAG_RECIPIENT_V1, V.constants.TAG_RECIPIENT_V1);
  assert.equal(TAG_METADATA_V1, V.constants.TAG_METADATA_V1);
  assert.equal(domainSeparator({ domain: escrowDomain(ESCROW, V.chainId) }), V.constants.ESCROW_DOMAIN_SEPARATOR);
  assert.equal(domainSeparator({ domain: ausdDomain(V.chainId) }), V.constants.AUSD_DOMAIN_SEPARATOR);
});

test("metadata commitment", () => {
  assert.equal(keccak256(stringToHex(V.metadata.envelopeUtf8)), V.metadata.envelopeHash);
  assert.equal(metadataCommitment(V.metadata.envelopeHash, V.metadata.metadataSalt), V.metadata.metadataCommitment);
});

test("username: commitment, paymentId, funding, claim, cancel", async () => {
  assert.equal(recipientCommitment(PaymentMode.USERNAME, V.keys.recipient.address, V.username.recipientSalt), V.username.recipientCommitment);
  const i = usernameIntent();
  assert.equal(hashStruct({ data: i, primaryType: "PaymentIntent", types: escrowTypes }), V.username.paymentIntentStructHash);
  assert.equal(paymentIdOf(ESCROW, i), V.username.paymentId);

  const funding = fundingAuthorization(ESCROW, i);
  assert.equal(hashTypedData(funding), V.username.fundingDigest);
  assert.equal(await key("sender").signTypedData(funding), V.username.fundingSig); // RFC 6979: byte-identical
  assert.equal(await recoverTypedDataAddress({ ...funding, signature: V.username.fundingSig }), key("sender").address);

  const claim = claimIntent(ESCROW, { paymentId: V.username.paymentId, recipient: V.keys.recipient.address, actionNonce: C.claimNonce, deadline: BigInt(C.deadline) });
  assert.equal(hashTypedData(claim), V.username.claimDigest);
  assert.equal(await key("recipient").signTypedData(claim), V.username.claimSig);

  const selfClaim = claimIntent(ESCROW, { paymentId: V.username.paymentId, recipient: V.keys.sender.address, actionNonce: C.claimNonce, deadline: BigInt(C.deadline) });
  assert.equal(hashTypedData(selfClaim), V.username.senderSelfClaimDigest);
  assert.equal(await key("sender").signTypedData(selfClaim), V.username.senderSelfClaimSig);
  // the sender cannot open the recipient's commitment
  assert.notEqual(recipientCommitment(PaymentMode.USERNAME, V.keys.sender.address, V.username.recipientSalt), V.username.recipientCommitment);

  const cancel = cancelIntent(ESCROW, { paymentId: V.username.paymentId, sender: V.keys.sender.address, actionNonce: C.cancelNonce, deadline: BigInt(C.deadline) });
  assert.equal(hashTypedData(cancel), V.username.cancelDigest);
  assert.equal(await key("sender").signTypedData(cancel), V.username.cancelSig);
});

test("negative: every change yields a different paymentId and invalidates the funding signature", async () => {
  const n = V.negative;
  const cases: [string, PaymentIntent, number?, Address?, string?][] = [
    [n.amountPlus1_paymentId, { ...usernameIntent(), amount: BigInt(C.amount) + 1n }],
    [n.expiresAtPlus1_paymentId, { ...usernameIntent(), expiresAt: BigInt(C.expiresAt) + 1n }],
    [n.recipientE7E0_paymentId, { ...usernameIntent(), recipientCommitment: recipientCommitment(1, "0x000000000000000000000000000000000000E7E0", V.username.recipientSalt) }],
    [n.metadataZero_paymentId, { ...usernameIntent(), metadataCommitment: "0x0000000000000000000000000000000000000000000000000000000000000000" }],
    [n.modeLink_paymentId, { ...usernameIntent(), mode: PaymentMode.LINK }],
    [n.saltPlus1_paymentId, { ...usernameIntent(), salt: "0x000000000000000000000000000000000000000000000000000000000000a11d" }],
    [n.approverSet_paymentId, { ...usernameIntent(), approver: V.keys.approver.address }],
    [n.chain10143_paymentId, usernameIntent(), 10143],
    [n.escrow2222_paymentId, usernameIntent(), 143, "0x2222222222222222222222222222222222222222"],
  ];
  for (const [expected, intent, chainId = 143, escrow = ESCROW] of cases) {
    assert.equal(paymentIdOf(escrow, intent, chainId), expected);
    const tampered = fundingAuthorization(escrow, intent, chainId);
    const recovered = await recoverTypedDataAddress({ ...tampered, signature: V.username.fundingSig });
    assert.notEqual(recovered, key("sender").address);
  }
  const v2 = hashTypedData({ domain: { ...escrowDomain(ESCROW), version: "2" }, types: escrowTypes, primaryType: "PaymentIntent", message: usernameIntent() });
  assert.equal(v2, n.domainVersion2_paymentId);
});

test("link: commitment, paymentId, both factors, role separation, redirect", async () => {
  assert.equal(recipientCommitment(PaymentMode.LINK, V.keys.claimKey.address, V.link.recipientSalt), V.link.recipientCommitment);
  const i = linkIntent();
  assert.equal(hashStruct({ data: i, primaryType: "PaymentIntent", types: escrowTypes }), V.link.paymentIntentStructHash);
  assert.equal(paymentIdOf(ESCROW, i), V.link.paymentId);
  const funding = fundingAuthorization(ESCROW, i);
  assert.equal(hashTypedData(funding), V.link.fundingDigest);
  assert.equal(await key("sender").signTypedData(funding), V.link.fundingSig);

  const base = { paymentId: V.link.paymentId as Hex, recipient: V.keys.recipient.address as Address, deadline: BigInt(C.deadline) };
  const lc = linkClaimIntent(ESCROW, { ...base, actionNonce: C.claimNonce });
  const ap = claimApproval(ESCROW, { ...base, approvalNonce: C.approvalNonce });
  assert.equal(hashTypedData(lc), V.link.linkClaimDigest);
  assert.equal(hashTypedData(ap), V.link.approvalDigest);
  assert.equal(await key("claimKey").signTypedData(lc), V.link.claimKeySig);
  assert.equal(await key("approver").signTypedData(ap), V.link.approverSig);

  // role separation: each signature is useless for the other type
  assert.notEqual(await recoverTypedDataAddress({ ...lc, signature: V.link.approverSig }), key("approver").address);
  assert.notEqual(await recoverTypedDataAddress({ ...ap, signature: V.link.claimKeySig }), key("claimKey").address);
  // redirect: Mama's approval is not an approval for Stella
  const stella = claimApproval(ESCROW, { ...base, recipient: V.keys.stella.address, approvalNonce: C.approvalNonce });
  assert.equal(hashTypedData(stella), V.link.approvalForStellaDigest);
  assert.notEqual(await recoverTypedDataAddress({ ...stella, signature: V.link.approverSig }), key("approver").address);
  // rotation: approver2 cannot stand in for the snapshotted approver
  const sig2 = await key("approver2").signTypedData(ap);
  assert.notEqual(await recoverTypedDataAddress({ ...ap, signature: sig2 }), key("approver").address);
});

test("EVERPIECE_ACCOUNT_V1 derivation (synthetic PRF fixtures)", () => {
  for (const d of V.accountDerivationV1) {
    const { privateKey, address } = deriveEverpieceAccountV1(hexToBytes(d.prfOutput));
    assert.equal(address, getAddress(d.address));
    privateKey.fill(0);
  }
  assert.throws(() => deriveEverpieceAccountV1(new Uint8Array(31)));
});
